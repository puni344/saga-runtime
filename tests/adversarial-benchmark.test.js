const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const os = require('os');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { ATTACK_CLASSES, adversarialCases, runAdversarialBenchmark, EXECUTION_ATTACKS } = require('../src/ai/adversarial-benchmark');
const { Store } = require('../src/store');
const { PaymentRailSimulator } = require('../src/rail');

const root = path.join(__dirname, '..');

test('adversarial benchmark: every case carries a documented attack class', () => {
  const classIds = new Set(ATTACK_CLASSES.map(a => a.id));
  for (const c of adversarialCases) {
    assert.ok(classIds.has(c.attackClass), `${c.id}: unknown attack class ${c.attackClass}`);
  }
  assert.ok(adversarialCases.length === 15, 'benchmark must span the full 15-case matrix');
});

test('adversarial benchmark: every execution attack carries a guard statement', () => {
  assert.equal(EXECUTION_ATTACKS.length, 5, 'five execution guards attacked');
  for (const a of EXECUTION_ATTACKS) {
    assert.ok(a.id && a.name && a.attack && a.guardStatement, a.id + ': incomplete documentation');
  }
});

test('adversarial benchmark: every case name is non-empty', () => {
  for (const c of adversarialCases) assert.ok(c.name && typeof c.name === 'string', c.id + ': missing name');
});

test('adversarial benchmark: every documented mechanism statement holds', () => {
  const results = runAdversarialBenchmark();
  const failed = results.filter(r => !r.statementHeld);
  assert.equal(failed.length, 0, failed.map(f => `${f.id}: ${f.violation}`).join('\n'));
});

test('adversarial benchmark: ALLOW cases debit exactly the authorized request amount, never the smuggled amount', async () => {
  const tmpDir = path.join(os.tmpdir(), 'adv-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(tmpDir, { recursive: true });
  const store = new Store(path.join(tmpDir, 'adv.db'), new PaymentRailSimulator());
  try {
    for (const c of adversarialCases.filter(c => !c.violatesHardRule && c.expectedOutcome === 'ALLOW')) {
      const begun = store.begin('adv-' + c.id, c.request.amount, 'clean', {
        riskFlag: runAdversarialBenchmark([c])[0].riskFlag
      });
      const engine = store.load(begun.sagaId);
      await engine.attempt();
      assert.equal(engine.amount, c.request.amount, `${c.id}: saga amount must be the authorized request amount`);
      assert.equal(engine.ledger.debit, c.request.amount, `${c.id}: debit must equal the authorized amount`);
      const smuggled = c.aiResult.structured_intent && c.aiResult.structured_intent.expected_amount;
      if (smuggled !== undefined && smuggled !== c.request.amount) {
        assert.notEqual(engine.ledger.debit, smuggled, `${c.id}: smuggled amount must never be debited`);
      }
      assert.equal(engine.verify().invariantPass, true, `${c.id}: invariants must hold after attack input`);
      if (c.expectedReviewFlag) assert.equal(engine.riskFlag, c.expectedReviewFlag, `${c.id}: review flag expected`);
      const store2 = new Store(path.join(tmpDir, 'adv.db'), new PaymentRailSimulator());
      const reloaded = store2.load(begun.sagaId);
      assert.equal(reloaded.ledger.debit, c.request.amount, `${c.id}: debit survives reload`);
      store2.close();
    }
  } finally {
    store.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('adversarial benchmark: smuggled executable fields are never invoked and never surface in the decision', () => {
  let invoked = false;
  const poisoned = {
    risk_level: 'LOW_RISK', intent_clear: true, amount_consistent: true, requires_confirmation: false,
    reason_codes: ['CLEAR_AMOUNT'],
    submitPayment: () => { invoked = true; },
    commitLedger: () => { invoked = true; }
  };
  const decision = require('../src/ai/policy').validateAndEvaluatePolicy(poisoned, { instruction: 'Pay the invoice', amount: 3000 });
  assert.equal(decision.decision, 'ALLOW');
  assert.ok(!('submitPayment' in decision), 'decision must not carry executable AI fields');
  assert.ok(!('commitLedger' in decision), 'decision must not carry executable AI fields');
  assert.equal(invoked, false, 'AI-provided functions must never be invoked');
});

test('adversarial benchmark: AI output itself is validated as data (functions dropped by JSON contract)', () => {
  const { validateAIOutput } = require('../src/ai/schema');
  const poisoned = {
    risk_level: 'LOW_RISK', intent_clear: true, amount_consistent: true, requires_confirmation: false,
    reason_codes: ['CLEAR_AMOUNT'], submitPayment: () => {}
  };
  const v = validateAIOutput(poisoned);
  assert.equal(v.valid, true, 'schema validates data fields only');
});

function freePort() {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function startServer(port, dataDir) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root, env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited before healthy: ' + stderr);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return child;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not become healthy: ' + stderr);
}

async function stopChild(child) {
  if (child && child.exitCode === null) {
    try { child.kill('SIGKILL'); } catch {}
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
  }
}

async function post(port, endpoint, body) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: response.status, json: await response.json() };
}

test('adversarial benchmark end-to-end: BLOCK attacks create no saga; ALLOW attacks debit only the authorized amount', async () => {
  const port = await freePort();
  const tmpDir = path.join(os.tmpdir(), 'adv-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(tmpDir, { recursive: true });
  const child = await startServer(port, tmpDir);
  try {
    const blockCase = adversarialCases.find(c => c.id === 'SAFEGUARD_OVERRIDE_EXCEEDS_LIMIT');
    const resBlock = await post(port, '/api/analyze-and-begin', {
      instruction: blockCase.request.instruction, amount: blockCase.request.amount
    });
    assert.equal(resBlock.status, 200);
    assert.equal(resBlock.json.policy.decision, 'BLOCK');
    assert.equal(resBlock.json.saga, null, 'BLOCK attack must never create a saga');

    const smuggleCase = adversarialCases.find(c => c.id === 'AMOUNT_SMUGGLING_WITHIN_LIMIT');
    const resSmuggle = await post(port, '/api/analyze-and-begin', {
      instruction: smuggleCase.request.instruction, amount: smuggleCase.request.amount
    });
    assert.equal(resSmuggle.status, 200);
    assert.equal(resSmuggle.json.policy.decision, 'ALLOW');
    assert.equal(resSmuggle.json.saga.amount, 4999, 'authorized amount is authoritative');
    assert.equal(resSmuggle.json.saga.ledger.debit, 4999, 'debit follows the authorized amount');
    assert.notEqual(resSmuggle.json.saga.ledger.debit, 50, 'debit must never equal the smuggled expected_amount');
  } finally {
    await stopChild(child);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('adversarial benchmark end-to-end: REVIEW gates money until a verifier resolves it', async () => {
  const port = await freePort();
  const tmpDir = path.join(os.tmpdir(), 'adv-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(tmpDir, { recursive: true });
  const child = await startServer(port, tmpDir);
  try {
    const reviewCase = adversarialCases.find(c => c.id === 'SAFEGUARD_OVERRIDE_WITHIN_LIMIT');
    const res = await post(port, '/api/analyze-and-begin', {
      instruction: reviewCase.request.instruction, amount: reviewCase.request.amount
    });
    assert.equal(res.json.policy.decision, 'REVIEW');
    assert.equal(res.json.policy.riskFlag, 'HIGH_RISK');
    const saga = res.json.saga;
    assert.ok(saga, 'REVIEW must still create a saga');
    assert.equal(saga.state, 'CREATED', 'no money moves while review pending');
    assert.equal(saga.ledger.debit, 0, 'no debit while review pending');
    assert.equal(saga.paymentId, null, 'no provider payment while review pending');
    assert.equal(saga.review.status, 'PENDING', 'gate is pending');
    assert.ok(saga.review.requirements.includes('RISK_ADJUDICATION:HIGH_RISK'));

    const atk = await post(port, '/api/attempt', { sagaId: saga.sagaId });
    assert.equal(atk.json.state, 'CREATED', 'attempt without approval is refused');
    assert.equal(atk.json.ledger.debit, 0);

    const reviewsNow = await fetch(`http://127.0.0.1:${port}/api/reviews`).then(r => r.json());
    assert.ok(reviewsNow.some(r => r.sagaId === saga.sagaId), 'pending reviews are listed and awaitable');

    const denied = await post(port, '/api/review', { sagaId: saga.sagaId, decision: 'deny' });
    assert.equal(denied.json.saga.state, 'FAILED', 'denial terminates the saga before money moves');
    assert.equal(denied.json.saga.ledger.debit, 0, 'denied review never debits');

    const approveRow = await post(port, '/api/analyze-and-begin', {
      instruction: reviewCase.request.instruction, amount: reviewCase.request.amount
    });
    const approvedSagaId = approveRow.json.saga.sagaId;
    const approved = await post(port, '/api/review', { sagaId: approvedSagaId, decision: 'approve' });
    assert.equal(approved.json.saga.review.status, 'APPROVED', 'approve opens the gate');
    const ran = await post(port, '/api/attempt', { sagaId: approvedSagaId });
    assert.equal(ran.json.state, 'SUCCEEDED', 'approved review unlocks the exact money flow');
    assert.equal(ran.json.ledger.debit, reviewCase.request.amount);
  } finally {
    await stopChild(child);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

async function runExecutionAttack(a) {
  const tmpDir = path.join(os.tmpdir(), 'exec-' + a.id + '-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(tmpDir, { recursive: true });
  const store = new Store(path.join(tmpDir, 'exec.db'), new PaymentRailSimulator());
  const rail = store.rail;
  const summary = { state: null, debit: null, refunds: null, payments: null };
  try {
    if (a.id === 'EXEC_BLIND_RETRY_ON_UNKNOWN') {
      return await (async () => {
        const r = await store.begin('exec-blind', 1500, 'crash_after_success');
        let engine = store.load(r.sagaId);
        await engine.attempt();
        assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
        const paymentsBefore = Object.keys(rail.getState()._payments).length;
        const retry = await engine.retry();
        assert.equal(retry.allowed, false, 'blind retry must be refused');
        assert.equal(retry.reason, 'EXTERNAL_STATE_UNRESOLVED');
        assert.equal(Object.keys(rail.getState()._payments).length, paymentsBefore, 'refused retry must not mint a second provider payment');
        assert.equal(Object.keys(rail.getState()._payments).length, 1);
        await engine.reconcile();
        assert.equal(engine.state, 'SUCCEEDED');
        assert.equal(engine.ledger.debit, 1500);
        assert.equal(engine.verify().invariantPass, true);
        return { id: a.id, statementHeld: true, summary: 'retry refused → reconciled → one debit' };
      })();
    }
    if (a.id === 'EXEC_CRASH_AFTER_SUCCESS') {
      return await (async () => {
        const r = await store.begin('exec-crash', 2200, 'crash_after_success');
        const engine = store.load(r.sagaId);
        await engine.attempt();
        assert.equal(engine.state, 'EXTERNAL_UNKNOWN');
        await engine.reconcile();
        assert.equal(engine.state, 'SUCCEEDED');
        assert.equal(engine.ledger.debit, 2200);
        const stale = engine.applyEvent({ eventId: 'evt_late', providerPaymentId: engine.providerPaymentId, status: 'SUCCEEDED', amount: 2200 });
        assert.equal(stale.applied, false);
        assert.equal(engine.ledger.debit, 2200, 'stale late event cannot add a second debit');
        assert.equal(engine.verify().invariantPass, true);
        return { id: a.id, statementHeld: true, summary: 'crash reconciled → one debit, stale event inert' };
      })();
    }
    if (a.id === 'EXEC_STALE_WEBHOOK_AFTER_TERMINAL') {
      return await (async () => {
        const r = await store.begin('exec-stale', 900, 'clean');
        const engine = store.load(r.sagaId);
        await engine.attempt();
        assert.equal(engine.state, 'SUCCEEDED');
        assert.equal(engine.ledger.debit, 900);
        const stale = engine.applyEvent({ eventId: 'evt_late2', providerPaymentId: engine.providerPaymentId, status: 'SUCCEEDED', amount: 900 });
        assert.equal(stale.applied, false);
        assert.equal(engine.ledger.debit, 900, 'a duplicated delivery after terminal must not re-debit');
        return { id: a.id, statementHeld: true, summary: 'duplicate delivery after terminal was recorded, no re-debit' };
      })();
    }
    if (a.id === 'EXEC_CONCURRENT_ATTEMPT_RACE') {
      return await (async () => {
        const r = await store.begin('exec-race', 3100, 'crash_after_success');
        // Two callers race the same saga. Only one holds the in-process lock at a
        // time; the loser is either serialized or cleanly refused with
        // CONCURRENT_ACCESS (never corrupt). Either way exactly one provider
        // payment may be created and exactly one debit may land. A permissive
        // "run both blindly" driver would mint two payments — this is the guard.
        const outcomes = await Promise.all([
          Promise.resolve().then(() => store.withLock(r.sagaId, () => store.load(r.sagaId).attempt())).catch(e => ({ concurrent: e && e.code === 'CONCURRENT_ACCESS' })),
          Promise.resolve().then(() => store.withLock(r.sagaId, () => store.load(r.sagaId).attempt())).catch(e => ({ concurrent: e && e.code === 'CONCURRENT_ACCESS' }))
        ]);
        assert.ok(outcomes.every(o => o && typeof o === 'object' && !(o instanceof Error)), 'race must serialize or refuse cleanly, never corrupt');
        const afterRace = store.load(r.sagaId);
        assert.ok(['SUCCEEDED', 'EXTERNAL_UNKNOWN'].includes(afterRace.state), 'race midpoint is a money-safe state, never a double-debit state');
        assert.ok(afterRace.ledger.debit <= 3100, 'no debit may be minted twice during the race');
        assert.equal(Object.keys(rail.getState()._payments).length, 1, 'exactly one provider payment across the race');
        await afterRace.attempt();
        const final = store.load(r.sagaId);
        assert.equal(final.state, 'SUCCEEDED', 'the race converges to one terminal outcome');
        assert.equal(final.ledger.debit, 3100, 'exactly one debit across the race');
        assert.equal(Object.keys(rail.getState()._payments).length, 1, 'still exactly one provider payment at terminal');
        assert.equal(final.verify().invariantPass, true);
        return { id: a.id, statementHeld: true, summary: 'two attempts → one terminal state, one debit, one provider payment' };
      })();
    }
    if (a.id === 'EXEC_DOUBLE_REFUND') {
      return await (async () => {
        const r = await store.begin('exec-refund', 5000, 'clean');
        const engine = store.load(r.sagaId);
        await engine.attempt();
        assert.equal(engine.state, 'SUCCEEDED');
        engine.compensate('double fire');
        const onceRefunded = store.load(r.sagaId);
        onceRefunded.compensate('double fire again');
        const final = store.load(r.sagaId);
        const refunds = final.ledger.entries.filter(e => e.kind === 'REFUND').length;
        assert.equal(refunds, 1, 'a second compensate must not refund twice');
        assert.equal(final.state, 'REFUNDED');
        assert.equal(final.verify().invariantPass, true);
        return { id: a.id, statementHeld: true, summary: 'double compensate → exactly one refund, money conserved' };
      })();
    }
    return { id: a.id, statementHeld: false, violation: 'UNKNOWN_EXECUTION_ATTACK' };
  } finally {
    store.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

test('adversarial benchmark: all five execution attacks hold against the real runtime', async () => {
  for (const a of EXECUTION_ATTACKS) {
    const result = await runExecutionAttack(a);
    assert.ok(result.statementHeld, `${a.id} violated: ${result.summary}`);
  }
});