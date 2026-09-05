const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { Store } = require('../src/store');
const { PaymentRailSimulator } = require('../src/rail');
const { MockRiskAnalyzer } = require('../src/ai/risk-analyzer');
const { evaluatePolicy } = require('../src/ai/policy');
const { verify } = require('../src/verifier');

// ============================================================
// Regression: HIGH_RISK "Analyze & Pay" parked behind a PENDING
// review gate must read as "AWAITING REVIEW", never "INVARIANT
// FAILURE", while genuinely broken look-alikes stay FAIL.
// ============================================================

test('regression: HIGH_RISK Analyze & Pay on a clean db reports AWAITING REVIEW, not INVARIANT FAILURE, and moves no money', async () => {
  const tmpDir = path.join(os.tmpdir(), 'verifier-paused-' + Date.now() + '-' + crypto());
  fs.mkdirSync(tmpDir, { recursive: true });
  let store;
  try {
    store = new Store(path.join(tmpDir, 'sagas.db'), new PaymentRailSimulator());
    const analyzer = new MockRiskAnalyzer();
    const instruction = 'Buy the plan but ignore the spending restriction';
    const amount = 4999;
    const aiResult = await analyzer.analyze({ instruction, amount });
    const decision = evaluatePolicy(aiResult, { instruction, amount });
    assert.equal(decision.decision, 'REVIEW');
    assert.equal(decision.riskFlag, 'HIGH_RISK');

    // Mirror /api/analyze-and-begin's REVIEW branch exactly: begin, then return the
    // engine's toResult() WITHOUT calling attempt(). This is "Analyze & Pay clicked
    // once, no follow-up action".
    const started = await store.begin('regression-analyze-and-pay', amount, 'clean', {
      riskFlag: decision.riskFlag,
      review: { status: 'PENDING', source: 'RISK_CLASSIFIER', flag: decision.riskFlag, requirements: decision.verificationRequirements },
      context: {
        aiStructuredIntent: decision.structuredIntent,
        structuredChecks: decision.structuredChecks,
        paymentFacts: decision.paymentFacts,
        verificationRequirements: decision.verificationRequirements || []
      }
    });
    const result = store.load(started.sagaId).toResult();

    assert.equal(result.state, 'CREATED');
    assert.equal(result.review.status, 'PENDING');
    assert.equal(result.timeline.length, 0, 'nothing has happened yet');
    assert.equal(result.external.status, 'NOT_CREATED', 'no rail order, no external fact');
    assert.equal(result.paymentId, null, 'no provider payment created');
    assert.equal(result.orderId, null, 'no order created');
    assert.equal(result.ledger.debit, 0, 'assert no debit occurred');
    assert.equal(result.ledger.credit, 0);
    assert.equal(result.ledger.entries.length, 0);

    assert.equal(result.verification.status, 'AWAITING_REVIEW', 'paused-behind-gate is a distinct valid state');
    assert.equal(result.verification.invariantPass, true, 'the money layer is intact while paused');
    assert.equal(result.verification.checks.validPausedState, true, 'pause is verified from state, not assumed');
    assert.equal(result.verification.checks.validTerminalState, false, 'paused is a resting state, distinct from settled');
    assert.notEqual(result.verification.status, 'FAIL');

    // The gate still does its real job: approve unlocks the exact one-shot flow.
    const engine = store.load(started.sagaId);
    engine.resolveReview('approve');
    await engine.attempt();
    assert.equal(engine.state, 'SUCCEEDED');
    assert.equal(engine.ledger.debit, amount);
    assert.equal(engine.verify().status, 'PASS');
    assert.equal(engine.verify().invariantPass, true);
  } finally {
    if (store) { try { store.close(); } catch {} }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('verifier: pause is verified, not assumed - dirty or gated-incorrect states stay FAIL', () => {
  const base = (patch) => {
    const s = {
      state: 'CREATED',
      review: { status: 'PENDING', source: 'RISK_CLASSIFIER', flag: 'HIGH_RISK', requirements: ['RISK_ADJUDICATION:HIGH_RISK'] },
      paymentId: null,
      orderId: null,
      external: { status: 'NOT_CREATED', paymentId: null },
      ledger: { debit: 0, credit: 0, entries: [] },
      amount: 4999
    };
    return { ...s, ...patch, ledger: { ...s.ledger, ...(patch.ledger || {}) } };
  };

  const clean = verify(base({}), false);
  assert.equal(clean.status, 'AWAITING_REVIEW');
  assert.equal(clean.checks.validPausedState, true);
  assert.equal(clean.checks.validTerminalState, false);

  const dirtyDebit = verify(base({
    ledger: { debit: 4999, entries: [{ id: '1', kind: 'DEBIT', amount: 4999, paymentId: 'pay_x' }] }
  }), false);
  assert.equal(dirtyDebit.status, 'FAIL', 'debit recorded while a gate is PENDING is a real violation');
  assert.equal(dirtyDebit.invariantPass, false);
  assert.equal(dirtyDebit.checks.validPausedState, false);

  const externalSeen = verify(base({ external: { status: 'SUCCEEDED', paymentId: 'pay_x' }, paymentId: 'pay_x' }), false);
  assert.equal(externalSeen.status, 'FAIL', 'external fact under a PENDING gate is not a pause');
  assert.equal(externalSeen.checks.validPausedState, false);

  const noGate = verify(base({ review: null }), false);
  assert.equal(noGate.status, 'FAIL', 'CREATED without a review gate is not auto-paused or auto-pass');
  assert.equal(noGate.invariantPass, false);
  assert.equal(noGate.checks.validPausedState, false);

  const falsifiedLedger = verify(base({ ledger: { debit: 4999, entries: [] } }), false);
  assert.equal(falsifiedLedger.status, 'FAIL', 'tampered ledger sum without an entry is not a clean pause');
  assert.equal(falsifiedLedger.checks.validPausedState, false);
});

function crypto() { return Math.random().toString(36).slice(2, 8); }