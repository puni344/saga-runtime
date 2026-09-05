// PaymentRail contract suite.
//
// The set of guarantees the saga REQUIRES from any provider rail. A real
// replacement rail must satisfy these same statements to drop in without
// changing saga logic; the simulator is the only rail shipped in this repo and
// the suite pins its behaviour so the simulator itself cannot drift.
//
// Contract
//   1. Surface: createOrder / submitPayment / getPaymentStatus / refundPayment,
//      and RAIL_KIND is 'simulator'.
//   2. Idempotency: re-submitting the same idempotency key with the same amount
//      returns the SAME providerPaymentId and paymentAttemptId, and creates NO
//      second payment (retry-after-timeout is safe).
//   3. Amount integrity: the same idempotency key submitted with a DIFFERENT
//      amount is REJECTED with AMOUNT_MISMATCH and reports the original amount —
//      a clobbered retry can never quietly move a different sum.
//   4. Refund idempotency: two refunds of one payment yield exactly one refundId;
//      the second call reports ALREADY_REFUNDED.
//   5. Refund preconditions: refunding an unknown or non-SUCCEEDED payment is
//      rejected (NOT_FOUND / REJECTED), never silently accepted.
//   6. Truth channel: getPaymentStatus returns UNKNOWN for an unknown payment
//      and, in lossy fail modes, reports UNKNOWN by design instead of guessing.
//   7. Persistence/recovery: getState()/loadState(state) round-trips the
//      idempotency bookkeeping so a restarted saga reconstructs the SAME
//      providerPaymentId for a duplicate key (dedup survives restart).
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentRailSimulator } = require('../src/rail');
const { RAIL_KIND } = require('../src/payment');

test('contract 1: rail exposes the full surface and kind', () => {
  const rail = new PaymentRailSimulator();
  assert.equal(typeof rail.createOrder, 'function');
  assert.equal(typeof rail.submitPayment, 'function');
  assert.equal(typeof rail.getPaymentStatus, 'function');
  assert.equal(typeof rail.refundPayment, 'function');
  assert.equal(rail.kind, RAIL_KIND);
  assert.equal(RAIL_KIND, 'simulator');
  const order = rail.createOrder(500);
  assert.ok(order.orderId && order.status === 'CREATED' && order.amount === 500);
});

test('contract 2: same key, same amount -> same provider payment, no duplicate', () => {
  const rail = new PaymentRailSimulator();
  const r1 = rail.submitPayment('order-1', 1200, 'key-dup');
  const r2 = rail.submitPayment('order-1', 1200, 'key-dup');
  assert.equal(r1.paymentId, r2.paymentId);
  assert.equal(r1.paymentAttemptId, r2.paymentAttemptId);
  assert.equal(r1.providerPaymentId, r2.providerPaymentId);
  assert.equal(r1.amount, 1200);
  // One entry in the bookkeeping, not two.
  assert.equal(Object.keys(rail.getState()._payments).length, 1);
  // Distinct keys create distinct payments and attempts.
  const b = rail.submitPayment('order-2', 500, 'key-b');
  assert.notEqual(b.paymentId, r1.paymentId);
  assert.equal(Object.keys(rail.getState()._payments).length, 2);
});

test('contract 3: same key, different amount -> AMOUNT_MISMATCH, original kept', () => {
  const rail = new PaymentRailSimulator();
  const first = rail.submitPayment('order-1', 1200, 'key-x');
  const clash = rail.submitPayment('order-1', 999999, 'key-x');
  assert.equal(clash.status, 'REJECTED');
  assert.equal(clash.reason, 'AMOUNT_MISMATCH');
  assert.equal(clash.providerPaymentId, first.paymentId, 'mismatch reports the original payment');
  assert.equal(Object.keys(rail.getState()._payments).length, 1, 'no second payment is created');
});

test('contract 4: double refund -> exactly one refundId, second is ALREADY_REFUNDED', () => {
  const rail = new PaymentRailSimulator();
  const pay = rail.submitPayment('order-1', 1000, 'key-r');
  const r1 = rail.refundPayment(pay.paymentId, 1000, 'key-r-refund');
  assert.equal(r1.status, 'REFUNDED');
  assert.ok(r1.refundId);
  const r2 = rail.refundPayment(pay.paymentId, 1000, 'key-r-refund');
  assert.equal(r2.status, 'ALREADY_REFUNDED');
  assert.equal(r2.refundId, r1.refundId, 'single refund identity across calls');
  assert.equal(rail.getPaymentRecord(pay.paymentId).status, 'REFUNDED');
});

test('contract 5: refund preconditions refuse unknown and non-SUCCEEDED payments', () => {
  const rail = new PaymentRailSimulator();
  assert.equal(rail.refundPayment('pay_nope', 100, 'k').status, 'NOT_FOUND');
  const order = rail.createOrder(500);
  const pay = rail.submitPayment(order.orderId, 500, 'key-f');
  assert.equal(pay.status, 'SUCCEEDED');
  rail.setPaymentStatus(pay.paymentId, 'FAILED');
  const r = rail.refundPayment(pay.paymentId, 500, 'key-fr');
  assert.equal(r.status, 'REJECTED');
  assert.equal(r.reason, 'PAYMENT_NOT_SUCCEEDED');
});

test('contract 6: getPaymentStatus is honest — unknown pays and lossy modes say UNKNOWN', () => {
  const rail = new PaymentRailSimulator();
  assert.equal(rail.getPaymentStatus('pay_ghost').status, 'UNKNOWN');
  const p = rail.submitPayment('o', 600, 'k');
  assert.equal(rail.getPaymentStatus(p.paymentId).status, 'SUCCEEDED');
  const lossy = new PaymentRailSimulator({ failMode: 'crash_after_success' });
  const l = lossy.submitPayment('o', 700, 'k2');
  assert.equal(l.status, 'UNKNOWN');
  // The simulator never guesses: even a successful-but-lossy payment reads UNKNOWN.
  assert.equal(lossy.getPaymentStatus(l.paymentId).status, 'UNKNOWN');
});

test('contract 7: idempotency bookkeeping survives getState/loadState round-trip', () => {
  const rail = new PaymentRailSimulator();
  const r1 = rail.submitPayment('order-1', 2000, 'key-p');
  const snapshot = rail.getState();
  const revived = new PaymentRailSimulator();
  revived.loadState(snapshot);
  const r2 = revived.submitPayment('order-1', 2000, 'key-p');
  assert.equal(r2.paymentId, r1.paymentId, 'restart dedup returns the same provider payment');
  assert.equal(r2.paymentAttemptId, r1.paymentAttemptId);
  assert.equal(Object.keys(revived.getState()._payments).length, 1, 'no duplicate after restart');
  // A clobbered amount after "restart" still refuses.
  const clash = revived.submitPayment('order-1', 3000, 'key-p');
  assert.equal(clash.status, 'REJECTED');
  assert.equal(clash.reason, 'AMOUNT_MISMATCH');
});

test('contract: paymentAttemptIds are unique across submissions', () => {
  const rail = new PaymentRailSimulator();
  const ids = new Set();
  for (let i = 0; i < 25; i++) {
    const r = rail.submitPayment('o' + i, 100 + i, 'k' + i);
    ids.add(r.paymentAttemptId);
  }
  assert.equal(ids.size, 25);
});