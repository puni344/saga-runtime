const test = require('node:test');
const assert = require('node:assert/strict');
const { buildScorecard, policyMatrix, executionGuard, evalFrozen, gatedFlowRun } = require('../src/safety-scorecard');
const { adversarialCases } = require('../src/ai/adversarial-benchmark');

test('scorecard: AI/policy boundary row reflects the full adversarial matrix', () => {
  const p = policyMatrix();
  assert.equal(p.totalCases, adversarialCases.length);
  assert.equal(adversarialCases.length, 15, 'the matrix is 15 policy cases');
  assert.equal(p.heldEveryStatement, true, 'every documented mechanism statement holds');
  assert.ok(p.policyCaseCounts.reviewGated >= 1, 'at least one REVIEW case is gated');
  assert.ok(p.policyCaseCounts.hardBlocked >= 1, 'at least one BLOCK case');
  assert.ok(p.policyCaseCounts.allowedClean >= 1, 'at least one ALLOW case');
  assert.ok(p.hardRules.length, 'every hard rule is enumerated');
});

test('scorecard: execution guard row names every runtime attack', () => {
  const g = executionGuard();
  assert.equal(g.guards.length, 5);
  for (const a of g.guards) {
    assert.ok(a.id && a.guardStatement, 'each guard carries a documented statement');
  }
});

test('scorecard: frozen eval row is the documented frozen final-45 result', () => {
  const e = evalFrozen();
  assert.equal(e.accuracy, 0.8222);
  assert.equal(e.highRiskPrecision, 0.667);
  assert.equal(e.highRiskRecall, 0.75);
});

test('scorecard: gated money flow run proves REVIEW blocks money and exact one-shot after approval', () => {
  const r = gatedFlowRun(1500);
  assert.equal(r.holdsReviewBlocksMoney, true, 'review must freeze money');
  assert.equal(r.holdsExactOneShot, true, 'approve must unlock exactly one debit with invariants held');
  assert.equal(r.sequence.attemptedWhileGated.debit, 0);
  assert.equal(r.sequence.attemptedWhileGated.paymentId, null);
  assert.equal(r.sequence.afterApprove.review, 'APPROVED');
  assert.equal(r.sequence.afterAttempt.debit, 1500);
});

test('scorecard: buildScorecard produces the consolidated labeled sections', () => {
  const sc = buildScorecard();
  assert.ok(sc.generatedAt, 'has generated timestamp');
  const s = sc.sections;
  assert.ok(s['AI/policy boundary'].provenance);
  assert.ok(s['execution guards'].provenance);
  assert.equal(s['AI evaluation (frozen final-45)'].provenance, 'frozen-final-45');
  assert.ok(s['gated money flow (observed run)'].provenance, 'observed-single-run');
});