// Security / failure hardening suite.
//
// Fixes the three hardening gaps on the money boundary and proves the existing
// guards:
//
//   [G1] FAIL-LOUD CORRUPTION — a money ledger must refuse to start when its
//        persisted state is damaged, rather than silently pretending it is
//        empty (which could duplicate a debit later). Proved for a damaged
//        header, a corrupted schema page, a truncated database, and a saga
//        snapshot that no longer parses.
//
//   [G2] MALFORMED WEBHOOK EVENTS — a signed-but-ill-formed event (non-JSON,
//        missing required fields, or an impossible status value) must be
//        rejected without changing any saga state, creating a debit, or
//        crashing the process.
//
//   [G3] OVERSIZED REQUESTS — an attacker-controlled multi-megabyte body must
//        be rejected at the boundary (bounded memory, no parse, no mutation)
//        while the server stays available for legitimate traffic afterwards.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Store } = require('../src/store');
const { PaymentRailSimulator } = require('../src/rail');
const { sign } = require('../src/webhook');

const root = path.join(__dirname, '..');
const SECRET = 'hardening-test-secret';

function tmpName(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hard-' + label + '-'));
  return { dir, db: path.join(dir, 's.db') };
}

function makeStore(dbPath) { return new Store(dbPath, new PaymentRailSimulator()); }

// --------------------------------------------------------------------- G1
test('[G1] corrupted SQLite header -> PERSISTED_STATE_CORRUPT, never silent empty', () => {
  const { dir, db } = tmpName('g1h');
  fs.writeFileSync(db, Buffer.concat([Buffer.from('NOT A DATABASE AT ALL........'), Buffer.alloc(512, 7)]));
  assert.throws(() => makeStore(db), /PERSISTED_STATE_CORRUPT/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('[G1] valid database with a zeroed schema page -> refuse to open, never load clean', () => {
  const { dir, db } = tmpName('g1p');
  const store = makeStore(db);
  store.begin('k1', 1000, 'clean');
  store.close();
  const bytes = fs.readFileSync(db);
  // Keep the 16-byte SQLite header intact but destroy the schema page (page 1),
  // the exact region where the store's schema sanity query reads.
  const damaged = Buffer.from(bytes);
  damaged.fill(0, 16, Math.min(512, damaged.length));
  fs.writeFileSync(db, damaged);
  assert.throws(() => makeStore(db), /PERSISTED_STATE_CORRUPT/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('[G1] truncated database -> fails loudly, does not pretend it is empty', () => {
  const { dir, db } = tmpName('g1t');
  const store = makeStore(db);
  store.begin('k2', 2000, 'clean');
  store.close();
  const bytes = fs.readFileSync(db);
  fs.writeFileSync(db, bytes.slice(0, Math.floor(bytes.length / 2)));
  assert.throws(() => makeStore(db), /PERSISTED_STATE_CORRUPT/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('[G1] saga snapshot that no longer parses -> refuse on hydrate with PERSISTED_STATE_CORRUPT', () => {
  const { dir, db } = tmpName('g1s');
  const store = makeStore(db);
  const begun = store.begin('k3', 3000, 'clean');
  store.close();
  const raw = new DatabaseSync(db);
  raw.prepare('UPDATE sagas SET snapshot = ? WHERE saga_id = ?').run('{ this is not json', begun.sagaId);
  raw.close();
  assert.throws(() => makeStore(db), /PERSISTED_STATE_CORRUPT/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('[G1] a genuinely empty file still loads as an empty store (corrupt != empty)', () => {
  const { dir, db } = tmpName('g1e');
  fs.writeFileSync(db, '');
  const store = makeStore(db);
  assert.deepEqual(store.list(), []);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ----------------------------------------------------------------- HTTP helpers
async function waitForServer(port, child) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited');
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('server did not become healthy');
}

async function startServer(port, dataDir) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, WEBHOOK_SECRET: SECRET },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', c => { stderr += c; });
  try { await waitForServer(port, child); return child; }
  catch (e) { throw new Error(e.message + ': ' + stderr); }
}

async function stop(child) {
  if (child && child.exitCode === null) {
    try { child.kill('SIGKILL'); } catch {}
    await Promise.race([once(child, 'exit'), new Promise(r => setTimeout(r, 3000))]);
  }
}

async function post(port, endpoint, body) {
  const r = await fetch(`http://127.0.0.1:${port}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}

async function signedWebhook(port, rawBodyString) {
  const r = await fetch(`http://127.0.0.1:${port}/webhooks/payment`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-signature': sign(SECRET, rawBodyString) }, body: rawBodyString
  });
  return { status: r.status, json: await r.json() };
}

async function events(port) {
  const r = await fetch(`http://127.0.0.1:${port}/api/events`);
  return (await r.json()).events;
}

async function sagas(port) {
  const r = await fetch(`http://127.0.0.1:${port}/api/sagas`);
  return r.json();
}

function debitCount(s) { return (s.ledger?.entries || []).filter(e => e.type === 'debit').length; }

// --------------------------------------------------------------------- G2
test('[G2] signed non-JSON webhook -> 400 INVALID_JSON, nothing recorded, server alive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g2a-'));
  const port = 41100 + Math.floor(Math.random() * 800);
  const child = await startServer(port, dir);
  try {
    const r = await signedWebhook(port, '<script>alert(1)</script>');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /INVALID_JSON/);
    assert.equal((await events(port)).length, 0, 'malformed event must not be recorded');
    assert.equal((await sagas(port)).length, 0, 'no saga side effects');
  } finally { await stop(child); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('[G2] signed webhook missing required fields -> 400 EVENT_MISSING_FIELDS, nothing recorded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g2b-'));
  const port = 41100 + Math.floor(Math.random() * 800);
  const child = await startServer(port, dir);
  try {
    const r = await signedWebhook(port, JSON.stringify({ eventId: 'evt_partial', status: 'SUCCEEDED' }));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /EVENT_MISSING_FIELDS/);
    assert.equal((await events(port)).length, 0);
  } finally { await stop(child); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('[G2] signed webhook with an impossible status is absorbed, never crashes or moves money', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g2c-'));
  const port = 41100 + Math.floor(Math.random() * 800);
  const child = await startServer(port, dir);
  try {
    const begun = await post(port, '/api/begin', { idempotencyKey: 'g2-impossible', amount: 5000, scenario: 'crash_after_success' });
    const submitted = await post(port, '/api/attempt', { sagaId: begun.json.sagaId });
    assert.equal(submitted.json.state, 'EXTERNAL_UNKNOWN');
    assert.ok(submitted.json.providerPaymentId);

    const rw = await signedWebhook(port, JSON.stringify({ eventId: 'evt_surprise', providerPaymentId: submitted.json.providerPaymentId, status: 'NEVER_HAPPENED' }));
    assert.equal(rw.status, 200);
    assert.equal(rw.json.applied, false);
    assert.equal(rw.json.reason, 'STALE_EVENT');

    const list = await sagas(port);
    const saga = list.find(s => s.sagaId === begun.json.sagaId);
    assert.equal(saga.state, 'EXTERNAL_UNKNOWN', 'impossible status must not change state');
    assert.equal(debitCount(saga), 0, 'no debit from an impossible status');
    assert.equal((await events(port)).length, 1, 'the fact is recorded, the state is not');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200, 'process alive after absorbing the malformed event');
  } finally { await stop(child); fs.rmSync(dir, { recursive: true, force: true }); }
});

// --------------------------------------------------------------------- G3
test('[G3] oversized webhook body is cut at the boundary, never recorded, subsequent traffic works', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g3a-'));
  const port = 41100 + Math.floor(Math.random() * 800);
  const child = await startServer(port, dir);
  try {
    let outcome;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/webhooks/payment`, { method: 'POST', headers: { 'x-webhook-signature': 'x' }, body: 'A'.repeat(3 * 1024 * 1024) });
      outcome = r.status;
    } catch (e) { outcome = 'CONNECTION_CLOSED'; }
    assert.ok(outcome !== 200, 'oversized body must not be accepted (got: ' + outcome + ')');
    assert.equal((await events(port)).length, 0, 'nothing recorded');
    assert.equal((await sagas(port)).length, 0, 'no saga side effects');
    const after = await signedWebhook(port, JSON.stringify({ eventId: 'evt_after', providerPaymentId: 'pay_nobody', status: 'SUCCEEDED' }));
    assert.equal(after.json.reason, 'UNKNOWN_PAYMENT', 'legitimate webhook still accepted after the attack');
  } finally { await stop(child); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('[G3] oversized begin body creates no saga; server stays healthy for a real one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g3b-'));
  const port = 41100 + Math.floor(Math.random() * 800);
  const child = await startServer(port, dir);
  try {
    let outcome;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/begin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"amount":' + '1'.repeat(3 * 1024 * 1024) });
      outcome = r.status;
    } catch (e) { outcome = 'CONNECTION_CLOSED'; }
    assert.ok(outcome !== 200, 'oversized begin must not be accepted (got: ' + outcome + ')');
    assert.equal((await sagas(port)).length, 0, 'no saga created by the poisoned request');
    const legit = await post(port, '/api/begin', { idempotencyKey: 'g3-legit', amount: 1000, scenario: 'clean' });
    assert.equal(legit.status, 200);
    assert.equal((await sagas(port)).length, 1, 'server still serves legitimate traffic');
  } finally { await stop(child); fs.rmSync(dir, { recursive: true, force: true }); }
});