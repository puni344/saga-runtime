const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { SagaEngine } = require('../src/saga');
const { PaymentRailSimulator } = require('../src/rail');
const { Store } = require('../src/store');

const TEST_DIR = path.join(os.tmpdir(), 'saga-payment-domain-' + crypto.randomBytes(6).toString('hex'));

function tmpStore(name) {
  if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
  return path.join(TEST_DIR, name + '.db');
}

test.after(() => {
  Store.closeAll();
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

// ============================================================
// ITEM 2 — EXPLICIT PAYMENT DOMAIN
// ============================================================

test('domain: the rail simulator labels itself as a simulator, not a gateway', () => {
  const rail = new PaymentRailSimulator();
  assert.equal(rail.kind, 'simulator');
  assert.equal(typeof rail.submitPayment, 'function');
  assert.equal(typeof rail.refundPayment, 'function');
});

test('domain: a saga is one payment intent — intent id is fixed at creation and stable across reload', async () => {
  const storePath = tmpStore('intent-stable');
  const store = new Store(storePath, new PaymentRailSimulator());
  const r = await store.begin('intent-stable-key', 1000, 'clean');
  assert.equal(r.duplicate, false);
  assert.ok(r.paymentIntentId, 'begin returns a paymentIntentId');
  const engine = store.load(r.sagaId);
  assert.equal(engine.paymentIntentId, r.paymentIntentId);

  const store2 = new Store(storePath, new PaymentRailSimulator());
  const reloaded = store2.load(r.sagaId);
  assert.equal(reloaded.paymentIntentId, r.paymentIntentId, 'intent id survives a store reload');
});

test('domain: intent id does NOT shuffle under conflicting idempotency parameters', async () => {
  const storePath = tmpStore('intent-conflict');
  const store = new Store(storePath, new PaymentRailSimulator());
  const r1 = await store.begin('conflict-key', 1000, 'clean');
  const r2 = await store.begin('conflict-key', 5000, 'clean');
  assert.equal(r2.duplicate, true);
  assert.equal(r2.sagaId, r1.sagaId, 'the existing saga wins; no new intent is created');
  assert.equal(r2.paymentIntentId, r1.paymentIntentId, 'the caller is answered with the SAME intent');
  assert.equal(r2.conflict, 'AMOUNT_MISMATCH', 'the conflicting amount is rejected, never merged');
  const engine = store.load(r1.sagaId);
  assert.equal(engine.amount, 1000, 'the stored amount is unchanged by the conflicting call');
  assert.equal(engine.idempotencyKey, 'conflict-key');
});

test('domain: duplicate submit de-duplicates to the SAME provider payment and attempt', () => {
  const rail = new PaymentRailSimulator();
  const r1 = rail.submitPayment('order-1', 1200, 'dup-key');
  const r2 = rail.submitPayment('order-1', 1200, 'dup-key');
  assert.equal(r2.status, r1.status);
  assert.equal(r2.providerPaymentId, r1.providerPaymentId);
  assert.equal(r2.paymentId, r1.paymentId);
  assert.equal(r2.paymentAttemptId, r1.paymentAttemptId, 'a resubmit is the same attempt, not a fresh one');
  assert.equal(rail.getPaymentRecord(r1.paymentId).providerPaymentId, r1.providerPaymentId);
});

test('domain: each distinct idempotency key gets its own provider payment and attempt', () => {
  const rail = new PaymentRailSimulator();
  const a = rail.submitPayment('order-a', 100, 'key-a');
  const b = rail.submitPayment('order-b', 200, 'key-b');
  assert.notEqual(a.providerPaymentId, b.providerPaymentId);
  assert.notEqual(a.paymentAttemptId, b.paymentAttemptId);
});

test('domain: retry after timeout — one intent, one provider payment, one debit, journal records the submit', async () => {
  const storePath = tmpStore('retry-timeout');
  const store = new Store(storePath, new PaymentRailSimulator({ failMode: 'timeout_after_submit' }));
  const { sagaId, paymentIntentId } = await store.begin('timeout-key', 900, 'timeout_after_submit');
  const engine = store.load(sagaId);
  await engine.attempt();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
  const providerPaymentId = engine.providerPaymentId;
  assert.equal(providerPaymentId, engine.paymentId);
  assert.equal(engine.paymentAttempts.length, 1, 'exactly one submit attempt recorded');
  assert.equal(engine.paymentAttempts[0].providerPaymentId, providerPaymentId);

  // Retry (reconcile) after the timeout resolves: same provider payment is
  // confirmed; the ledger still records exactly one debit by paymentId.
  await engine.attempt();
  assert.equal(engine.state, 'SUCCEEDED');
  assert.equal(engine.providerPaymentId, providerPaymentId, 'no new provider payment was created by the retry');
  assert.equal(engine.ledger.entries.filter(e => e.kind === 'DEBIT').length, 1);
  assert.equal(engine.ledger.entries[0].paymentId, providerPaymentId);
  assert.equal(engine.paymentIntentId, paymentIntentId);
  assert.equal(engine.verify().invariantPass, true);
});

test('domain: retry after process death — a brand-new process resumes the SAME intent and provider payment', async () => {
  const storePath = tmpStore('retry-death');
  const rail = new PaymentRailSimulator();
  const store = new Store(storePath, rail);
  const { sagaId, paymentIntentId } = await store.begin('death-key', 1500, 'crash_after_success');
  const engine = store.load(sagaId);
  await engine.attempt();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
  assert.equal(engine.providerPaymentId != null, true);
  store.save(engine);

  // Process "dies": brand-new rail and brand-new store over the same database.
  const rail2 = new PaymentRailSimulator();
  const store2 = new Store(storePath, rail2);
  const resumed = store2.load(sagaId);
  assert.equal(resumed.paymentIntentId, paymentIntentId, 'intent survives death');
  assert.equal(resumed.providerPaymentId, engine.providerPaymentId, 'the persisted provider payment survives death');
  await resumed.attempt();
  assert.equal(resumed.state, 'SUCCEEDED');
  assert.equal(resumed.ledger.debit, 1500);
  assert.equal(resumed.ledger.entries.filter(e => e.kind === 'DEBIT').length, 1);
  assert.equal(rail2.getPaymentRecord(resumed.providerPaymentId).providerPaymentId, engine.providerPaymentId);
  assert.equal(resumed.verify().invariantPass, true);
});

test('domain: refund is tied to the same intent/provider payment it compensates', async () => {
  const storePath = tmpStore('domain-refund');
  const store = new Store(storePath, new PaymentRailSimulator());
  const { sagaId } = await store.begin('refund-key', 1000, 'refund_after_ledger');
  const engine = store.load(sagaId);
  await engine.attempt(); // SUCCEEDED, debit 1000
  await engine.attempt(); // compensate → REFUNDED
  assert.equal(engine.state, 'REFUNDED');
  assert.equal(engine.ledger.debit, 0);
  assert.equal(engine.ledger.credit, 1000);
  const payment = store.rail.getPaymentRecord(engine.providerPaymentId);
  assert.equal(payment.status, 'REFUNDED', 'the provider payment record reflects the refund');
  assert.ok(payment.refundId, 'the refund carries a refund id');
  assert.equal(engine.verify().invariantPass, true);
});

test('domain: duplicate submit pressure cannot create a second provider payment or second debit', async () => {
  const storePath = tmpStore('domain-dup');
  const store = new Store(storePath, new PaymentRailSimulator({ failMode: 'timeout_after_submit' }));
  const { sagaId } = await store.begin('dup-key', 1000, 'timeout_after_submit');
  const engine = store.load(sagaId);
  await engine.attempt(); // EXTERNAL_UNKNOWN
  const providerId = engine.providerPaymentId;

  // A naive second submit would be the same attempt on the rail...
  const railSubmit = store.rail.submitPayment(engine.orderId, 1000, 'dup-key');
  assert.equal(railSubmit.providerPaymentId, providerId, 'the rail refuses to mint a second payment for the same key');

  // ...and the engine's own retry path never submits again until reconciled.
  await engine.attempt();
  assert.equal(engine.providerPaymentId, providerId);
  assert.equal(engine.state, 'SUCCEEDED');
  assert.equal(engine.ledger.entries.filter(e => e.kind === 'DEBIT').length, 1);
  assert.equal(store.rail.getPaymentRecord(providerId).status, 'SUCCEEDED');
});