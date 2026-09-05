// Webhook signature helper: HMAC-SHA256 over the exact raw request body.
// The webhook boundary is cheap and explicit: a body without the correct
// signature is rejected before it is parsed, so timeliness/ordering rules
// never even see unauthenticated traffic.
const crypto = require('crypto');

function sign(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function verify(secret, rawBody, signature) {
  if (!secret || !signature || !signature.trim()) return false;
  const expected = Buffer.from(sign(secret, rawBody), 'utf8');
  const provided = Buffer.from(String(signature), 'utf8');
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

module.exports = { sign, verify };