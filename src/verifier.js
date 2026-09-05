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
  checks.noDuplicateDebit = debitEntries.length <= 1;
  checks.moneyConserved = saga.external.status === 'UNKNOWN' || debitTotal - refundTotal === (saga.external.status === 'SUCCEEDED' ? saga.amount : 0);
  checks.validTerminalState = isSafeUnresolved || TERMINAL_STATES.has(saga.state);
  checks.stateConsistent = VALID_STATES.has(saga.state);
  checks.retryWasBlocked = retryAttempted ? (saga.state === 'EXTERNAL_UNKNOWN') : true;
  checks.refundIdempotent = refundEntries.length <= 1;
  checks.oneDebitPerPayment = new Set(debitEntries.map(e => e.paymentId)).size === debitEntries.length;
  // invariantPass covers the financial/state invariants only. retryWasBlocked is a separate
  // runtime safety check: policy enforcement is not a monetary invariant, so it is reported
  // in `checks` but not folded into `invariantPass`. Both are needed for a safe execution path,
  // and invariantPass = true alone does not prove retry safety (retry safety is tested separately
  // by the retry guard and the unlabeled retry-guard recall sweep).
  const financialInvariants = [checks.noDuplicateDebit, checks.moneyConserved, checks.validTerminalState, checks.stateConsistent, checks.refundIdempotent, checks.oneDebitPerPayment];
  const invariantPass = financialInvariants.every(Boolean);
  return { invariantPass, checks };
}

module.exports = { verify, VALID_STATES, TERMINAL_STATES, VALID_TRANSITIONS };
