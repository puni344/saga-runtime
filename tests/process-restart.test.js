const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');

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

async function startServer(port, dataDir) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
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

async function post(port, endpoint, body) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function postRaw(port, endpoint, body) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: response.status, json: await response.json() };
}

async function stopChildren(children) {
  for (const c of children) {
    if (c && c.exitCode === null) {
      try { c.kill('SIGKILL'); } catch {}
      // Wait for the OS to release the process's open database handles before the
      // test removes the temp data directory (removal on Windows needs no live
      // handle). SIGKILL on Windows occasionally settles asynchronously.
      await Promise.race([once(c, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
  }
}

test('process restart: SIGKILL during reconciliation resumes from persisted saga and rail state', { timeout: 15000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saga-process-restart-'));
  const port = 35000 + Math.floor(Math.random() * 1000);
  let child;
  try {
    child = await startServer(port, dataDir);
    const begun = await post(port, '/api/begin', { idempotencyKey: 'restart-proof', amount: 1000, scenario: 'crash_during_reconciliation' });
    const submitted = await post(port, '/api/attempt', { sagaId: begun.sagaId });
    assert.equal(submitted.state, 'EXTERNAL_UNKNOWN');
    const checkpointed = await post(port, '/api/attempt', { sagaId: begun.sagaId });
    assert.equal(checkpointed.state, 'RECONCILING');

    child.kill('SIGKILL');
    await once(child, 'exit');
    child = await startServer(port, dataDir);
    const resumed = await post(port, '/api/attempt', { sagaId: begun.sagaId });
    assert.equal(resumed.state, 'SUCCEEDED');
    assert.equal(resumed.ledger.entries.filter(entry => entry.kind === 'DEBIT').length, 1);
    assert.equal(resumed.verification.invariantPass, true);
  } finally {
    await stopChildren([child]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('process restart: SIGKILL after crash_after_success recovers to SUCCEEDED with one debit', { timeout: 15000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saga-process-restart-cas-'));
  const port = 36000 + Math.floor(Math.random() * 1000);
  let child;
  try {
    child = await startServer(port, dataDir);
    const begun = await post(port, '/api/begin', { idempotencyKey: 'restart-cas', amount: 2000, scenario: 'crash_after_success' });

    // Submit: external payment succeeds on the rail, response is lost, saga lands in
    // EXTERNAL_UNKNOWN with the payment's true status persisted on the rail.
    const submitted = await post(port, '/api/attempt', { sagaId: begun.sagaId });
    assert.equal(submitted.state, 'EXTERNAL_UNKNOWN');
    assert.equal(submitted.paymentId != null, true);

    // Kill the process hard BEFORE any reconciliation. No same-process continuation
    // can exist: the only surviving state is the JSON files on disk.
    child.kill('SIGKILL');
    await once(child, 'exit');
    child = await startServer(port, dataDir);

    // A brand-new process reconciles against the persisted rail truth.
    const resumed = await post(port, '/api/attempt', { sagaId: begun.sagaId });
    assert.equal(resumed.state, 'SUCCEEDED');
    assert.equal(resumed.ledger.entries.filter(entry => entry.kind === 'DEBIT').length, 1);
    assert.equal(resumed.verification.invariantPass, true);
  } finally {
    await stopChildren([child]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('multi-process concurrency: two live servers racing the same saga fail cleanly (no ENOENT, no double payment), and the final state is well-defined', { timeout: 20000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saga-multiprocess-'));
  const portA = 38000 + Math.floor(Math.random() * 1000);
  const portB = 39100 + Math.floor(Math.random() * 1000);
  const children = [];
  try {
    const p1 = await startServer(portA, dataDir);
    children.push(p1);
    const begun = await post(portA, '/api/begin', { idempotencyKey: 'race', amount: 1234, scenario: 'crash_after_success' });

    // Restart so both live processes load the saga from disk AFTER it exists — the
    // store reads its file once at construction; a store born earlier can never see
    // it. Both processes must hold the same saga to be able to race it.
    p1.kill('SIGKILL');
    await once(p1, 'exit');
    const p1b = await startServer(portA, dataDir);
    children.push(p1b);
    const p2 = await startServer(portB, dataDir);
    children.push(p2);

    // Process 1 advances the saga to EXTERNAL_UNKNOWN and persists generation 2.
    const advanced = await post(portA, '/api/attempt', { sagaId: begun.sagaId });
    assert.equal(advanced.state, 'EXTERNAL_UNKNOWN');

    // Process 2 is stale: it loaded the saga in CREATED state. Its attempt would
    // create a SECOND payment and clobber process 1's snapshot, so its write must be
    // rejected by the generation check instead of silently overwriting (or surfacing
    // a raw ENOENT from a colliding temp file).
    const stale = await postRaw(portB, '/api/attempt', { sagaId: begun.sagaId });
    assert.notEqual(stale.status, 200, 'stale writer must not silently succeed');
    const msg = stale.json.error || '';
    assert.ok(msg.includes('CONCURRENT_ACCESS'), 'stale writer must fail with a CONCURRENT_ACCESS-style error, got: ' + msg);
    assert.ok(!msg.includes('ENOENT'), 'no raw filesystem error may surface to the caller');

    // Exactly one saga, exactly one rail payment: no double payment was persisted.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'sagas.db'));
    const sagaRows = db.prepare('SELECT saga_id, snapshot FROM sagas').all();
    assert.equal(sagaRows.length, 1, 'exactly one saga on disk');
    const paymentRows = db.prepare('SELECT * FROM rail_payments').all();
    assert.equal(paymentRows.length, 1, 'exactly one payment created on the rail');
    assert.equal(JSON.parse(sagaRows[0].snapshot).paymentId, advanced.paymentId, 'persisted saga keeps the winning process payment');
    db.close();

    // Final state is well-defined: a fresh process recovers deterministically.
    await stopChildren(children);
    children.length = 0;
    const p3 = await startServer(portA, dataDir);
    children.push(p3);
    const resumed = await post(portA, '/api/attempt', { sagaId: begun.sagaId });
    assert.equal(resumed.state, 'SUCCEEDED');
    assert.equal(resumed.ledger.entries.filter(entry => entry.kind === 'DEBIT').length, 1);
    assert.equal(resumed.ledger.debit, 1234);
    assert.equal(resumed.verification.invariantPass, true);
  } finally {
    await stopChildren(children);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
