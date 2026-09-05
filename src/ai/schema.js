const RISK_LEVELS = ['LOW_RISK', 'AMBIGUOUS', 'HIGH_RISK'];
const DECISIONS = ['ALLOW', 'BLOCK', 'REVIEW'];
const REVIEW_REQUIREMENTS = [
  'OVERRIDE_CLAIM_VERIFICATION', 'LOW_CONFIDENCE_REVIEW', 'LOW_CONFIDENCE_LARGE_AMOUNT_REVIEW',
  'RISK_ADJUDICATION', 'AMBIGUITY_RESOLUTION'
];
const REASON_CODES = [
  'CLEAR_AMOUNT', 'EXPLICIT_PURCHASE', 'STANDARD_TRANSACTION',
  'VAGUE_AMOUNT', 'UNCLEAR_TARGET', 'INCOMPLETE_INSTRUCTION',
  'AMBIGUOUS_AUTHORITY', 'CONFLICTING_CONSTRAINTS',
  'SAFEGUARD_OVERRIDE', 'SUSPICIOUS_PATTERN', 'ADVERSARIAL_INPUT',
  'UNUSUAL_AMOUNT', 'UNUSUAL_CONTEXT'
];

function validateStructuredIntent(si) {
  if (si === undefined || si === null) return { valid: true };
  if (typeof si !== 'object' || Array.isArray(si)) return { valid: false, error: 'INVALID_STRUCTURED_INTENT' };
  if (si.expected_amount !== undefined) {
    const n = Number(si.expected_amount);
    if (!Number.isFinite(n) || n <= 0) return { valid: false, error: 'INVALID_EXPECTED_AMOUNT' };
  }
  if (si.currency !== undefined && (typeof si.currency !== 'string' || si.currency.length === 0)) return { valid: false, error: 'INVALID_CURRENCY' };
  if (si.recurring !== undefined && typeof si.recurring !== 'boolean') return { valid: false, error: 'INVALID_RECURRING' };
  if (si.title !== undefined && typeof si.title !== 'string') return { valid: false, error: 'INVALID_TITLE' };
  if (si.payee !== undefined && si.payee !== null && typeof si.payee !== 'string') return { valid: false, error: 'INVALID_PAYEE' };
  if (si.purpose !== undefined && si.purpose !== null && typeof si.purpose !== 'string') return { valid: false, error: 'INVALID_PURPOSE' };
  if (si.urgency !== undefined && si.urgency !== null && !['high', 'normal', 'low'].includes(si.urgency)) return { valid: false, error: 'INVALID_URGENCY' };
  if (si.authority_claim !== undefined && si.authority_claim !== null && typeof si.authority_claim !== 'string') return { valid: false, error: 'INVALID_AUTHORITY_CLAIM' };
  if (si.override_language !== undefined && typeof si.override_language !== 'boolean') return { valid: false, error: 'INVALID_OVERRIDE_LANGUAGE' };
  if (si.ambiguity !== undefined && (si.ambiguity !== null && !Array.isArray(si.ambiguity))) return { valid: false, error: 'INVALID_AMBIGUITY' };
  if (si.confidence !== undefined && si.confidence !== null) {
    const c = Number(si.confidence);
    if (!Number.isFinite(c) || c < 0 || c > 1) return { valid: false, error: 'INVALID_CONFIDENCE' };
  }
  return { valid: true };
}

function validateAIOutput(output) {
  if (!output || typeof output !== 'object') return { valid: false, error: 'NOT_OBJECT' };
  if (!RISK_LEVELS.includes(output.risk_level)) return { valid: false, error: 'INVALID_RISK_LEVEL' };
  if (typeof output.intent_clear !== 'boolean') return { valid: false, error: 'INVALID_INTENT_CLEAR' };
  if (typeof output.amount_consistent !== 'boolean') return { valid: false, error: 'INVALID_AMOUNT_CONSISTENT' };
  if (typeof output.requires_confirmation !== 'boolean') return { valid: false, error: 'INVALID_REQUIRES_CONFIRMATION' };
  if (!Array.isArray(output.reason_codes)) return { valid: false, error: 'INVALID_REASON_CODES' };
  for (const code of output.reason_codes) {
    if (!REASON_CODES.includes(code)) return { valid: false, error: 'UNKNOWN_REASON_CODE: ' + code };
  }
  if (output.rationale !== undefined && typeof output.rationale !== 'string') return { valid: false, error: 'INVALID_RATIONALE' };
  const si = validateStructuredIntent(output.structured_intent);
  if (!si.valid) return si;
  return { valid: true };
}

function safeParseJSON(text) {
  if (typeof text !== 'string') return { ok: false, error: 'NOT_STRING' };
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/```json\s*([\s\S]*?)```/) || trimmed.match(/\{[\s\S]*\}/);
  const raw = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : trimmed;
  try { return { ok: true, value: JSON.parse(raw) }; } catch (e) { return { ok: false, error: 'PARSE_ERROR: ' + e.message }; }
}

module.exports = { RISK_LEVELS, DECISIONS, REASON_CODES, REVIEW_REQUIREMENTS, validateAIOutput, safeParseJSON };
