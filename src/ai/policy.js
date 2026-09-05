const { DECISIONS, RISK_LEVELS, REVIEW_REQUIREMENTS } = require('./schema');

const HARD_RULES = [
  {
    id: 'AMOUNT_POSITIVE',
    description: 'Amount must be positive and finite',
    check: (request) => {
      const amt = Number(request.amount);
      return Number.isFinite(amt) && amt > 0;
    },
    violation: 'AMOUNT_NOT_POSITIVE'
  },
  {
    id: 'AMOUNT_REASONABLE',
    description: 'Amount must not exceed 10,00,000 (10 lakh)',
    check: (request) => {
      const amt = Number(request.amount);
      return amt <= 1000000;
    },
    violation: 'AMOUNT_EXCEEDS_LIMIT'
  },
  {
    id: 'INSTRUCTION_EXISTS',
    description: 'Payment instruction must not be empty',
    check: (request) => {
      return typeof request.instruction === 'string' && request.instruction.trim().length > 0;
    },
    violation: 'EMPTY_INSTRUCTION'
  }
];

// Build the single authoritative set of payment facts. AI contributes only the
// fields marked (ai); the request amount is always the authoritative money
// figure — an AI disagreement is surfaced, never adopted.
function buildPaymentFacts(request, ai) {
  const si = ai && ai.structured_intent ? ai.structured_intent : {};
  return {
    requestedAmount: Number(request.amount),
    currency: typeof si.currency === 'string' && si.currency ? si.currency : 'INR',
    payee: si.payee || null,
    purpose: si.purpose || null,
    recurring: Boolean(si.recurring),
    urgency: si.urgency || null,
    authorityClaim: si.authority_claim || null,
    overrideLanguage: Boolean(si.override_language),
    ambiguitySources: Array.isArray(si.ambiguity) ? si.ambiguity : (si.ambiguity || null),
    confidence: Number.isFinite(Number(si.confidence)) ? Number(si.confidence) : null,
    aiExpectedAmount: si.expected_amount != null ? Number(si.expected_amount) : null
  };
}

// Deterministic translation of AI-extracted facts into verification gates. A gate
// means a human/automated verifier must clear the review before money moves. The
// gates themselves are pure functions of the facts and hard thresholds — an AI
// could not suppress them by claiming ALLOW.
function deriveVerificationRequirements(facts, ai) {
  const reqs = [];
  if (ai) {
    if (facts.overrideLanguage) reqs.push('OVERRIDE_CLAIM_VERIFICATION');
    if (facts.authorityClaim) reqs.push('AUTHORITY_VERIFICATION:' + facts.authorityClaim.toUpperCase());
    if (ai.risk_level === 'HIGH_RISK' || ai.requires_confirmation) reqs.push('RISK_ADJUDICATION:' + ai.risk_level);
    if (ai.risk_level === 'AMBIGUOUS') reqs.push('AMBIGUITY_RESOLUTION');
    if (facts.confidence != null && facts.confidence < 0.5) reqs.push('LOW_CONFIDENCE_REVIEW');
    if (facts.confidence != null && facts.confidence < 0.7 && facts.requestedAmount > 50000) reqs.push('LOW_CONFIDENCE_LARGE_AMOUNT_REVIEW');
  }
  return reqs;
}

function structuredIntentOf(aiResult) {
  if (!aiResult || !aiResult.structured_intent) return null;
  const si = aiResult.structured_intent;
  return {
    title: si.title || null,
    category: si.category || null,
    expected_amount: Number.isFinite(Number(si.expected_amount)) ? Number(si.expected_amount) : null,
    currency: si.currency || null,
    recurring: Boolean(si.recurring)
  };
}

function structuredChecksOf(aiResult, request) {
  const si = structuredIntentOf(aiResult);
  if (!si) return null;
  return {
    expectedAmountConsistent: si.expected_amount == null || si.expected_amount === Number(request.amount),
    currencySpecified: typeof si.currency === 'string' && si.currency.trim().length > 0
  };
}

function evaluatePolicy(aiResult, request) {
  const ruleViolations = [];
  for (const rule of HARD_RULES) {
    if (!rule.check(request)) {
      ruleViolations.push(rule.violation);
    }
  }

  const paymentFacts = buildPaymentFacts(request, aiResult);
  const verificationRequirements = deriveVerificationRequirements(paymentFacts, aiResult);

  if (ruleViolations.length > 0) {
    return {
      decision: 'BLOCK',
      reason: 'HARD_RULE_VIOLATION',
      ruleViolations,
      aiRiskLevel: aiResult ? aiResult.risk_level : null,
      paymentFacts,
      verificationRequirements: [],
      structuredIntent: structuredIntentOf(aiResult),
      structuredChecks: structuredChecksOf(aiResult, request),
      details: 'Deterministic policy blocked: ' + ruleViolations.join(', ')
    };
  }

  const riskFlag = !aiResult ? 'ANALYZER_UNAVAILABLE'
    : aiResult.risk_level === 'HIGH_RISK' ? 'HIGH_RISK'
      : (aiResult.risk_level === 'AMBIGUOUS' || aiResult.requires_confirmation) ? 'AMBIGUOUS' : null;
  const decision = verificationRequirements.length > 0 ? 'REVIEW' : 'ALLOW';
  return {
    decision,
    reason: verificationRequirements.length > 0 ? 'VERIFICATION_REQUIRED' : 'DETERMINISTIC_RULES_PASSED',
    ruleViolations: [],
    aiRiskLevel: aiResult ? aiResult.risk_level : null,
    riskFlag,
    reviewRequired: decision === 'REVIEW',
    paymentFacts,
    verificationRequirements,
    structuredIntent: structuredIntentOf(aiResult),
    structuredChecks: structuredChecksOf(aiResult, request),
    details: decision === 'REVIEW'
      ? 'Deterministic rules passed; verification gates required before money moves: ' + verificationRequirements.join(', ')
      : 'Deterministic rules passed; classifier raised no verification gate'
  };
}

function validateAndEvaluatePolicy(aiResult, request) {
  if (!aiResult) return evaluatePolicy(null, request);
  if (typeof aiResult !== 'object' || !RISK_LEVELS.includes(aiResult.risk_level)) {
    return evaluatePolicy(null, request);
  }
  return evaluatePolicy(aiResult, request);
}

module.exports = { evaluatePolicy, validateAndEvaluatePolicy, HARD_RULES, buildPaymentFacts, deriveVerificationRequirements, REVIEW_REQUIREMENTS };
