const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sign } = require('../src/webhook');

const root = path.join(__dirname, '..');
const SECRET = 'webhook-test-secret';

async function waitForServer(port, child) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited before becoming healthy');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not become healthy');
}

async function startServer(port, dataDir, extraEnv = {}) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, WEBHOOK_SECRET: SECRET, ...extraEnv },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    await waitForServer(port, child);
    return child;
  } catch (error) {
    throw new Error(error.message + ': ' + stderr);
  }
}

async function stopChildren(children) {
  for (const c of children) {
    if (c && c.exitCode === null) {
      try { c.kill('SIGKILL'); } catch {}
      await Promise.race([once(c, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
  }
}

async function post(port, endpoint, body) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: response.status, json: await response.json() };
}

function signedBody(payload) {
  const body = JSON.stringify(payload);
  return { body, signature: sign(SECRET, body) };
}

async function postWebhook(port, payload, opts = {}) {
  const { body, signature } = signedBody(payload);
  const headers = { 'Content-Type': 'application/json' };
  if (!opts.badSignature) headers['x-webhook-signature'] = opts.signature || signature;
  else headers['x-webhook-signature'] = opts.signature || sign(SECRET + 'wrong', body);
  const response = await fetch(`http://127.0.0.1:${port}/webhooks/payment`, { method: 'POST', headers, body });
  return { status: response.status, json: await response.json() };
}

async function getSagas(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/sagas`);
  return response.json();
}

function debitCount(saga) {
  return saga.ledger.entries.filter(e => e.kind === 'DEBIT').length;
}

// ============================================================
// ITEM 3 — WEBHOOK / EVENT INGESTION BOUNDARY
// ============================================================

test('webhook: no secret configured — endpoint refuses (503), nothing ingested', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saga-webhook-nosecret-'));
  const port = 40000 + Math.floor(Math.random() * 1000);
  const child = await startServer(port, dataDir, { WEBHOOK_SECRET: '' });
  try {
    const payload = { eventId: 'evt_no_secret', providerPaymentId: 'pay_whatever', status: 'SUCCEEDED', amount: 1000 };
    const response = await fetch(`http://127.0.0.1:${port}/webhooks/payment`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-signature': sign('', JSON.stringify(payload)) }, body: JSON.stringify(payload)
    });
    assert.equal(response.status, 503);
  } finally {
    await stopChildren([child]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('webhook: valid captured event resolves EXTERNAL_UNKNOWN → SUCCEEDED with exactly one debit; replay is idempotent', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saga-webhook-ok-'));
  const port = 40100 + Math.floor(Math.random() * 1000);
  let child;
  try {
    child = await startServer(port, dataDir);
    const begun = await post(port, '/api/begin', { idempotencyKey: 'wh-ok', amount: 1500, scenario: 'crash_after_success' });
    const submitted = await post(port, '/api/attempt', { sagaId: begun.json.sagaId });
    const body = submitted.json;
    assert.equal(body.state, 'EXTERNAL_UNKNOWN');
    const providerPaymentId = body.providerPaymentId;

    const r1 = await postWebhook(port, { eventId: 'evt_1', providerPaymentId, status: 'SUCCEEDED', amount: 1500 });
    assert.equal(r1.status, 200);
    assert.equal(r1.json.applied, true);
    assert.equal(r1.json.state, 'SUCCEEDED');

    const sagas = await getSagas(port);
    const saga = sagas.find(s => s.sagaId === begun.json.sagaId);
    assert.equal(saga.state, 'SUCCEEDED');
    assert.equal(debitCount(saga), 1, 'exactly one debit after the webhook');
    assert.equal(saga.paymentIntentId, begun.json.paymentIntentId, 'intent unchanged by webhook');

    const r2 = await postWebhook(port, { eventId: 'evt_1', providerPaymentId, status: 'SUCCEEDED', amount: 1500 });
    assert.equal(r2.json.applied, false);
    assert.equal(r2.json.reason, 'DUPLICATE_EVENT');
    const sagas2 = await getSagas(port);
    assert.equal(debitCount(sagas2.find(s => s.sagaId === begun.json.sagaId)), 1, 'replay never adds a debit');
  } finally {
    await stopChildren([child]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('webhook: an invalid HMAC signature is refused with 401 and the saga never changes', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saga-webhook-bad-'));
  const port = 40200 + Math.floor(Math.random() * 1000);
  let child;
  try {
    child = await startServer(port, dataDir);
    const begun = await post(port, '/api/begin', { idempotencyKey: 'wh-bad', amount: 1000, scenario: 'crash_after_success' });
    const submitted = await post(port, '/api/attempt', { sagaId: begun.json.sagaId });
    const providerPaymentId = submitted.json.providerPaymentId;

    const r = await postWebhook(port, { eventId: 'evt_bad', providerPaymentId, status: 'SUCCEEDED', amount: 1000 }, { badSignature: true });
    assert.equal(r.status, 401);
    const sagas = await getSagas(port);
    const saga = sagas.find(s => s.sagaId === begun.json.sagaId);
    assert.equal(saga.state, 'EXTERNAL_UNKNOWN', 'unverified webhook must not change state');
    assert.equal(debitCount(saga), 0);
  } finally {
    await stopChildren([child]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('webhook: event for an unknown payment is recorded, never invents a debit; replay of same eventId is idempotent', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saga-webhook-unknown-'));
  const port = 40300 + Math.floor(Math.random() * 1000);
  let child;
  try {
    child = await startServer(port, dataDir);
    const r1 = await postWebhook(port, { eventId: 'evt_unknown', providerPaymentId: 'pay_nobody', status: 'SUCCEEDED', amount: 900 });
    assert.equal(r1.status, 200);
    assert.equal(r1.json.applied, false);
    assert.equal(r1.json.reason, 'UNKNOWN_PAYMENT');
    const r2 = await postWebhook(port, { eventId: 'evt_unknown', providerPaymentId: 'pay_nobody', status: 'SUCCEEDED', amount: 900 });
    assert.equal(r2.json.reason, 'DUPLICATE_EVENT');
    const events = await (await fetch(`http://127.0.0.1:${port}/api/events`)).json();
    const matching = events.events.filter(e => e.event_id === 'evt_unknown');
    assert.equal(matching.length, 1, 'exactly one event row despite two deliveries');
  } finally {
    await stopChildren([child]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('webhook: a stale event arriving after SUCCEEDED is recorded but never moves money again', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saga-webhook-stale-'));
  const port = 40400 + Math.floor(Math.random() * 1000);
  let child;
  try {
    child = await startServer(port, dataDir);
    const begun = await post(port, '/api/begin', { idempotencyKey: 'wh-stale', amount: 2000, scenario: 'clean' });
    const submitted = await post(port, '/api/attempt', { sagaId: begun.json.sagaId });
    const { providerPaymentId } = submitted.json;
    assert.equal(submitted.json.state, 'SUCCEEDED');

    const r = await postWebhook(port, { eventId: 'evt_stale', providerPaymentId, status: 'SUCCEEDED', amount: 2000 });
    assert.equal(r.json.applied, false);
    assert.equal(r.json.reason, 'STALE_EVENT');
    const sagas = await getSagas(port);
    const saga = sagas.find(s => s.sagaId === begun.json.sagaId);
    assert.equal(debitCount(saga), 1, 'stale event cannot double the debit');
  } finally {
    await stopChildren([child]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('webhook: an amount-mismatched event is recorded but NOT applied', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saga-webhook-amount-'));
  const port = 40500 + Math.floor(Math.random() * 1000);
  let child;
  try {
    child = await startServer(port, dataDir);
    const begun = await post(port, '/api/begin', { idempotencyKey: 'wh-amount', amount: 1000, scenario: 'crash_after_success' });
    const submitted = await post(port, '/api/attempt', { sagaId: begun.json.sagaId });
    const providerPaymentId = submitted.json.providerPaymentId;
    const r = await postWebhook(port, { eventId: 'evt_amount', providerPaymentId, status: 'SUCCEEDED', amount: 999999 });
    assert.equal(r.json.applied, false);
    assert.equal(r.json.reason, 'AMOUNT_MISMATCH');
    const sagas = await getSagas(port);
    assert.equal(sagas.find(s => s.sagaId === begun.json.sagaId).state, 'EXTERNAL_UNKNOWN');
  } finally {
    await stopChildren([child]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('webhook: a failed-capture event reconciles the saga to FAILED with no debit', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saga-webhook-fail-'));
  const port = 40600 + Math.floor(Math.random() * 1000);
  let child;
  try {
    child = await startServer(port, dataDir);
    const begun = await post(port, '/api/begin', { idempotencyKey: 'wh-fail', amount: 1000, scenario: 'crash_after_success' });
    const submitted = await post(port, '/api/attempt', { sagaId: begun.json.sagaId });
    const providerPaymentId = submitted.json.providerPaymentId;
    const r = await postWebhook(port, { eventId: 'evt_fail', providerPaymentId, status: 'FAILED', amount: 1000 });
    assert.equal(r.json.applied, true);
    const sagas = await getSagas(port);
    const saga = sagas.find(s => s.sagaId === begun.json.sagaId);
    assert.equal(saga.state, 'FAILED');
    assert.equal(debitCount(saga), 0);
  } finally {
    await stopChildren([child]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('webhook: an applied event survives SIGKILL — restart loads SUCCEEDED with one debit and the event row intact', { timeout: 15000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saga-webhook-kill-'));
  const port = 40700 + Math.floor(Math.random() * 1000);
  let child;
  try {
    child = await startServer(port, dataDir);
    const begun = await post(port, '/api/begin', { idempotencyKey: 'wh-kill', amount: 3000, scenario: 'crash_after_success' });
    const submitted = await post(port, '/api/attempt', { sagaId: begun.json.sagaId });
    const providerPaymentId = submitted.json.providerPaymentId;
    const r = await postWebhook(port, { eventId: 'evt_kill', providerPaymentId, status: 'SUCCEEDED', amount: 3000 });
    assert.equal(r.json.applied, true);
    assert.equal(r.json.state, 'SUCCEEDED');

    child.kill('SIGKILL');
    await once(child, 'exit');
    child = await startServer(port, dataDir);
    const sagas = await getSagas(port);
    const saga = sagas.find(s => s.sagaId === begun.json.sagaId);
    assert.equal(saga.state, 'SUCCEEDED', 'webhook outcome durable across process death');
    assert.equal(debitCount(saga), 1);
    const events = await (await fetch(`http://127.0.0.1:${port}/api/events`)).json();
    assert.ok(events.events.some(e => e.event_id === 'evt_kill'), 'event row is durably stored');
  } finally {
    await stopChildren([child]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('webhook: reconciliation attempt and webhook racing the same saga — exactly one debit', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saga-webhook-race-'));
  const port = 40800 + Math.floor(Math.random() * 1000);
  let child;
  try {
    child = await startServer(port, dataDir);
    const begun = await post(port, '/api/begin', { idempotencyKey: 'wh-race', amount: 2500, scenario: 'crash_after_success' });
    const submitted = await post(port, '/api/attempt', { sagaId: begun.json.sagaId });
    const providerPaymentId = submitted.json.providerPaymentId;

    const [attemptRes, webhookRes] = await Promise.all([
      post(port, '/api/attempt', { sagaId: begun.json.sagaId }).then(r => r.json),
      postWebhook(port, { eventId: 'evt_race', providerPaymentId, status: 'SUCCEEDED', amount: 2500 })
    ]);

    const sagas = await getSagas(port);
    const saga = sagas.find(s => s.sagaId === begun.json.sagaId);
    assert.equal(saga.state, 'SUCCEEDED');
    assert.equal(debitCount(saga), 1, 'race must still yield exactly one debit');
    assert.equal(saga.verification.invariantPass, true);
  } finally {
    await stopChildren([child]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('webhook: webhook channel and poll channel converge through the SAME reconcile()/commitLedger transition', async () => {
  const { Store } = require('../src/store');
  const { PaymentRailSimulator } = require('../src/rail');
  const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'converge-poll-'));
  const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'converge-webhook-'));
  const storeA = new Store(path.join(tmpA, 's.db'), new PaymentRailSimulator());
  const storeB = new Store(path.join(tmpB, 's.db'), new PaymentRailSimulator());
  try {
    const a = storeA.load((await storeA.begin('conv-a', 2500, 'crash_after_success')).sagaId);
    const b = storeB.load((await storeB.begin('conv-b', 2500, 'crash_after_success')).sagaId);
    await a.attempt();
    await b.attempt();
    assert.equal(a.state, 'EXTERNAL_UNKNOWN');
    assert.equal(b.state, 'EXTERNAL_UNKNOWN');

    const sig = 'hmac-sha256-convergence-signature';
    const applied = b.applyEvent({ eventId: 'evt_conv', providerPaymentId: b.providerPaymentId, status: 'SUCCEEDED', amount: 2500, signature: sig });
    assert.equal(applied.applied, true);
    await a.reconcile();

    assert.equal(a.state, 'SUCCEEDED');
    assert.equal(b.state, 'SUCCEEDED');
    const semantic = entries => entries.map(e => ({ kind: e.kind, amount: e.amount }));
    assert.deepEqual(semantic(b.ledger.entries), semantic(a.ledger.entries), 'webhook channel produces the same ledger semantics the poll channel produces');
    assert.equal(debitCount(a), 1);
    assert.equal(debitCount(b), 1);
    assert.deepEqual(b.ledger.entries.map(e => e.amount), [2500]);
    assert.equal(a.verify().invariantPass, true);
    assert.equal(b.verify().invariantPass, true);

    const events = storeB.listEvents();
    const row = events.find(e => e.event_id === 'evt_conv');
    assert.ok(row, 'webhook event is durably stored');
    assert.equal(row.signature, sig, 'the verified signature is stored per event for later audit');

    const after = storeB.load(b.sagaId);
    assert.equal(after.ledger.debit, 2500, 'reload sees the same converged outcome');
  } finally {
    storeA.close(); storeB.close();
    fs.rmSync(tmpA, { recursive: true, force: true });
    fs.rmSync(tmpB, { recursive: true, force: true });
  }
});

test('webhook: signature is stored per event and survives process restart', { timeout: 15000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saga-webhook-sig-'));
  const port = 40900 + Math.floor(Math.random() * 1000);
  let child;
  try {
    child = await startServer(port, dataDir);
    const begun = await post(port, '/api/begin', { idempotencyKey: 'wh-sig', amount: 1200, scenario: 'crash_after_success' });
    const submitted = await post(port, '/api/attempt', { sagaId: begun.json.sagaId });
    const providerPaymentId = submitted.json.providerPaymentId;
    const sig = sign(SECRET, JSON.stringify({ eventId: 'evt_sig', providerPaymentId, status: 'SUCCEEDED', amount: 1200 }));
    await postWebhook(port, { eventId: 'evt_sig', providerPaymentId, status: 'SUCCEEDED', amount: 1200 }, { signature: sig });

    const eventsBefore = await (await fetch(`http://127.0.0.1:${port}/api/events`)).json();
    assert.ok(eventsBefore.events.some(e => e.event_id === 'evt_sig' && e.signature === sig), 'signature present in live store');

    child.kill('SIGKILL');
    await once(child, 'exit');
    child = await startServer(port, dataDir);
    const eventsAfter = await (await fetch(`http://127.0.0.1:${port}/api/events`)).json();
    assert.ok(eventsAfter.events.some(e => e.event_id === 'evt_sig' && e.signature === sig), 'signature survives process restart');
  } finally {
    await stopChildren([child]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});