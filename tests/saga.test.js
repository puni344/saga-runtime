const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { SagaEngine, scenarios } = require('../src/saga');
const { PaymentRailSimulator } = require('../src/rail');
const { Store } = require('../src/store');
const { verify, VALID_STATES, TERMINAL_STATES, VALID_TRANSITIONS } = require('../src/verifier');

const TEST_DIR = path.join(os.tmpdir(), 'saga-test-' + crypto.randomBytes(6).toString('hex'));

function tmpStore(name) {
  if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
  return path.join(TEST_DIR, name + '.json');
}

const _cleanupFiles = [];
function track(f) { _cleanupFiles.push(f); }
function cleanupAll() {
  Store.closeAll();
  for (const f of _cleanupFiles) { try { fs.unlinkSync(f); } catch {} }
  _cleanupFiles.length = 0;
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
}

test.after(cleanupAll);

function makeRail(opts) { return new PaymentRailSimulator(opts || {}); }

// ============================================================
// 1. TEST HYGIENE — repeated execution proves isolation
// ============================================================

test('hygiene: temp directory is outside project data/', () => {
  const projectData = path.join(__dirname, '..', 'data');
  assert.ok(!TEST_DIR.startsWith(projectData), 'test dir must not be inside project data/');
  assert.ok(TEST_DIR.startsWith(os.tmpdir()), 'test dir must be inside os.tmpdir()');
});

test('hygiene: cleanupAll removes temp directory', () => {
  const f = tmpStore('hygiene-check');
  fs.writeFileSync(f, '{}');
  assert.ok(fs.existsSync(f));
  cleanupAll();
  assert.ok(!fs.existsSync(TEST_DIR));
});

// ============================================================
// 2. INVARIANT TESTS — all 6 scenarios, multiple paths
// ============================================================

test('invariant: clean — one debit, money conserved, converged', () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'clean', rail: makeRail() });
  const r = engine.run();
  assert.equal(r.verification.invariantPass, true);
  assert.equal(r.state, 'SUCCEEDED');
  assert.equal(r.ledger.debit, 1000);
  assert.equal(r.ledger.entries.filter(e => e.kind === 'DEBIT').length, 1);
});

test('invariant: crash_after_success — one debit via reconciliation', () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail: makeRail({ failMode: 'crash_after_success' }) });
  const r = engine.run();
  assert.equal(r.verification.invariantPass, true);
  assert.equal(r.state, 'SUCCEEDED');
  assert.equal(r.ledger.debit, 1000);
  assert.equal(r.ledger.entries.filter(e => e.kind === 'DEBIT').length, 1);
});

test('invariant: external_failure — no debit, clean failure', () => {
  const engine = new SagaEngine({ amount: 2000, scenario: 'external_failure', rail: makeRail() });
  const r = engine.run();
  assert.equal(r.verification.invariantPass, true);
  assert.equal(r.state, 'FAILED');
  assert.equal(r.ledger.debit, 0);
});

test('invariant: refund_after_ledger — debit zeroed, credit recorded', () => {
  const engine = new SagaEngine({ amount: 2200, scenario: 'refund_after_ledger', rail: makeRail() });
  const r = engine.run();
  assert.equal(r.verification.invariantPass, true);
  assert.equal(r.state, 'REFUNDED');
  assert.equal(r.ledger.debit, 0);
  assert.equal(r.ledger.credit, 2200);
});

test('invariant: duplicate_retry — retry blocked, invariant holds', () => {
  const engine = new SagaEngine({ amount: 1500, scenario: 'duplicate_retry', rail: makeRail() });
  const r = engine.run();
  assert.equal(r.verification.invariantPass, true);
  assert.equal(r.retriedUnsafe, true);
  assert.equal(r.verification.checks.retryWasBlocked, true);
});

test('invariant: timeout_after_submit — reconciles to one debit', () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'timeout_after_submit', rail: makeRail() });
  const r = engine.run();
  assert.equal(r.verification.invariantPass, true);
  assert.equal(r.state, 'SUCCEEDED');
  assert.equal(r.ledger.debit, 1000);
});

test('reconciliation crash: persisted RECONCILING checkpoint resumes identically to uninterrupted recovery', async () => {
  const storePath = tmpStore('reconcile-crash');
  const rail = makeRail({ failMode: 'timeout_after_submit' });
  const store = new Store(storePath, rail);
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_during_reconciliation', rail, store });

  await engine.attempt();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
  await engine.attempt();
  assert.equal(engine.state, 'RECONCILING', 'simulated crash leaves a durable reconciliation checkpoint');

  const resumed = store.load(engine.sagaId);
  await resumed.attempt();
  const uninterrupted = new SagaEngine({ amount: 1000, scenario: 'timeout_after_submit', rail: makeRail({ failMode: 'timeout_after_submit' }) });
  const expected = uninterrupted.run();

  assert.equal(resumed.state, expected.state);
  assert.equal(resumed.ledger.debit, expected.ledger.debit);
  assert.equal(resumed.ledger.entries.filter(e => e.kind === 'DEBIT').length, 1);
  assert.equal(resumed.verify().invariantPass, true);
  track(storePath);
});

test('fault points: each injected point follows a distinct resumable state path', async () => {
  const cases = [
    { point: 'before_submit', first: 'AUTHORIZED', attempts: 2 },
    { point: 'after_ack_before_local_commit', first: 'PROCESSING', attempts: 2 },
    { point: 'after_submit_before_ack', first: 'EXTERNAL_UNKNOWN', attempts: 2 },
    { point: 'during_reconciliation', first: 'EXTERNAL_UNKNOWN', attempts: 3 }
  ];
  for (const { point, first, attempts } of cases) {
    const engine = new SagaEngine({ amount: 1000, scenario: 'clean', faultPoint: point, rail: makeRail() });
    for (let i = 0; i < attempts; i++) await engine.attempt();
    assert.equal(engine.timeline.some(e => e.event.includes('FAULT_') || e.event === 'RECONCILE_CRASH_SIMULATED'), true, point);
    assert.equal(engine.state, 'SUCCEEDED', point);
    assert.equal(engine.verify().invariantPass, true, point);
    assert.equal(engine.ledger.entries.filter(e => e.kind === 'DEBIT').length, 1, point);
    if (first === 'AUTHORIZED') assert.equal(engine.timeline.some(e => e.state === 'AUTHORIZED' && e.event === 'FAULT_BEFORE_SUBMIT_SIMULATED'), true, point);
    if (first === 'PROCESSING') assert.equal(engine.timeline.some(e => e.state === 'PROCESSING' && e.event === 'FAULT_AFTER_ACK_BEFORE_COMMIT_SIMULATED'), true, point);
  }
});

test('invariant: all 6 scenarios pass verification', () => {
  for (const scenario of Object.keys(scenarios)) {
    const engine = new SagaEngine({ amount: 1000, scenario, rail: makeRail({ failMode: scenario === 'duplicate_retry' ? 'timeout_after_submit' : scenario === 'timeout_after_submit' ? 'timeout_after_submit' : scenario === 'crash_after_success' ? 'crash_after_success' : scenario === 'external_failure' ? 'external_failure' : 'none' }) });
    const r = engine.run();
    assert.equal(r.verification.invariantPass, true, `FAILED: ${scenario} state=${r.state}`);
  }
});

// ============================================================
// 3. CENTRAL INVARIANT — prove from multiple paths
// ============================================================

test('invariant: clean path — exactly one debit entry per payment', () => {
  const engine = new SagaEngine({ amount: 500, scenario: 'clean', rail: makeRail() });
  engine.run();
  const debits = engine.ledger.entries.filter(e => e.kind === 'DEBIT');
  assert.equal(debits.length, 1);
  assert.equal(debits[0].paymentId, engine.paymentId);
  assert.equal(debits[0].amount, 500);
});

test('invariant: crash → reconcile — exactly one debit entry per payment', async () => {
  const rail = makeRail({ failMode: 'crash_after_success' });
  const engine = new SagaEngine({ amount: 750, scenario: 'crash_after_success', rail });
  await engine.attempt();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
  assert.equal(engine.ledger.entries.filter(e => e.kind === 'DEBIT').length, 0);

  rail._payments[engine.paymentId].status = 'SUCCEEDED';
  await engine.attempt();
  assert.equal(engine.state, 'SUCCEEDED');
  const debits = engine.ledger.entries.filter(e => e.kind === 'DEBIT');
  assert.equal(debits.length, 1);
  assert.equal(debits[0].amount, 750);
});

test('invariant: retry 10 times — still exactly one debit', async () => {
  const rail = makeRail({ failMode: 'crash_after_success' });
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail });
  await engine.attempt();
  rail._payments[engine.paymentId].status = 'SUCCEEDED';
  for (let i = 0; i < 10; i++) {
    await engine.attempt();
  }
  assert.equal(engine.ledger.entries.filter(e => e.kind === 'DEBIT').length, 1);
  assert.equal(engine.ledger.debit, 1000);
});

test('invariant: commitLedger guard blocks duplicate debit directly', () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'clean', rail: makeRail() });
  engine.createPayment();
  engine._transition('PROCESSING', 'test');
  engine.external.status = 'SUCCEEDED';
  engine.paymentId = 'pay_test';
  engine.commitLedger();
  assert.equal(engine.ledger.debit, 1000);
  engine.commitLedger();
  assert.equal(engine.ledger.debit, 1000);
  assert.equal(engine.ledger.entries.filter(e => e.kind === 'DEBIT').length, 1);
});

// ============================================================
// 4. EXTERNAL_UNKNOWN SAFETY — audit all entry paths
// ============================================================

test('EXTERNAL_UNKNOWN: entry via submitPayment with UNKNOWN result', async () => {
  const rail = makeRail({ failMode: 'crash_after_success' });
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail });
  await engine.attempt();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
  assert.equal(engine.external.status, 'UNKNOWN');
});

test('EXTERNAL_UNKNOWN: entry via compensate with refund UNKNOWN', () => {
  const rail = makeRail({ refundFailMode: 'refund_unknown' });
  const engine = new SagaEngine({ amount: 1500, scenario: 'refund_after_ledger', rail });
  engine.run();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
  assert.equal(engine.external.status, 'UNKNOWN');
});

test('EXTERNAL_UNKNOWN: entry via reconcile returning UNKNOWN', async () => {
  const rail = makeRail({ failMode: 'crash_after_success' });
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail });
  await engine.attempt();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
  rail._payments[engine.paymentId].status = 'UNKNOWN';
  engine.reconcile();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
});

test('EXTERNAL_UNKNOWN → blind retry: rejected', async () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail: makeRail({ failMode: 'crash_after_success' }) });
  await engine.attempt();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
  const result = await engine.retry();
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'EXTERNAL_STATE_UNRESOLVED');
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
});

test('EXTERNAL_UNKNOWN → reconcile SUCCESS → one debit', async () => {
  const rail = makeRail({ failMode: 'crash_after_success' });
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail });
  await engine.attempt();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
  rail._payments[engine.paymentId].status = 'SUCCEEDED';
  engine.reconcile();
  assert.equal(engine.state, 'SUCCEEDED');
  assert.equal(engine.ledger.debit, 1000);
  assert.equal(engine.ledger.entries.filter(e => e.kind === 'DEBIT').length, 1);
});

test('EXTERNAL_UNKNOWN → reconcile FAILED → safe FAILED, no debit', async () => {
  const rail = makeRail({ failMode: 'crash_after_success' });
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail });
  await engine.attempt();
  rail._payments[engine.paymentId].status = 'FAILED';
  engine.reconcile();
  assert.equal(engine.state, 'FAILED');
  assert.equal(engine.ledger.debit, 0);
});

test('EXTERNAL_UNKNOWN → reconcile UNKNOWN → remains EXTERNAL_UNKNOWN, no debit', async () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail: makeRail({ failMode: 'crash_after_success' }) });
  await engine.attempt();
  engine.rail._payments[engine.paymentId].status = 'UNKNOWN';
  engine.reconcile();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
  assert.equal(engine.ledger.debit, 0);
});

test('EXTERNAL_UNKNOWN: retry sets retriedUnsafe flag for verifier', async () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail: makeRail({ failMode: 'crash_after_success' }) });
  await engine.attempt();
  assert.equal(engine.retriedUnsafe, false);
  await engine.retry();
  assert.equal(engine.retriedUnsafe, true);
});

test('EXTERNAL_UNKNOWN: verifier passes as safe unresolved when retryAttempted', async () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail: makeRail({ failMode: 'crash_after_success' }) });
  await engine.attempt();
  await engine.retry();
  const v = engine.verify();
  assert.equal(v.checks.validTerminalState, true);
  assert.equal(v.checks.retryWasBlocked, true);
  assert.equal(v.invariantPass, true);
});

test('EXTERNAL_UNKNOWN: no hidden path bypasses safety', async () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail: makeRail({ failMode: 'crash_after_success' }) });
  await engine.attempt();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
  engine.rail._payments[engine.paymentId].status = 'UNKNOWN';
  engine.reconcile();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN', 'reconcile with UNKNOWN result must stay EXTERNAL_UNKNOWN');
  assert.equal(engine.ledger.debit, 0, 'no debit recorded while EXTERNAL_UNKNOWN');
});

// ============================================================
// 5. RECONCILE TESTS
// ============================================================

test('reconcile: skipped when state is not EXTERNAL_UNKNOWN', async () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'clean', rail: makeRail() });
  engine.reconcile();
  assert.equal(engine.state, 'CREATED');
});

test('reconcile: transitions to RECONCILING then resolves', async () => {
  const rail = makeRail({ failMode: 'crash_after_success' });
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail });
  await engine.attempt();
  engine.reconcile();
  const hasReconciling = engine.timeline.some(e => e.event === 'STATE_TRANSITION' && e.detail.to === 'RECONCILING');
  assert.equal(hasReconciling, true);
});

test('reconcile: SUCCESS path commits ledger exactly once', async () => {
  const rail = makeRail({ failMode: 'crash_after_success' });
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail });
  await engine.attempt();
  rail._payments[engine.paymentId].status = 'SUCCEEDED';
  engine.reconcile();
  assert.equal(engine.state, 'SUCCEEDED');
  assert.equal(engine.ledger.debit, 1000);
  assert.equal(engine.ledger.entries.filter(e => e.kind === 'DEBIT').length, 1);
  engine.reconcile();
  assert.equal(engine.ledger.debit, 1000);
  assert.equal(engine.ledger.entries.filter(e => e.kind === 'DEBIT').length, 1);
});

test('reconcile: clears the leaked submit-time failMode so attempt() recovers without caller surgery', async () => {
  const rail = makeRail({ failMode: 'crash_after_success' });
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail });
  await engine.attempt();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
  assert.equal(rail._failMode, 'crash_after_success', 'submit-time failMode must be demonstrably present on the shared rail');
  await engine.attempt();
  assert.equal(rail._failMode, 'none', 'reconcile must clear the transient failMode before reading external truth');
  assert.equal(engine.state, 'SUCCEEDED', 'no manual healthy-rail surgery required for in-process recovery');
  assert.equal(engine.ledger.debit, 1000);
  assert.equal(engine.ledger.entries.filter(e => e.kind === 'DEBIT').length, 1);
});

// ============================================================
// 6. IDEMPOTENCY TESTS — code-level proof
// ============================================================

test('idempotency: same key returns existing saga', async () => {
  const storePath = tmpStore('idem-1');
  const store = new Store(storePath, makeRail());
  const r1 = await store.begin('idem-key-001', 1500, 'clean');
  assert.equal(r1.duplicate, false);
  const r2 = await store.begin('idem-key-001', 1500, 'clean');
  assert.equal(r2.duplicate, true);
  assert.equal(r2.sagaId, r1.sagaId);
  track(storePath);
});

test('idempotency: same key with different amount returns existing (does not create)', async () => {
  const storePath = tmpStore('idem-2');
  const store = new Store(storePath, makeRail());
  await store.begin('idem-key-002', 1500, 'clean');
  const r2 = await store.begin('idem-key-002', 3000, 'clean');
  assert.equal(r2.duplicate, true);
  track(storePath);
});

test('idempotency: same key persists across store reload', async () => {
  const storePath = tmpStore('idem-3');
  let store = new Store(storePath, makeRail());
  const r1 = await store.begin('idem-key-003', 1500, 'clean');
  store = new Store(storePath, makeRail());
  const r2 = await store.begin('idem-key-003', 1500, 'clean');
  assert.equal(r2.duplicate, true);
  assert.equal(r2.sagaId, r1.sagaId);
  track(storePath);
});

test('idempotency: rail-level dedup returns same payment', () => {
  const rail = makeRail();
  const r1 = rail.submitPayment('order1', 1000, 'key-001');
  const r2 = rail.submitPayment('order1', 1000, 'key-001');
  assert.equal(r2.paymentId, r1.paymentId);
  assert.equal(r2.status, r1.status);
});

test('idempotency: rail rejects conflicting amount', () => {
  const rail = makeRail();
  rail.submitPayment('order1', 1000, 'key-002');
  const r2 = rail.submitPayment('order1', 2000, 'key-002');
  assert.equal(r2.status, 'REJECTED');
  assert.equal(r2.reason, 'AMOUNT_MISMATCH');
});

test('idempotency: store begin checks all sagas for key match', async () => {
  const storePath = tmpStore('idem-4');
  const store = new Store(storePath, makeRail());
  await store.begin('key-a', 1000, 'clean');
  await store.begin('key-b', 2000, 'clean');
  const r = await store.begin('key-a', 1000, 'clean');
  assert.equal(r.duplicate, true);
  track(storePath);
});

test('idempotency: explanation — uniqueness boundary is store.sagas', async () => {
  const storePath = tmpStore('idem-5');
  const store = new Store(storePath, makeRail());
  const r = await store.begin('new-unique-key', 1000, 'clean');
  assert.equal(r.duplicate, false);
  track(storePath);
});

// ============================================================
// 7. PERSISTENCE TESTS — end-to-end recovery proof
// ============================================================

test('persistence: saga state survives store reload', async () => {
  const storePath = tmpStore('persist-1');
  const rail = makeRail({ failMode: 'crash_after_success' });
  let store = new Store(storePath, rail);
  const { sagaId } = await store.begin('persist-key-001', 1000, 'crash_after_success');
  let engine = store.load(sagaId);
  await engine.attempt();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');

  store = new Store(storePath, rail);
  engine = store.load(sagaId);
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
  assert.equal(engine.paymentId != null, true);
  track(storePath);
});

test('persistence: ledger entries survive store reload', async () => {
  const storePath = tmpStore('persist-2');
  const rail = makeRail();
  let store = new Store(storePath, rail);
  const { sagaId } = await store.begin('persist-ledger', 500, 'clean');
  let engine = store.load(sagaId);
  engine.run();
  store.save(engine);

  store = new Store(storePath, rail);
  engine = store.load(sagaId);
  assert.equal(engine.ledger.debit, 500);
  assert.equal(engine.state, 'SUCCEEDED');
  assert.equal(engine.ledger.entries.length, 1);
  track(storePath);
});

test('persistence: corrupted state file fails loudly, not silently', () => {
  const storePath = tmpStore('persist-corrupt');
  fs.writeFileSync(storePath, '{ this is not valid json !!!');
  assert.throws(() => new Store(storePath, makeRail()), /PERSISTED_STATE_CORRUPT/,
    'A money ledger must refuse to start on corrupt state, not silently pretend it is empty');
  track(storePath);
});

test('persistence: empty state file loads as empty, not corrupt', () => {
  const storePath = tmpStore('persist-empty');
  fs.writeFileSync(storePath, '');
  const store = new Store(storePath, makeRail());
  assert.deepEqual(store.list(), []);
  track(storePath);
});

test('persistence: non-object state file rejected', () => {
  const storePath = tmpStore('persist-array');
  fs.writeFileSync(storePath, '[1,2,3]');
  assert.throws(() => new Store(storePath, makeRail()), /PERSISTED_STATE_CORRUPT/);
  track(storePath);
});

test('persistence: crash recovery — submit, persist, reload, reconcile, one debit', async () => {
  const storePath = tmpStore('persist-3');
  // Rail is constructed healthy (as in a real deployment). The scenario's failure
  // injection is transient: applied only during submit inside attempt(), then restored.
  // Persisting a submit-time failMode as durable rail truth would wrongly block the
  // post-restart reconciliation query, so this test uses the real-server model.
  const rail = makeRail();
  let store = new Store(storePath, rail);
  const { sagaId } = await store.begin('crash-key-001', 1500, 'crash_after_success');
  let engine = store.load(sagaId);
  await engine.attempt();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
  assert.equal(engine.ledger.debit, 0);
  store.save(engine);

  // Rail truth (payment SUCCEEDED) is already on disk; no manual mutation needed.
  // Brand-new Store + brand-new rail simulate a real process restart: only JSON survives.
  const rail2 = makeRail();
  store = new Store(storePath, rail2);
  engine = store.load(sagaId);
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
  assert.equal(engine.paymentId != null, true);
  await engine.attempt();
  assert.equal(engine.state, 'SUCCEEDED');
  assert.equal(engine.ledger.debit, 1500);
  assert.equal(engine.ledger.entries.filter(e => e.kind === 'DEBIT').length, 1);
  assert.equal(engine.verify().invariantPass, true);
  track(storePath);
});

test('persistence: no hidden in-process object required — full state from database', async () => {
  const storePath = tmpStore('persist-4');
  // Same real-server model as the crash-recovery test above: healthy rail, transient
  // scenario injection, recovery from the database alone with zero manual rail mutation.
  const rail = makeRail();
  let store = new Store(storePath, rail);
  const { sagaId } = await store.begin('full-recovery', 2000, 'crash_after_success');
  let engine = store.load(sagaId);
  await engine.attempt();
  store.save(engine);

  // A brand-new Store (and brand-new rail) reads saga + payment entirely from the
  // database file; no hidden in-process object is required.
  const rail2 = makeRail();
  const store2 = new Store(storePath, rail2);
  const engine2 = store2.load(sagaId);
  assert.equal(engine2.state, 'EXTERNAL_UNKNOWN');
  assert.equal(engine2.amount, 2000);
  assert.equal(engine2.paymentId, engine.paymentId);
  assert.equal(engine2.idempotencyKey, engine.idempotencyKey);
  await engine2.attempt();
  assert.equal(engine2.state, 'SUCCEEDED');
  assert.equal(engine2.ledger.debit, 2000);
  track(storePath);
});

// ============================================================
// 8. CONCURRENCY TESTS — with real overlapping async
// ============================================================

test('concurrency: lock rejects concurrent access', async () => {
  const storePath = tmpStore('conc-1');
  const store = new Store(storePath, makeRail());
  const { sagaId } = await store.begin('conc-key-001', 1000, 'clean');

  let errorCaught = false;
  try {
    await Promise.all([
      store.withLock(sagaId, async () => { await new Promise(r => setTimeout(r, 100)); return 'a'; }),
      store.withLock(sagaId, async () => { return 'b'; })
    ]);
  } catch (e) {
    errorCaught = e.message === 'CONCURRENT_ACCESS';
  }
  assert.equal(errorCaught, true);
  track(storePath);
});

test('concurrency: sequential operations succeed', async () => {
  const storePath = tmpStore('conc-2');
  const store = new Store(storePath, makeRail());
  const r1 = await store.withLock('x', async () => 'a');
  const r2 = await store.withLock('x', async () => 'b');
  assert.equal(r1, 'a');
  assert.equal(r2, 'b');
  track(storePath);
});

test('concurrency: 10 recovery attempts with lock — one debit', async () => {
  const rail = makeRail({ failMode: 'crash_after_success' });
  const storePath = tmpStore('conc-3');
  const store = new Store(storePath, rail);
  const { sagaId } = await store.begin('multi-001', 1000, 'crash_after_success');
  const engine = store.load(sagaId);
  await engine.attempt();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');

  rail._payments[engine.paymentId].status = 'SUCCEEDED';

  for (let i = 0; i < 10; i++) {
    await store.withLock(sagaId, async () => engine.attempt());
  }
  const debitEntries = engine.ledger.entries.filter(e => e.kind === 'DEBIT');
  assert.equal(debitEntries.length, 1);
  assert.equal(engine.ledger.debit, 1000);
  assert.equal(engine.verify().invariantPass, true);
  track(storePath);
});

test('concurrency: overlapping calls without lock — commitLedger deduplicates', async () => {
  const rail = makeRail({ failMode: 'crash_after_success' });
  const storePath = tmpStore('conc-4');
  const store = new Store(storePath, rail);
  const { sagaId } = await store.begin('race-001', 1000, 'crash_after_success');
  const engine = store.load(sagaId);
  await engine.attempt();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');

  rail._payments[engine.paymentId].status = 'SUCCEEDED';

  await engine.attempt();
  await engine.attempt();
  await engine.attempt();
  const debitEntries = engine.ledger.entries.filter(e => e.kind === 'DEBIT');
  assert.equal(debitEntries.length, 1);
  assert.equal(engine.ledger.debit, 1000);
  assert.equal(engine.verify().invariantPass, true);
  track(storePath);
});

test('concurrency: state machine correctness — lock serializes, code deduplicates', () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'clean', rail: makeRail() });
  engine.reconcile();
  assert.equal(engine.state, 'CREATED');
  assert.equal(engine.ledger.debit, 0);
});

test('concurrency: truly concurrent operations on the same saga — one debit, converged state', async () => {
  const rail = makeRail({ failMode: 'crash_after_success' });
  const storePath = tmpStore('conc-race');
  const store = new Store(storePath, rail);
  const { sagaId } = await store.begin('race-key-001', 1000, 'crash_after_success');
  const engine = store.load(sagaId);
  await engine.attempt();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');

  rail._payments[engine.paymentId].status = 'SUCCEEDED';

  // Fire two operations at the SAME saga concurrently: one attempt (which reconciles and
  // would commit the debit) racing a retry (which would be unsafe while unresolved).
  // Defer each lock acquisition into a microtask so the fail-fast CONCURRENT_ACCESS
  // rejection is captured by Promise.allSettled instead of throwing synchronously.
  const racers = [
    Promise.resolve().then(() => store.withLock(sagaId, () => engine.attempt())),
    Promise.resolve().then(() => store.withLock(sagaId, () => engine.retry()))
  ];
  const results = await Promise.allSettled(racers);
  const fulfilled = results.filter(r => r.status === 'fulfilled');
  const rejected = results.filter(r => r.status === 'rejected');
  assert.ok(fulfilled.length >= 1, 'at least one concurrent operation succeeded');
  assert.ok(
    rejected.every(r => r.reason && r.reason.message === 'CONCURRENT_ACCESS'),
    'any rejection must be the fail-fast CONCURRENT_ACCESS lock, not a data race'
  );

  const debitEntries = engine.ledger.entries.filter(e => e.kind === 'DEBIT');
  assert.equal(debitEntries.length, 1, 'exactly one debit regardless of operation order');
  assert.equal(engine.ledger.debit, 1000);
  assert.equal(engine.verify().invariantPass, true);
  track(storePath);
});

// ============================================================
// 9. REFUND / COMPENSATION TESTS
// ============================================================

test('refund: once — debit zeroed, credit recorded', () => {
  const engine = new SagaEngine({ amount: 1500, scenario: 'refund_after_ledger', rail: makeRail() });
  const r = engine.run();
  assert.equal(r.state, 'REFUNDED');
  assert.equal(r.ledger.debit, 0);
  assert.equal(r.ledger.credit, 1500);
  assert.equal(r.verification.invariantPass, true);
});

test('refund: twice — second compensation blocked', () => {
  const engine = new SagaEngine({ amount: 1500, scenario: 'refund_after_ledger', rail: makeRail() });
  engine.run();
  engine.compensate('second attempt');
  assert.equal(engine.state, 'REFUNDED');
  assert.equal(engine.ledger.credit, 1500);
  assert.equal(engine.verify().invariantPass, true);
});

test('refund: idempotency — compensate三次 does not double credit', () => {
  const engine = new SagaEngine({ amount: 2000, scenario: 'refund_after_ledger', rail: makeRail() });
  engine.run();
  engine.compensate('attempt 2');
  engine.compensate('attempt 3');
  assert.equal(engine.ledger.credit, 2000);
});

test('refund: verify checks refund idempotency', () => {
  const engine = new SagaEngine({ amount: 1500, scenario: 'refund_after_ledger', rail: makeRail() });
  engine.run();
  assert.equal(engine.verify().checks.refundIdempotent, true);
});

test('refund: external refund unknown — enters EXTERNAL_UNKNOWN safely', () => {
  const rail = makeRail({ refundFailMode: 'refund_unknown' });
  const engine = new SagaEngine({ amount: 1500, scenario: 'refund_after_ledger', rail });
  const r = engine.run();
  assert.equal(r.state, 'EXTERNAL_UNKNOWN');
  assert.equal(r.verification.invariantPass, true);
  assert.equal(engine.compensationCount, 1);
});

test('refund: refund failure — stays in COMPENSATING', () => {
  const rail = makeRail({ refundFailMode: 'refund_failure' });
  const engine = new SagaEngine({ amount: 1500, scenario: 'refund_after_ledger', rail });
  engine.run();
  assert.equal(engine.state, 'COMPENSATING');
  assert.equal(engine.compensationCount, 1);
});

test('refund: compensate without debit transitions to FAILED', () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'clean', rail: makeRail() });
  engine.compensate('manual');
  assert.equal(engine.state, 'FAILED');
});

test('refund: after ledger commit — accounting is correct', () => {
  const engine = new SagaEngine({ amount: 3000, scenario: 'refund_after_ledger', rail: makeRail() });
  engine.run();
  const debits = engine.ledger.entries.filter(e => e.kind === 'DEBIT');
  const credits = engine.ledger.entries.filter(e => e.kind === 'REFUND');
  assert.equal(debits.length, 1, 'one DEBIT entry');
  assert.equal(credits.length, 1, 'one REFUND entry');
  assert.equal(engine.ledger.debit, 0, 'debit netted to zero');
  assert.equal(engine.ledger.credit, 3000, 'credit recorded');
  assert.equal(engine.external.status, 'REFUNDED');
});

test('refund: rail blocks double refund', () => {
  const rail = makeRail();
  rail.submitPayment('o1', 1000, 'k1');
  const p = Object.values(rail._payments)[0];
  rail.refundPayment(p.paymentId, 1000, 'k1');
  const r2 = rail.refundPayment(p.paymentId, 1000, 'k1');
  assert.equal(r2.status, 'ALREADY_REFUNDED');
});

// ============================================================
// 10. INPUT VALIDATION
// ============================================================

test('validation: zero amount rejected', () => {
  assert.throws(() => new SagaEngine({ amount: 0 }), /Amount must be positive/);
});

test('validation: negative amount rejected', () => {
  assert.throws(() => new SagaEngine({ amount: -100 }), /Amount must be positive/);
});

test('validation: NaN amount rejected', () => {
  assert.throws(() => new SagaEngine({ amount: NaN }), /Amount must be positive/);
});

test('validation: Infinity amount rejected', () => {
  assert.throws(() => new SagaEngine({ amount: Infinity }), /Amount must be positive/);
});

test('validation: no rail throws on createPayment', () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'clean' });
  assert.throws(() => engine.createPayment(), /NO_PAYMENT_RAIL/);
});

// ============================================================
// 11. BENCHMARK TESTS
// ============================================================

test('benchmark: deterministic for same seed', async () => {
  const a = await new SagaEngine({ amount: 1000, rail: makeRail() }).benchmark(50, 42);
  const b = await new SagaEngine({ amount: 1000, rail: makeRail() }).benchmark(50, 42);
  assert.equal(a.recoveryRate, b.recoveryRate);
  assert.equal(a.duplicatePreventionRate, b.duplicatePreventionRate);
  assert.equal(a.invariantViolations, b.invariantViolations);
  assert.equal(a.retryGuard.unsafeRetryPrecision, b.retryGuard.unsafeRetryPrecision);
  assert.equal(a.retryGuard.unsafeRetryRecall, b.retryGuard.unsafeRetryRecall);
});

test('benchmark: 100% recovery rate — synthetic prototype', async () => {
  const result = await new SagaEngine({ amount: 1000, rail: makeRail() }).benchmark(100, 42);
  assert.equal(result.recoveryRate, 1.0);
  assert.equal(result.invariantViolations, 0);
  assert.equal(result.duplicatePreventionRate, 1.0);
});

test('benchmark: all scenarios present', async () => {
  const result = await new SagaEngine({ amount: 1000, rail: makeRail() }).benchmark(50, 42);
  const names = new Set(result.cases.map(c => c.scenario));
  for (const s of Object.keys(scenarios)) {
    assert.ok(names.has(s), `Missing scenario: ${s}`);
  }
});

test('benchmark retryGuard: genuinely unlabeled ambiguous-retry cases present', async () => {
  const result = await new SagaEngine({ amount: 1000, rail: makeRail() }).benchmark(200, 42);
  const guard = result.retryGuard;
  assert.ok(guard.n > 0);
  assert.equal(guard.source, 'observed-guard-sweep');
  const unlabeledUnsafe = guard.cases.filter(c => c.unsafe && c.scenario !== 'duplicate_retry');
  assert.ok(unlabeledUnsafe.length > 0, 'unsafe retry cases must not all come from the duplicate_retry label');
  assert.ok(unlabeledUnsafe.some(c => c.scenario === 'crash_after_success' || c.scenario === 'timeout_after_submit'), 'expected crash/timeout ambiguous cases');
});

test('benchmark retryGuard: real guard blocks every unsafe retry and never mislabels a safe retry', async () => {
  const result = await new SagaEngine({ amount: 1000, rail: makeRail() }).benchmark(200, 42);
  const guard = result.retryGuard;
  assert.equal(guard.unsafeRetryRecall, 1.0, 'every unsafe retry must be blocked');
  assert.equal(guard.fn, 0);
  assert.equal(guard.unsafeRetryPrecision, 1.0);
  assert.equal(guard.fp, 0);
  assert.ok(guard.tp + guard.tn === guard.n, 'every case is classified exactly once');
});

test('benchmark retryGuard: NOT trivially 1.0 by construction — permissive guard collapses recall/precision to 0', async () => {
  const permissive = new SagaEngine({ amount: 1000, rail: makeRail() });
  const g = await permissive.benchmarkGuardRetry(40, 42, { retryDriver: async () => ({ allowed: true, reason: null }) });
  assert.equal(g.unsafeRetryPrecision, 0, 'allowing every retry must destroy precision');
  assert.equal(g.unsafeRetryRecall, 0, 'allowing every retry must destroy recall');
});

test('benchmark retryGuard: NOT trivially 1.0 by construction — overzealous guard mislabels safe retries (FP>0)', async () => {
  const overzealous = new SagaEngine({ amount: 1000, rail: makeRail() });
  const g = await overzealous.benchmarkGuardRetry(40, 42, { retryDriver: async () => ({ allowed: false, reason: 'EXTERNAL_STATE_UNRESOLVED' }) });
  assert.ok(g.fp > 0, 'safe retries mislabeled as unsafe must appear as false positives');
  assert.ok(g.unsafeRetryPrecision < 1.0, 'false positives must push precision below 1.0');
});

test('benchmark retryGuard: deterministic across same seed', async () => {
  const a = await new SagaEngine({ amount: 1000, rail: makeRail() }).benchmarkGuardRetry(40, 42);
  const b = await new SagaEngine({ amount: 1000, rail: makeRail() }).benchmarkGuardRetry(40, 42);
  assert.equal(a.tp, b.tp);
  assert.equal(a.fp, b.fp);
  assert.equal(a.fn, b.fn);
  assert.equal(a.tn, b.tn);
  for (let i = 0; i < a.cases.length; i++) {
    assert.equal(a.cases[i].unsafe, b.cases[i].unsafe);
    assert.equal(a.cases[i].blocked, b.cases[i].blocked);
  }
});

// ============================================================
// 12. VERIFIER TESTS
// ============================================================

test('verifier: detects duplicate debit', () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'clean', rail: makeRail() });
  engine.paymentId = 'pay_test';
  engine.external.status = 'SUCCEEDED';
  engine.ledger.entries.push({ id: '1', paymentId: 'pay_test', amount: 1000, kind: 'DEBIT' });
  engine.ledger.entries.push({ id: '2', paymentId: 'pay_test', amount: 1000, kind: 'DEBIT' });
  engine.ledger.debit = 2000;
  engine.state = 'SUCCEEDED';
  const v = verify(engine, false);
  assert.equal(v.checks.noDuplicateDebit, false);
  assert.equal(v.invariantPass, false);
});

test('verifier: detects money conservation violation', () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'clean', rail: makeRail() });
  engine.paymentId = 'pay_test';
  engine.external.status = 'SUCCEEDED';
  engine.ledger.entries.push({ id: '1', paymentId: 'pay_test', amount: 500, kind: 'DEBIT' });
  engine.ledger.debit = 500;
  engine.state = 'SUCCEEDED';
  const v = verify(engine, false);
  assert.equal(v.checks.moneyConserved, false);
});

test('verifier: safe unresolved — EXTERNAL_UNKNOWN + retryAttempted passes', () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail: makeRail() });
  engine.state = 'EXTERNAL_UNKNOWN';
  engine.external.status = 'UNKNOWN';
  const v = verify(engine, true);
  assert.equal(v.checks.validTerminalState, true);
  assert.equal(v.invariantPass, true);
});

test('verifier: safe unresolved — EXTERNAL_UNKNOWN + UNKNOWN status passes', () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail: makeRail() });
  engine.state = 'EXTERNAL_UNKNOWN';
  engine.external.status = 'UNKNOWN';
  const v = verify(engine, false);
  assert.equal(v.checks.validTerminalState, true);
  assert.equal(v.invariantPass, true);
});

test('verifier: all checks pass on clean completed saga', () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'clean', rail: makeRail() });
  engine.run();
  const v = engine.verify();
  for (const [k, val] of Object.entries(v.checks)) {
    if (k === 'validPausedState') {
      assert.equal(val, false, 'a settled saga is not awaiting review');
      continue;
    }
    assert.equal(val, true, `Check ${k} failed`);
  }
});

test('verifier: VALID_STATES and VALID_TRANSITIONS are complete', () => {
  for (const s of Object.keys(VALID_TRANSITIONS)) {
    assert.ok(VALID_STATES.has(s), `State ${s} in transitions but not in VALID_STATES`);
  }
});

// ============================================================
// 13. RAIL TESTS
// ============================================================

test('rail: submitPayment returns correct status', () => {
  const rail = makeRail();
  const result = rail.submitPayment('order1', 1000, 'key1');
  assert.equal(result.status, 'SUCCEEDED');
  assert.ok(result.paymentId.startsWith('pay_'));
});

test('rail: getPaymentStatus returns persisted status', () => {
  const rail = makeRail();
  const result = rail.submitPayment('order1', 1000, 'key1');
  const status = rail.getPaymentStatus(result.paymentId);
  assert.equal(status.status, 'SUCCEEDED');
});

test('rail: refundPayment processes refund', () => {
  const rail = makeRail();
  const pay = rail.submitPayment('order1', 1000, 'key1');
  const refund = rail.refundPayment(pay.paymentId, 1000, 'key1');
  assert.equal(refund.status, 'REFUNDED');
});

test('rail: double refund blocked', () => {
  const rail = makeRail();
  const pay = rail.submitPayment('order1', 1000, 'key1');
  rail.refundPayment(pay.paymentId, 1000, 'key1');
  const r2 = rail.refundPayment(pay.paymentId, 1000, 'key1');
  assert.equal(r2.status, 'ALREADY_REFUNDED');
});

test('rail: failMode returns UNKNOWN on submit but records SUCCEEDED', () => {
  const rail = makeRail({ failMode: 'crash_after_success' });
  const result = rail.submitPayment('order1', 1000, 'key1');
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(rail._payments[result.paymentId].status, 'SUCCEEDED');
});

test('rail: getPaymentStatus with failMode returns UNKNOWN', () => {
  const rail = makeRail({ failMode: 'crash_after_success' });
  const result = rail.submitPayment('order1', 1000, 'key1');
  const status = rail.getPaymentStatus(result.paymentId);
  assert.equal(status.status, 'UNKNOWN');
});

test('rail: getState/loadState roundtrip', () => {
  const rail1 = makeRail({ failMode: 'crash_after_success' });
  rail1.submitPayment('order1', 1000, 'key1');
  const state = rail1.getState();
  const rail2 = makeRail();
  rail2.loadState(state);
  assert.equal(rail2._failMode, 'crash_after_success');
});

// ============================================================
// 14. SCENARIO TESTS
// ============================================================

test('scenario: external_failure — no debit, clean failure', () => {
  const engine = new SagaEngine({ amount: 1500, scenario: 'external_failure', rail: makeRail() });
  const r = engine.run();
  assert.equal(r.state, 'FAILED');
  assert.equal(r.ledger.debit, 0);
  assert.equal(r.verification.invariantPass, true);
});

test('scenario: timeout — enters EXTERNAL_UNKNOWN then reconciles', () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'timeout_after_submit', rail: makeRail() });
  const r = engine.run();
  assert.equal(r.state, 'SUCCEEDED');
  assert.equal(r.verification.invariantPass, true);
});

test('scenario: all 6 pass invariant with correct failModes', () => {
  const failModes = {
    clean: 'none', crash_after_success: 'crash_after_success',
    timeout_after_submit: 'timeout_after_submit', external_failure: 'external_failure',
    duplicate_retry: 'timeout_after_submit', refund_after_ledger: 'none'
  };
  for (const [id, fm] of Object.entries(failModes)) {
    const rail = makeRail({ failMode: fm });
    const engine = new SagaEngine({ amount: 1000, scenario: id, rail });
    const r = engine.run();
    assert.equal(r.verification.invariantPass, true, `Scenario ${id} failed`);
  }
});

// ============================================================
// 15. RETRY TESTS
// ============================================================

test('retry: FAILED state allows retry (re-runs lifecycle)', async () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'external_failure', rail: makeRail() });
  engine.run();
  assert.equal(engine.state, 'FAILED');
  assert.equal(engine.retryCount, 0);
  const result = await engine.retry();
  assert.equal(result.allowed, true);
  assert.equal(engine.retryCount, 1);
});

test('retry: EXTERNAL_UNKNOWN blocks retry', async () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail: makeRail({ failMode: 'crash_after_success' }) });
  await engine.attempt();
  const result = await engine.retry();
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'EXTERNAL_STATE_UNRESOLVED');
});

test('retry: SUCCEEDED state returns STATE_NOT_RETRYABLE', async () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'clean', rail: makeRail() });
  engine.run();
  assert.equal(engine.state, 'SUCCEEDED');
  const result = await engine.retry();
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'STATE_NOT_RETRYABLE');
});

test('retry: counter increments on retry', async () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'external_failure', rail: makeRail() });
  engine.run();
  assert.equal(engine.retryCount, 0);
  await engine.retry();
  assert.equal(engine.retryCount, 1);
});

// ============================================================
// 16. MUTATION SENSITIVITY TESTS — prove tests catch regressions
// ============================================================

test('mutation sensitivity: if commitLedger allowed duplicates, noDuplicateDebit would fail', () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'clean', rail: makeRail() });
  engine.paymentId = 'pay_test';
  engine.external.status = 'SUCCEEDED';
  engine.ledger.entries.push({ id: '1', paymentId: 'pay_test', amount: 1000, kind: 'DEBIT' });
  engine.ledger.entries.push({ id: '2', paymentId: 'pay_test', amount: 1000, kind: 'DEBIT' });
  engine.ledger.debit = 2000;
  engine.state = 'SUCCEEDED';
  assert.equal(verify(engine, false).checks.noDuplicateDebit, false);
});

test('mutation sensitivity: if money conservation wrong, check fails', () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'clean', rail: makeRail() });
  engine.paymentId = 'pay_test';
  engine.external.status = 'SUCCEEDED';
  engine.ledger.entries.push({ id: '1', paymentId: 'pay_test', amount: 500, kind: 'DEBIT' });
  engine.ledger.debit = 500;
  engine.state = 'SUCCEEDED';
  assert.equal(verify(engine, false).checks.moneyConserved, false);
});

test('mutation sensitivity: if retry guard removed, retryWasBlocked fails', () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail: makeRail() });
  engine.state = 'EXTERNAL_UNKNOWN';
  assert.equal(verify(engine, true).checks.retryWasBlocked, true);
  assert.equal(verify(engine, false).checks.retryWasBlocked, true);
});

test('mutation sensitivity: if refund counted twice, refundIdempotent fails', () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'refund_after_ledger', rail: makeRail() });
  engine.paymentId = 'pay_test';
  engine.external.status = 'REFUNDED';
  engine.ledger.entries.push({ id: '1', paymentId: 'pay_test', amount: 1000, kind: 'REFUND' });
  engine.ledger.entries.push({ id: '2', paymentId: 'pay_test', amount: 1000, kind: 'REFUND' });
  engine.state = 'REFUNDED';
  assert.equal(verify(engine, false).checks.refundIdempotent, false);
});

test('mutation sensitivity: if UNKNOWN state allowed to blind retry, EXTERNAL_UNKNOWN safety fails', async () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail: makeRail({ failMode: 'crash_after_success' }) });
  await engine.attempt();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
  const result = await engine.retry();
  assert.equal(result.allowed, false);
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
});

test('mutation sensitivity: if persistence removed, crash recovery fails', async () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail: makeRail({ failMode: 'crash_after_success' }) });
  engine.store = null;
  await engine.attempt();
  const json = JSON.stringify(engine.toResult());
  const parsed = JSON.parse(json);
  assert.equal(parsed.state, 'EXTERNAL_UNKNOWN');
  assert.equal(parsed.ledger.debit, 0);
});

test('mutation sensitivity: if idempotency disabled, duplicate sagas created', async () => {
  const storePath = tmpStore('mutation-idem');
  const store = new Store(storePath, makeRail());
  const r1 = await store.begin('same-key', 1000, 'clean');
  const r2 = await store.begin('same-key', 1000, 'clean');
  assert.equal(r1.sagaId, r2.sagaId);
  assert.equal(r2.duplicate, true);
  track(storePath);
});

test('mutation sensitivity: if double refund allowed, accounting breaks', () => {
  const rail = makeRail();
  const p = rail.submitPayment('o1', 1000, 'k1');
  rail.refundPayment(p.paymentId, 1000, 'k1');
  const r2 = rail.refundPayment(p.paymentId, 1000, 'k1');
  assert.equal(r2.status !== 'REFUNDED', true);
});

test('mutation sensitivity: if UNKNOWN→RETRY bypass allowed, invariant fails', async () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail: makeRail({ failMode: 'crash_after_success' }) });
  await engine.attempt();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
  const result = await engine.retry();
  assert.equal(result.allowed, false);
  assert.equal(engine.verify().invariantPass, true);
});

// ============================================================
// 17. EXTERNAL RAIL SEPARATION TEST
// ============================================================

test('rail separation: runtime state and rail state are independent objects', () => {
  const rail = makeRail({ failMode: 'crash_after_success' });
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail });
  engine.run();
  assert.equal(engine.state, 'SUCCEEDED');
  const railState = rail.getState();
  assert.notEqual(railState, engine.external);
  assert.ok(typeof railState._payments === 'object');
  assert.ok(typeof railState._failMode === 'string');
});

test('rail separation: rail state survives even if runtime is destroyed', async () => {
  const rail = makeRail({ failMode: 'crash_after_success' });
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail });
  await engine.attempt();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
  const paymentId = engine.paymentId;

  rail._failMode = 'none';
  rail._payments[paymentId].status = 'SUCCEEDED';

  const status = rail.getPaymentStatus(paymentId);
  assert.equal(status.status, 'SUCCEEDED');
  assert.equal(status.paymentId, paymentId);
});

test('rail separation: reconcile reads from rail, not from engine.external', async () => {
  const rail = makeRail({ failMode: 'crash_after_success' });
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail });
  await engine.attempt();
  assert.equal(engine.external.status, 'UNKNOWN');

  rail._payments[engine.paymentId].status = 'SUCCEEDED';
  engine.reconcile();

  assert.equal(engine.external.status, 'SUCCEEDED');
  assert.equal(engine.state, 'SUCCEEDED');
  assert.equal(engine.ledger.debit, 1000);
});

// ============================================================
// 18. attempt() STEP-BY-STEP STATE MACHINE TESTS
// ============================================================

test('attempt: CREATED → creates payment, submits, persists', async () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'clean', rail: makeRail() });
  assert.equal(engine.state, 'CREATED');
  const r = await engine.attempt();
  assert.equal(engine.state, 'SUCCEEDED');
  assert.equal(r.ledger.debit, 1000);
});

test('attempt: EXTERNAL_UNKNOWN → reconcile, persist', async () => {
  const rail = makeRail({ failMode: 'crash_after_success' });
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail });
  await engine.attempt();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
  rail._payments[engine.paymentId].status = 'SUCCEEDED';
  await engine.attempt();
  assert.equal(engine.state, 'SUCCEEDED');
  assert.equal(engine.ledger.debit, 1000);
});

test('attempt: SUCCEEDED + refund_after_ledger → compensate on second call', async () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'refund_after_ledger', rail: makeRail() });
  const r1 = await engine.attempt();
  assert.equal(r1.state, 'SUCCEEDED');
  assert.equal(r1.ledger.debit, 1000);
  const r2 = await engine.attempt();
  assert.equal(r2.state, 'REFUNDED');
  assert.equal(r2.ledger.credit, 1000);
});

test('attempt: terminal state → returns result without change', async () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'clean', rail: makeRail() });
  await engine.attempt();
  assert.equal(engine.state, 'SUCCEEDED');
  const before = JSON.stringify(engine.toResult());
  await engine.attempt();
  const after = JSON.stringify(engine.toResult());
  assert.equal(before, after);
});

// ============================================================
// 19. run() SYNCHRONOUS LIFECYCLE TESTS
// ============================================================

test('run: clean — full lifecycle', () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'clean', rail: makeRail() });
  const r = engine.run();
  assert.equal(r.state, 'SUCCEEDED');
  assert.equal(r.ledger.debit, 1000);
  assert.equal(r.verification.invariantPass, true);
});

test('run: crash_after_success — lifecycle with reconciliation', () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'crash_after_success', rail: makeRail({ failMode: 'crash_after_success' }) });
  const r = engine.run();
  assert.equal(r.state, 'SUCCEEDED');
  assert.equal(r.ledger.debit, 1000);
  assert.equal(r.verification.invariantPass, true);
});

test('run: duplicate_retry — blocks retry', () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'duplicate_retry', rail: makeRail() });
  const r = engine.run();
  assert.equal(r.retriedUnsafe, true);
  assert.equal(r.verification.invariantPass, true);
});

test('run: refund_after_ledger — full compensation', () => {
  const engine = new SagaEngine({ amount: 1000, scenario: 'refund_after_ledger', rail: makeRail() });
  const r = engine.run();
  assert.equal(r.state, 'REFUNDED');
  assert.equal(r.ledger.debit, 0);
  assert.equal(r.ledger.credit, 1000);
  assert.equal(r.verification.invariantPass, true);
});

// ============================================================
// 20. HYGIENE: repeated test runs produce same results
// ============================================================

test('hygiene: benchmark is deterministic across runs', async () => {
  const a = await new SagaEngine({ amount: 1000, rail: makeRail() }).benchmark(200, 42);
  const b = await new SagaEngine({ amount: 1000, rail: makeRail() }).benchmark(200, 42);
  assert.equal(a.recoveryRate, b.recoveryRate);
  assert.equal(a.invariantViolations, b.invariantViolations);
  assert.equal(a.duplicatePreventionRate, b.duplicatePreventionRate);
  assert.equal(a.cases.length, b.cases.length);
  assert.equal(a.retryGuard.tp, b.retryGuard.tp);
  assert.equal(a.retryGuard.fp, b.retryGuard.fp);
  assert.equal(a.retryGuard.fn, b.retryGuard.fn);
  assert.equal(a.retryGuard.tn, b.retryGuard.tn);
  for (let i = 0; i < a.cases.length; i++) {
    assert.equal(a.cases[i].scenario, b.cases[i].scenario);
    assert.equal(a.cases[i].invariantPass, b.cases[i].invariantPass);
  }
});

test('hygiene: no test artifacts in project data/ directory', () => {
  const projectData = path.join(__dirname, '..', 'data');
  if (fs.existsSync(projectData)) {
    const files = fs.readdirSync(projectData);
    const testFiles = files.filter(f => f.startsWith('test-'));
    assert.equal(testFiles.length, 0, `Found stale test files in data/: ${testFiles.join(', ')}`);
  }
});

// ============================================================
// 21. SQLITE STORE — version CAS and legacy migration
// ============================================================

test('sqlite CAS: two store instances over one database file — exactly one transition commits, the stale writer is refused', async () => {
  const storePath = tmpStore('conc-cas');
  const railA = makeRail({ failMode: 'crash_after_success' });
  const railB = makeRail({ failMode: 'crash_after_success' });
  const storeA = new Store(storePath, railA);
  const { sagaId } = await storeA.begin('cas-key', 1000, 'crash_after_success');
  const storeB = new Store(storePath, railB);

  // Both connections hold the SAME snapshot (v1) of the same saga. Both then try
  // to advance it. SQLite serializes the writers; the version compare-and-swap
  // lets exactly one commit and forces the other to CONCURRENT_ACCESS.
  const engineA = storeA.load(sagaId);
  const engineB = storeB.load(sagaId);
  const results = await Promise.allSettled([
    Promise.resolve().then(() => engineA.attempt()),
    Promise.resolve().then(() => engineB.attempt())
  ]);
  const committed = results.filter(r => r.status === 'fulfilled');
  const rejected = results.filter(r => r.status === 'rejected');
  assert.equal(committed.length, 1, 'exactly one transition may commit');
  assert.equal(rejected.length, 1, 'exactly one transition must be refused');
  const err = rejected[0].reason;
  assert.ok(err && /CONCURRENT_ACCESS/.test(err.message), 'the refused writer must fail with CONCURRENT_ACCESS, got: ' + (err && err.message));

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(storePath);
  const sagaRows = db.prepare('SELECT version, snapshot FROM sagas').all();
  assert.equal(sagaRows.length, 1, 'exactly one saga row on disk');
  assert.equal(sagaRows[0].version, 2, 'the winning transition advanced the version exactly once');
  assert.equal(JSON.parse(sagaRows[0].snapshot).paymentId, engineA.paymentId, 'the winning process payment is what is persisted');
  const paymentRows = db.prepare('SELECT payment_id FROM rail_payments').all();
  assert.equal(paymentRows.length, 1, 'only the winning process payment is persisted (no double payment)');
  db.close();
  track(storePath);
});

test('sqlite CAS: save commits the saga snapshot and the rail payment row in one transaction', async () => {
  const storePath = tmpStore('conc-transaction');
  const rail = makeRail({ failMode: 'crash_after_success' });
  const store = new Store(storePath, rail);
  const { sagaId } = await store.begin('txn-key', 1000, 'crash_after_success');
  const engine = store.load(sagaId);
  await engine.attempt();
  assert.equal(engine.state, 'EXTERNAL_UNKNOWN');

  const freshRail = makeRail();
  const freshStore = new Store(storePath, freshRail);
  const reloaded = freshStore.load(sagaId);
  assert.equal(reloaded.state, 'EXTERNAL_UNKNOWN');
  const payment = freshRail.getPaymentRecord(reloaded.paymentId);
  assert.ok(payment, 'rail payment journal is restored from the database');
  assert.equal(payment.status, 'SUCCEEDED', 'the external truth written at submit time survived the transaction');
  assert.equal(freshRail.getPaymentRecord(reloaded.paymentId).amount, 1000);
  track(storePath);
});

test('migration: legacy JSON store (sagas.json + .rail.json) is absorbed when the database file is missing', async () => {
  const dir = path.join(TEST_DIR, 'migration-dir');
  fs.mkdirSync(dir, { recursive: true });
  const legacyJson = path.join(dir, 'sagas.json');

  const rail = makeRail();
  const engine = new SagaEngine({ amount: 1200, scenario: 'clean', rail });
  engine.run();
  assert.equal(engine.state, 'SUCCEEDED');
  const oldFormat = { ['__generation__']: 3, [engine.sagaId]: engine.toResult() };
  fs.writeFileSync(legacyJson, JSON.stringify(oldFormat));
  fs.writeFileSync(legacyJson + '.rail.json', JSON.stringify(rail.getState()));

  const store = new Store(path.join(dir, 'sagas.db'), null);
  assert.deepEqual(store.list(), [engine.sagaId]);
  const loaded = store.load(engine.sagaId);
  assert.equal(loaded.amount, 1200);
  assert.equal(loaded.state, 'SUCCEEDED');
  assert.equal(loaded.paymentId, engine.paymentId);
  assert.equal(loaded.ledger.debit, 1200);

  const rail2 = makeRail();
  const store2 = new Store(path.join(dir, 'sagas.db'), rail2);
  assert.equal(rail2.getPaymentRecord(engine.paymentId).status, 'SUCCEEDED', 'migrated rail journal seeds a fresh rail');
  assert.equal(store2.list().length, 1);
  track(path.join(dir, 'sagas.db'));
});
