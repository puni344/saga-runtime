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

// ============================================================
// Regression: a forged saga claiming SUCCEEDED with a zero ledger and a
// non-SUCCEEDED external status must NOT verify PASS. validTerminalState only
// checks the state string; stateLedgerConsistent cross-checks the ledger and
// external status. Reproduces the white-box exploit found via direct object
// construction (state='SUCCEEDED', empty ledger, external != SUCCEEDED).
// ============================================================

test('verifier: stateLedgerConsistent rejects a forged SUCCEEDED saga with zero ledger and non-SUCCEEDED external status', () => {
  const forged = (externalStatus) => ({
    state: 'SUCCEEDED',
    amount: 4999,
    external: { status: externalStatus },
    review: null,
    paymentId: null,
    orderId: null,
    ledger: { debit: 0, credit: 0, entries: [] }
  });

  for (const external of ['FAILED', 'NOT_CREATED', 'UNKNOWN']) {
    const r = verify(forged(external), false);
    assert.equal(r.status, 'FAIL', `SUCCEEDED with zero ledger, external=${external} must fail, not pass`);
    assert.equal(r.invariantPass, false);
    assert.equal(r.checks.stateLedgerConsistent, false, 'the named cross-check must be the one that fails');
    assert.equal(r.checks.validTerminalState, true, 'state string alone still looks terminal - the gap is the cross-check');
  }

  const legit = verify({
    state: 'SUCCEEDED',
    amount: 4999,
    external: { status: 'SUCCEEDED' },
    review: null,
    paymentId: 'pay_x',
    orderId: 'ord_x',
    ledger: { debit: 4999, credit: 0, entries: [{ id: '1', kind: 'DEBIT', amount: 4999, paymentId: 'pay_x' }] }
  }, false);
  assert.equal(legit.status, 'PASS', 'a real SUCCEEDED saga with one debit and SUCCEEDED external must keep passing');
  assert.equal(legit.checks.stateLedgerConsistent, true);
});

test('verifier: stateLedgerConsistent requires a matching REFUND for REFUNDED and no net money for FAILED', () => {
  const stateLedgerConsistent = (state, debitCount, refundCount) => {
    const entries = [];
    for (let i = 0; i < debitCount; i++) entries.push({ id: 'd' + i, kind: 'DEBIT', amount: 4999, paymentId: 'pay' + i });
    for (let i = 0; i < refundCount; i++) entries.push({ id: 'r' + i, kind: 'REFUND', amount: 4999, paymentId: 'pay0' });
    const r = verify({
      state,
      amount: 4999,
      external: { status: state },
      review: null,
      paymentId: 'pay0',
      orderId: null,
      ledger: { debit: debitCount * 4999, credit: refundCount * 4999, entries }
    }, false);
    return r.checks.stateLedgerConsistent;
  };

  assert.equal(stateLedgerConsistent('REFUNDED', 1, 1), true, 'REFUNDED needs a DEBIT and a matching REFUND');
  assert.equal(stateLedgerConsistent('REFUNDED', 1, 0), false, 'REFUNDED with no refund is a forged success');
  assert.equal(stateLedgerConsistent('FAILED', 0, 0), true, 'FAILED with no money moved is valid');
  assert.equal(stateLedgerConsistent('FAILED', 1, 1), true, 'FAILED with a fully-reversed debit is valid');
  assert.equal(stateLedgerConsistent('FAILED', 1, 0), false, 'FAILED with an unreversed debit is not consistent');
});

function crypto() { return Math.random().toString(36).slice(2, 8); }