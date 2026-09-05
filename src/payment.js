// Explicit payment-domain vocabulary.
//
// The unit of business here is a PAYMENT INTENT: a purchase that must end in at
// most one internal debit (or one verified refund). A saga INSTANCE is created
// once per idempotency key and carries one immutable paymentIntentId. Every
// call to the provider is a PAYMENT ATTEMPT with its own paymentAttemptId; the
// provider answers with a providerPaymentId. Re-submitting the same
// idempotency key de-duplicates to the SAME providerPaymentId and the SAME
// paymentAttemptId — that is what makes "duplicate submit" and
// "retry after timeout" traceable without ever creating a second debit.
//
// The payment rail is a SIMULATOR: it emulates the public surface of a
// payment gateway (createOrder / submitPayment / getPaymentStatus /
// refundPayment) but performs no real money movement and has no real-gateway
// idempotency agreement. Nothing here is a Razorpay integration.
const crypto = require('crypto');

const RAIL_KIND = 'simulator';

function paymentAttemptId() { return 'attempt_' + crypto.randomBytes(8).toString('hex'); }
function providerPaymentId() { return 'pay_' + crypto.randomBytes(8).toString('hex'); }
function refundId() { return 'refund_' + crypto.randomBytes(8).toString('hex'); }
function eventId() { return 'evt_' + crypto.randomBytes(8).toString('hex'); }

class PaymentIntent {
  constructor({ paymentIntentId, amount, idempotencyKey }) {
    this.paymentIntentId = paymentIntentId;
    this.amount = Number(amount);
    this.idempotencyKey = idempotencyKey;
    this.createdAt = new Date().toISOString();
  }
}

class PaymentAttempt {
  constructor({ paymentAttemptId, paymentIntentId, providerPaymentId, amount, idempotencyKey, submittedAt }) {
    this.paymentAttemptId = paymentAttemptId;
    this.paymentIntentId = paymentIntentId;
    this.providerPaymentId = providerPaymentId;
    this.amount = Number(amount);
    this.idempotencyKey = idempotencyKey;
    this.submittedAt = submittedAt;
  }
}

module.exports = { PaymentIntent, PaymentAttempt, RAIL_KIND, paymentAttemptId, providerPaymentId, refundId, eventId };