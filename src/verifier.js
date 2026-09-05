const VALID_STATES = new Set([
  'CREATED', 'AUTHORIZED', 'PROCESSING', 'EXTERNAL_UNKNOWN',
  'RECONCILING', 'SUCCEEDED', 'COMPENSATING', 'REFUNDED', 'FAILED'
]);
const TERMINAL_STATES = new Set(['SUCCEEDED', 'REFUNDED', 'FAILED']);
const VALID_TRANSITIONS = {
  CREATED: ['AUTHORIZED'],
  AUTHORIZED: ['PROCESSING'],
  PROCESSING: ['EXTERNAL_UNKNOWN', 'SUCCEEDED', 'FAILED'],
  EXTERNAL_UNKNOWN: ['RECONCILING', 'FAILED'],
  RECONCILING: ['SUCCEEDED', 'EXTERNAL_UNKNOWN', 'FAILED'],
  SUCCEEDED: ['COMPENSATING'],
  COMPENSATING: ['REFUNDED', 'FAILED', 'EXTERNAL_UNKNOWN'],
  REFUNDED: [],
  FAILED: []
};

function verify(saga, retryAttempted) {
  const checks = {};
  const debitEntries = saga.ledger.entries.filter(e => e.kind === 'DEBIT');
  const refundEntries = saga.ledger.entries.filter(e => e.kind === 'REFUND');
  const debitTotal = debitEntries.reduce((s, e) => s + e.amount, 0);
  const refundTotal = refundEntries.reduce((s, e) => s + e.amount, 0);
  const isSafeUnresolved = saga.state === 'EXTERNAL_UNKNOWN' && (retryAttempted || saga.external.status === 'UNKNOWN');
  // A saga correctly paused at CREATED behind a PENDING human review gate is a lawful
  // resting state, not a failure. Pause is verified from state, never assumed: it
  // requires a PENDING review, no rail payment ever created, no external fact, and no
  // debit/refund entry or ledger sum. Any of those present under a PENDING gate is a
  // genuine inconsistency and stays FAIL, not a pause.
  const isReviewPaused =
    saga.state === 'CREATED' &&
    !!saga.review &&
    saga.review.status === 'PENDING' &&
    saga.external.status === 'NOT_CREATED' &&
    !saga.paymentId &&
    !saga.orderId &&
    debitEntries.length === 0 &&
    refundEntries.length === 0 &&
    saga.ledger.debit === 0 &&
    saga.ledger.credit === 0;
  checks.noDuplicateDebit = debitEntries.length <= 1;
  checks.moneyConserved = saga.external.status === 'UNKNOWN' || debitTotal - refundTotal === (saga.external.status === 'SUCCEEDED' ? saga.amount : 0);
  checks.validTerminalState = isSafeUnresolved || TERMINAL_STATES.has(saga.state);
  checks.validPausedState = isReviewPaused;
  checks.stateConsistent = VALID_STATES.has(saga.state);
  // validTerminalState only checks that the state string is terminal; it does not
  // cross-check the ledger or external status. A forged saga claiming SUCCEEDED with a
  // zero ledger and a non-SUCCEEDED external status would otherwise verify PASS. This
  // named check closes that gap: a terminal state must be consistent with the entries
  // that produced it and with the external truth. Non-terminal states are unaffected.
  checks.stateLedgerConsistent = (() => {
    if (saga.state === 'SUCCEEDED') {
      return debitEntries.length === 1 && saga.external.status === 'SUCCEEDED';
    }
    if (saga.state === 'REFUNDED') {
      return debitEntries.length === 1 && refundEntries.length === 1 && debitTotal === refundTotal;
    }
    if (saga.state === 'FAILED') {
      return debitTotal - refundTotal === 0;
    }
    return true;
  })();
  checks.retryWasBlocked = retryAttempted ? (saga.state === 'EXTERNAL_UNKNOWN') : true;
  checks.refundIdempotent = refundEntries.length <= 1;
  checks.oneDebitPerPayment = new Set(debitEntries.map(e => e.paymentId)).size === debitEntries.length;
  // invariantPass covers the financial/state invariants plus resting-state validity
  // (a saga must be settled, safely unresolved, or lawfully paused). retryWasBlocked is a
  // separate runtime safety check: policy enforcement is not a monetary invariant, so it is
  // reported in `checks` but not folded into `invariantPass`. Both are needed for a safe
  // execution path, and invariantPass = true alone does not prove retry safety (retry safety
  // is tested separately by the retry guard and the unlabeled retry-guard recall sweep).
  const moneyStateChecks = [checks.noDuplicateDebit, checks.moneyConserved, checks.stateConsistent, checks.stateLedgerConsistent, checks.refundIdempotent, checks.oneDebitPerPayment];
  const restingValid = checks.validTerminalState || checks.validPausedState;
  const invariantPass = moneyStateChecks.every(Boolean) && restingValid;
  // status is what callers render. PASS = settled clean. AWAITING_REVIEW = verified (a),
  // lawfully parked at CREATED behind a PENDING gate with zero money movement — safe and
  // waiting, explicitly NOT a pass-over of a failure. FAIL = a genuine invariant violation,
  // or a saga resting in a state it has no right to (no gate, or money touched while gated).
  let status;
  if (checks.validPausedState) {
    status = moneyStateChecks.every(Boolean) ? 'AWAITING_REVIEW' : 'FAIL';
  } else {
    status = invariantPass ? 'PASS' : 'FAIL';
  }
  return { invariantPass, status, checks };
}

module.exports = { verify, VALID_STATES, TERMINAL_STATES, VALID_TRANSITIONS };
