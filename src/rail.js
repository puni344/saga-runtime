const crypto = require('crypto');
const { RAIL_KIND, paymentAttemptId } = require('./payment');

// SIMULATOR: emulates the public surface of a payment gateway. It performs no
// real money movement and has no real-gateway idempotency agreement — only the
// de-duplication rules coded below. See src/payment.js.
class PaymentRailSimulator {
  constructor(opts = {}) {
    this.kind = RAIL_KIND;
    this._payments = {};
    this._failMode = opts.failMode || 'none';
    this._refundFailMode = opts.refundFailMode || 'none';
  }

  _orderId() { return 'order_' + crypto.randomBytes(8).toString('hex'); }
  _paymentId() { return 'pay_' + crypto.randomBytes(8).toString('hex'); }

  createOrder(amount) {
    return { orderId: this._orderId(), amount, status: 'CREATED', createdAt: new Date().toISOString() };
  }

  submitPayment(orderId, amount, idempotencyKey) {
    const existing = this._findPayment(idempotencyKey);
    if (existing) {
      if (existing.amount !== amount) {
        return { status: 'REJECTED', reason: 'AMOUNT_MISMATCH', providerPaymentId: existing.paymentId, paymentId: existing.paymentId };
      }
      return { status: existing.status, providerPaymentId: existing.paymentId, paymentId: existing.paymentId, amount: existing.amount, paymentAttemptId: existing.paymentAttemptId };
    }
    const pid = this._paymentId();
    let status;
    switch (this._failMode) {
      case 'crash_after_success': status = 'SUCCEEDED'; break;
      case 'timeout_after_submit': status = 'SUCCEEDED'; break;
      case 'external_failure': status = 'FAILED'; break;
      case 'response_lost_after_success': status = 'SUCCEEDED'; break;
      case 'response_lost_after_failure': status = 'FAILED'; break;
      default: status = 'SUCCEEDED';
    }
    const attempt = paymentAttemptId();
    this._payments[pid] = { paymentId: pid, providerPaymentId: pid, paymentAttemptId: attempt, orderId, amount, status, idempotencyKey, createdAt: new Date().toISOString() };
    if (['crash_after_success', 'timeout_after_submit'].includes(this._failMode)) {
      return { status: 'UNKNOWN', providerPaymentId: pid, paymentId: pid, amount, paymentAttemptId: attempt };
    }
    return { status, providerPaymentId: pid, paymentId: pid, amount, paymentAttemptId: attempt };
  }

  getPaymentStatus(paymentId) {
    const p = this._payments[paymentId];
    if (!p) return { status: 'UNKNOWN', paymentId };
    if (['crash_after_success', 'timeout_after_submit', 'response_lost_after_success', 'response_lost_after_failure'].includes(this._failMode)) {
      return { status: 'UNKNOWN', paymentId };
    }
    return { status: p.status, paymentId, amount: p.amount };
  }

  refundPayment(paymentId, amount, idempotencyKey) {
    if (this._refundFailMode === 'refund_unknown') return { status: 'UNKNOWN', paymentId };
    if (this._refundFailMode === 'refund_failure') return { status: 'FAILED', paymentId, reason: 'PROVIDER_ERROR' };
    const p = this._payments[paymentId];
    if (!p) return { status: 'NOT_FOUND', paymentId };
    if (p.refunded) return { status: 'ALREADY_REFUNDED', paymentId, refundId: p.refundId };
    if (p.status !== 'SUCCEEDED') return { status: 'REJECTED', paymentId, reason: 'PAYMENT_NOT_SUCCEEDED' };
    const refundId = 'ref_' + crypto.randomBytes(8).toString('hex');
    p.refunded = true;
    p.refundId = refundId;
    p.status = 'REFUNDED';
    return { status: 'REFUNDED', paymentId, refundId, amount };
  }

  _findPayment(idempotencyKey) {
    return Object.values(this._payments).find(p => p.idempotencyKey === idempotencyKey) || null;
  }

  getPaymentRecord(paymentId) {
    return this._payments[paymentId] || null;
  }

  setPaymentStatus(paymentId, status) {
    const p = this._payments[paymentId];
    if (!p) return false;
    p.status = status;
    return true;
  }

  getState() { return { _payments: this._payments, _failMode: this._failMode, _refundFailMode: this._refundFailMode }; }
  loadState(state) { Object.assign(this, state); }
}

module.exports = { PaymentRailSimulator };
