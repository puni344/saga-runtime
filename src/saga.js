const crypto = require('crypto');
const { verify: verifyInvariants } = require('./verifier');

const STATES = ['CREATED','AUTHORIZED','PROCESSING','EXTERNAL_UNKNOWN','RECONCILING','SUCCEEDED','COMPENSATING','REFUNDED','FAILED'];

const scenarios = {
  clean:                { id: 'clean',                name: 'Clean success',              description: 'Payment succeeds and ledger commits.' },
  crash_after_success:  { id: 'crash_after_success',  name: 'Crash after external success', description: 'Rail succeeds; response lost; process recovers.' },
  timeout_after_submit: { id: 'timeout_after_submit', name: 'Timeout after submit',        description: 'Client times out; external state unknown.' },
  crash_during_reconciliation: { id: 'crash_during_reconciliation', name: 'Crash during reconciliation', description: 'External truth is read; process restarts before local outcome is written.' },
  external_failure:     { id: 'external_failure',     name: 'External failure',            description: 'Rail rejects the payment.' },
  duplicate_retry:      { id: 'duplicate_retry',      name: 'Unsafe retry pressure',       description: 'Retry while external state unresolved.' },
  refund_after_ledger:  { id: 'refund_after_ledger',  name: 'Post-commit compensation',    description: 'Downstream failure after money moved; refund.' }
};

function _now() { return new Date().toISOString(); }

function _failModeFor(scenario, faultPoint) {
  if (faultPoint === 'after_submit_before_ack' || faultPoint === 'during_reconciliation') return 'timeout_after_submit';
  switch (scenario) {
    case 'crash_after_success':  return 'crash_after_success';
    case 'timeout_after_submit': return 'timeout_after_submit';
    case 'crash_during_reconciliation': return 'timeout_after_submit';
    case 'external_failure':     return 'external_failure';
    case 'duplicate_retry':      return 'timeout_after_submit';
    default: return 'none';
  }
}

class SagaEngine {
  constructor(opts = {}) {
    this.store = opts.store || null;
    this.rail = opts.rail || null;
    if (opts.data) {
      const d = opts.data;
      this.sagaId = d.sagaId;
      this.paymentIntentId = d.paymentIntentId || d.sagaId || null;
      this.paymentAttempts = d.paymentAttempts || [];
      this.amount = d.amount;
      this.scenario = d.scenario;
      this.faultPoint = d.faultPoint || null;
      this.riskFlag = d.riskFlag || null;
      this.review = d.review || null;
      this.state = d.state;
      this.idempotencyKey = d.idempotencyKey;
      this.paymentId = d.paymentId;
      this.orderId = d.orderId;
      this.external = d.external;
      this.ledger = d.ledger;
      this.timeline = d.timeline;
      this.context = d.context || d.agent;
      this.createdAt = d.createdAt;
      this.retryCount = d.retryCount || 0;
      this.retriedUnsafe = d.retriedUnsafe || false;
      this.compensationCount = d.compensationCount || 0;
      this.reconciliationCrashSimulated = d.reconciliationCrashSimulated || false;
      this.faultSimulated = d.faultSimulated || false;
    } else {
      this.sagaId = 'saga_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
      // A saga instance is one payment intent: the intent id is fixed at creation
      // and never changed by later idempotency/replay traffic. Conflicting
      // idempotency parameters are rejected, never merged, so the intent id cannot
      // "shuffle" between what a caller begins with and what is returned.
      this.paymentIntentId = opts.paymentIntentId || this.sagaId;
      this.paymentAttempts = [];
      this.amount = Number(opts.amount);
      if (!Number.isFinite(this.amount) || this.amount <= 0) throw new Error('Amount must be positive');
      this.scenario = opts.scenario || 'clean';
      this.faultPoint = opts.faultPoint || null;
      this.riskFlag = opts.riskFlag || null;
      this.review = opts.review || null;
      this.state = 'CREATED';
      this.idempotencyKey = opts.idempotencyKey || this.sagaId;
      this.paymentId = null;
      this.orderId = null;
      this.external = { status: 'NOT_CREATED', paymentId: null };
      this.ledger = { debit: 0, credit: 0, entries: [] };
      this.timeline = [];
      this.context = { intent: 'Purchase approved basket', risk: 'bounded', runtime: 'deterministic-guard-v1' };
      this.createdAt = _now();
      this.retryCount = 0;
      this.retriedUnsafe = false;
      this.compensationCount = 0;
      this.reconciliationCrashSimulated = false;
      this.faultSimulated = false;
      if (opts.context) this.context = { ...this.context, ...opts.context };
    }
  }

  _log(event, detail = {}) {
    this.timeline.push({ t: _now(), state: this.state, event, detail });
  }

  _transition(next, why) {
    this.state = next;
    this._log('STATE_TRANSITION', { to: next, why });
  }

  _persist() { if (this.store) this.store.save(this); }

  createPayment() {
    if (!this.rail) throw new Error('NO_PAYMENT_RAIL');
    const order = this.rail.createOrder(this.amount);
    this.orderId = order.orderId;
    this.external.status = 'CREATED';
    this._transition('AUTHORIZED', 'order created on rail');
  }

  submitPayment() {
    this._transition('PROCESSING', 'submit external payment');
    const result = this.rail.submitPayment(this.orderId, this.amount, this.idempotencyKey);
    // Journal the attempt. Re-submitting the same idempotency key de-duplicates on
    // the rail to the SAME providerPaymentId / paymentAttemptId, which is exactly
    // what makes duplicate-submit and retry-after-timeout traceable: the journal
    // records every call, the ledger still commits exactly once.
    this.paymentAttempts.push({
      paymentAttemptId: result.paymentAttemptId || require('./payment').paymentAttemptId(),
      providerPaymentId: result.providerPaymentId || result.paymentId,
      amount: this.amount,
      status: result.status,
      submittedAt: _now()
    });
    if (result.status === 'SUCCEEDED') {
      this.paymentId = result.paymentId;
      this.external.status = 'SUCCEEDED';
      this.external.paymentId = result.paymentId;
      this._log('EXTERNAL_PAYMENT_SUCCEEDED', { paymentId: result.paymentId, amount: this.amount });
    } else if (result.status === 'UNKNOWN') {
      this.paymentId = result.paymentId;
      this.external.status = 'UNKNOWN';
      this.external.paymentId = result.paymentId;
      this._transition('EXTERNAL_UNKNOWN', 'response lost; external state unknown');
    } else if (result.status === 'FAILED') {
      this.paymentId = result.paymentId;
      this.external.status = 'FAILED';
      this.external.paymentId = result.paymentId;
      this._transition('FAILED', 'external payment failed');
    }
  }

  commitLedger() {
    if (this.ledger.entries.some(e => e.kind === 'DEBIT' && e.paymentId === this.paymentId)) {
      this._log('COMMIT_SKIPPED', { reason: 'debit already recorded for this payment' });
      return;
    }
    this.ledger.debit += this.amount;
    this.ledger.entries.push({
      id: 'led_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      paymentId: this.paymentId, amount: this.amount, kind: 'DEBIT', timestamp: _now()
    });
    this._transition('SUCCEEDED', 'ledger committed exactly once');
  }

  reconcile() {
    if (!['EXTERNAL_UNKNOWN', 'RECONCILING'].includes(this.state)) {
      this._log('RECONCILE_SKIPPED', { reason: 'state is ' + this.state + ', not reconcilable' });
      return;
    }
    if (this.rail) this.rail._failMode = 'none';
    if (this.state === 'EXTERNAL_UNKNOWN') {
      this._transition('RECONCILING', 'external truth must be resolved');
      // A crash after this checkpoint but before the local outcome is written is resumable.
      this._persist();
    }
    const result = this.rail.getPaymentStatus(this.paymentId);
    if ((this.scenario === 'crash_during_reconciliation' || this.faultPoint === 'during_reconciliation') && !this.reconciliationCrashSimulated) {
      this.reconciliationCrashSimulated = true;
      this._log('RECONCILE_CRASH_SIMULATED', { paymentId: this.paymentId, externalStatus: result.status });
      this._persist();
      return;
    }
    if (result.status === 'SUCCEEDED') {
      this.external.status = 'SUCCEEDED';
      this._log('RECONCILE_CONFIRMED', { paymentId: this.paymentId, externalStatus: 'SUCCEEDED' });
      this.commitLedger();
    } else if (result.status === 'FAILED') {
      this.external.status = 'FAILED';
      this._transition('FAILED', 'external truth confirmed failed');
      this._log('RECONCILE_FAILED', { paymentId: this.paymentId });
    } else {
      this._transition('EXTERNAL_UNKNOWN', 'external state still unresolved');
      this._log('RECONCILE_UNRESOLVED', { paymentId: this.paymentId, externalStatus: result.status });
    }
  }

  applyEvent(event) {
    const evt = {
      eventId: event.eventId,
      providerPaymentId: this.providerPaymentId || event.providerPaymentId,
      eventType: event.type || event.eventType || 'payment',
      receivedAt: event.receivedAt || _now(),
      payloadHash: event.payloadHash || null,
      signature: event.signature || null
    };
    if (!evt.eventId) throw new Error('EVENT_ID_REQUIRED');
    if (!this.providerPaymentId || event.providerPaymentId !== this.providerPaymentId) {
      return { applied: false, reason: 'PAYMENT_MISMATCH', state: this.state, eventId: evt.eventId };
    }
    if (this.store && this.store.hasEvent(evt.eventId)) {
      return { applied: false, reason: 'DUPLICATE_EVENT', state: this.state, eventId: evt.eventId };
    }
    if (event.amount != null && Number(event.amount) !== Number(this.amount)) {
      this._pendingEvent = evt;
      this._persist();
      return { applied: false, reason: 'AMOUNT_MISMATCH', state: this.state, eventId: evt.eventId };
    }

    // A webhook NEVER moves money. It records an external fact and lets the
    // existing reconcile path decide: the debit still flows through
    // commitLedger's paymentId de-duplication. A saga that already reached a
    // terminal money outcome records the event but does NOT re-trigger a debit.
    const applying = ['EXTERNAL_UNKNOWN', 'RECONCILING'].includes(this.state) &&
      (event.status === 'SUCCEEDED' || event.status === 'FAILED');
    this._pendingEvent = evt;
    if (applying) {
      if (this.rail.setPaymentStatus(this.providerPaymentId, event.status)) {
        this._log('WEBHOOK_PAYMENT_FACT', { eventId: evt.eventId, providerPaymentId: evt.providerPaymentId, status: event.status });
      }
      this.reconcile();
    }
    this._persist();
    return {
      applied: applying,
      reason: applying ? (this.state === 'SUCCEEDED' ? 'RECONCILED' : this.state === 'FAILED' ? 'RECONCILED_FAILED' : 'RECORDED') : 'STALE_EVENT',
      state: this.state,
      providerPaymentId: this.providerPaymentId,
      eventId: evt.eventId
    };
  }

  // Resolve the verification gate. ONLY this method opens the review — the AI
  // that triggered the gate can never self-clear it. approve lets the saga
  // proceed; deny terminates it before any money moves.
  resolveReview(action, verifier = 'verifier:v1') {
    if (!this.review || this.review.status !== 'PENDING') {
      return { applied: false, reason: 'NO_PENDING_REVIEW', state: this.state };
    }
    this.review.status = action === 'approve' ? 'APPROVED' : 'DENIED';
    this.review.resolvedBy = verifier;
    this.review.resolvedAt = _now();
    if (this.review.status === 'DENIED') {
      this._transition('FAILED', 'review denied before money moved');
      this._log('REVIEW_DENIED', { requirements: this.review.requirements || [] });
      this._persist();
      return { applied: true, state: this.state };
    }
    this._log('REVIEW_APPROVED', { requirements: this.review.requirements || [] });
    this._persist();
    return { applied: true, state: this.state };
  }

  compensate(reason) {
    const debitEntries = this.ledger.entries.filter(e => e.kind === 'DEBIT');
    if (debitEntries.length === 1 && this.external.status === 'SUCCEEDED' && this.compensationCount === 0) {
      this._transition('COMPENSATING', reason);
      this.compensationCount++;
      if (this.rail) {
        const refundResult = this.rail.refundPayment(this.paymentId, this.amount, this.idempotencyKey);
        if (refundResult.status === 'UNKNOWN') {
          this.external.status = 'UNKNOWN';
          this._transition('EXTERNAL_UNKNOWN', 'refund status unknown');
          this._persist();
          return;
        }
        if (refundResult.status !== 'REFUNDED') {
          this._transition('COMPENSATING', 'refund failed: ' + refundResult.status);
          this._persist();
          return;
        }
      }
      this.ledger.debit -= this.amount;
      this.ledger.credit += this.amount;
      this.ledger.entries.push({
        id: 'led_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        paymentId: this.paymentId, amount: this.amount, kind: 'REFUND', timestamp: _now()
      });
      this.external.status = 'REFUNDED';
      this._transition('REFUNDED', 'compensation recorded');
      this._persist();
    } else if (this.compensationCount > 0) {
      this._log('COMPENSATE_DUPLICATE_BLOCKED', { reason: 'already compensated', compensationCount: this.compensationCount });
    } else {
      this._transition('COMPENSATING', reason);
      this._transition('FAILED', 'cannot compensate: no verified debit or external state');
    }
  }

  async attempt() {
    if (this.review && this.review.status === 'PENDING') {
      // Money is locked behind the verification gate: the saga may not even
      // create a payment while review is pending. AI interpretation decided the
      // gate exists; it cannot open it — only resolveReview() can.
      this._log('REVIEW_PENDING_BLOCKS_MONEY', { requirements: this.review.requirements || [] });
      return this.toResult();
    }
    if (this.state === 'CREATED') {
      this.createPayment();
      if (this.faultPoint === 'before_submit' && !this.faultSimulated) {
        this.faultSimulated = true;
        this._log('FAULT_BEFORE_SUBMIT_SIMULATED', { point: this.faultPoint });
        this._persist();
        return this.toResult();
      }
    }
    if (this.state === 'AUTHORIZED') {
      const fm = _failModeFor(this.scenario, this.faultPoint);
      const origFm = this.rail._failMode;
      if (fm !== 'none') this.rail._failMode = fm;
      this.submitPayment();
      if (fm !== 'none') this.rail._failMode = origFm;
      if (this.faultPoint === 'after_submit_before_ack') this._log('FAULT_AFTER_SUBMIT_BEFORE_ACK_SIMULATED', { point: this.faultPoint });
      if (this.state === 'PROCESSING' && this.external.status === 'SUCCEEDED') {
        if (this.faultPoint === 'after_ack_before_local_commit' && !this.faultSimulated) {
          this.faultSimulated = true;
          this._log('FAULT_AFTER_ACK_BEFORE_COMMIT_SIMULATED', { point: this.faultPoint });
          this._persist();
          return this.toResult();
        }
        this.commitLedger();
      }
      this._persist();
      return this.toResult();
    }
    if (this.state === 'PROCESSING' && this.external.status === 'SUCCEEDED') {
      this.commitLedger();
      this._persist();
      return this.toResult();
    }
    if (this.state === 'EXTERNAL_UNKNOWN') {
      this.reconcile();
      this._persist();
      return this.toResult();
    }
    if (this.state === 'RECONCILING') {
      this.reconcile();
      this._persist();
      return this.toResult();
    }
    if (this.state === 'SUCCEEDED' && this.scenario === 'refund_after_ledger' && this.compensationCount === 0) {
      this.compensate('downstream failure after money movement');
      this._persist();
      return this.toResult();
    }
    return this.toResult();
  }

  async retry() {
    if (this.state === 'EXTERNAL_UNKNOWN') {
      this.retriedUnsafe = true;
      this._log('NAIVE_RETRY_BLOCKED', { reason: 'EXTERNAL_STATE_UNRESOLVED', state: this.state });
      this._persist();
      return { allowed: false, reason: 'EXTERNAL_STATE_UNRESOLVED', saga: this.toResult() };
    }
    this.retryCount++;
    if (this.state === 'FAILED') {
      this.state = 'CREATED';
      this._log('RETRY_STARTED', { retryCount: this.retryCount });
      await this.attempt();
      return { allowed: true, saga: this.toResult() };
    }
    this._log('RETRY_UNNECESSARY', { state: this.state });
    return { allowed: false, reason: 'STATE_NOT_RETRYABLE', saga: this.toResult() };
  }

  run() {
    this.createPayment();
    if (this.faultPoint === 'before_submit' && !this.faultSimulated) {
      this.faultSimulated = true;
      this._log('FAULT_BEFORE_SUBMIT_SIMULATED', { point: this.faultPoint });
    }
    const fm = _failModeFor(this.scenario, this.faultPoint);
    const origFm = this.rail._failMode;
    if (fm !== 'none') this.rail._failMode = fm;
    this.submitPayment();
    if (fm !== 'none') this.rail._failMode = origFm;
    if (this.faultPoint === 'after_submit_before_ack') this._log('FAULT_AFTER_SUBMIT_BEFORE_ACK_SIMULATED', { point: this.faultPoint });

    if (this.state === 'PROCESSING' && this.external.status === 'SUCCEEDED') {
      if (this.faultPoint === 'after_ack_before_local_commit' && !this.faultSimulated) {
        this.faultSimulated = true;
        this._log('FAULT_AFTER_ACK_BEFORE_COMMIT_SIMULATED', { point: this.faultPoint });
      }
      this.commitLedger();
    }

    if (this.state === 'EXTERNAL_UNKNOWN') {
      if (this.scenario === 'duplicate_retry') {
        this.retriedUnsafe = true;
        this._log('NAIVE_RETRY_BLOCKED', { reason: 'EXTERNAL_STATE_UNRESOLVED' });
      } else {
        this.reconcile();
        if (this.state === 'RECONCILING' && (this.scenario === 'crash_during_reconciliation' || this.faultPoint === 'during_reconciliation')) this.reconcile();
      }
    }

    if (this.state === 'SUCCEEDED' && this.scenario === 'refund_after_ledger') {
      this.compensate('downstream failure after money movement');
    }

    return this.toResult();
  }

  toResult() {
    return {
      sagaId: this.sagaId, paymentIntentId: this.paymentIntentId,
      providerPaymentId: this.paymentId, paymentAttempts: this.paymentAttempts,
      amount: this.amount, scenario: this.scenario, faultPoint: this.faultPoint, riskFlag: this.riskFlag, review: this.review,
      state: this.state, idempotencyKey: this.idempotencyKey,
      paymentId: this.paymentId, orderId: this.orderId,
      external: this.external, ledger: this.ledger,
      timeline: this.timeline, verification: this.verify(),
      agent: this.context, createdAt: this.createdAt,
      retryCount: this.retryCount, retriedUnsafe: this.retriedUnsafe,
      compensationCount: this.compensationCount,
      reconciliationCrashSimulated: this.reconciliationCrashSimulated,
      faultSimulated: this.faultSimulated
    };
  }

  verify() { return verifyInvariants(this, this.retriedUnsafe); }

  // Domain alias: the provider payment this saga is bound to. Read-only view of
  // paymentId so external code speaks payment vocab without an extra field copy.
  get providerPaymentId() { return this.paymentId; }

  async benchmark(n = 100, seed = 42, opts = {}) {
    const variants = Object.keys(scenarios);
    const faultPoints = ['before_submit', 'after_submit_before_ack', 'after_ack_before_local_commit', 'during_reconciliation'];
    const cases = [];
    let recovery = 0, duplicatePrevented = 0;
    for (let i = 0; i < n; i++) {
      const scenario = variants[(i + seed) % variants.length];
      const faultPoint = faultPoints[(i * 3 + seed) % faultPoints.length];
      const amount = 500 + ((i * 113) % 4500);
      const engine = new SagaEngine({ amount, scenario, faultPoint, rail: this.rail || new (require('./rail').PaymentRailSimulator)() });
      const r = engine.run();
      const isUnsafeRetry = scenario === 'duplicate_retry';
      const isRetryBlocked = engine.retriedUnsafe;
      if (r.verification.invariantPass) recovery++;
      if (isUnsafeRetry && isRetryBlocked) duplicatePrevented++;
      cases.push({ i, scenario, faultPoint, isUnsafeRetry, isRetryBlocked, invariantPass: r.verification.invariantPass, finalState: r.state });
    }
    const retryGuard = await this.benchmarkGuardRetry(40, seed, opts);
    return {
      n, seed, recoveryRate: recovery / n,
      duplicatePreventionRate: duplicatePrevented / (cases.filter(c => c.isUnsafeRetry).length || 1),
      retryGuard,
      invariantViolations: n - recovery,
      byFaultPoint: Object.fromEntries(faultPoints.map(faultPoint => {
        const matching = cases.filter(c => c.faultPoint === faultPoint);
        const passed = matching.filter(c => c.invariantPass).length;
        return [faultPoint, { cases: matching.length, invariantPassRate: passed / (matching.length || 1), invariantViolations: matching.length - passed }];
      })),
      cases
    };
  }

  // Honestly observed retry-guard measurement. Drives genuinely unlabeled cases to
  // EXTERNAL_UNKNOWN (before reconciliation) and to safe terminal states, then reads
  // the real `retry()` guard's response. Ground truth and detection are both observed,
  // never derived from a scenario label. A regression test asserts this is not an
  // identity metric: a stubbed-out guard drops precision/recall below 1.0.
  async benchmarkGuardRetry(n = 40, seed = 42, opts = {}) {
    const roles = [
      { role: 'p_crash_after_success',         scenario: 'crash_after_success',        faultPoint: null },
      { role: 'p_timeout_after_submit',        scenario: 'timeout_after_submit',       faultPoint: null },
      { role: 'p_crash_during_reconciliation', scenario: 'crash_during_reconciliation', faultPoint: null },
      { role: 'p_clean_after_submit_fault',    scenario: 'clean',                      faultPoint: 'after_submit_before_ack' },
      { role: 'p_refund_unknown',              scenario: 'refund_after_ledger',        faultPoint: null, refundFailMode: 'refund_unknown' },
      { role: 'n_clean_succeeded',             scenario: 'clean',                      faultPoint: null },
      { role: 'n_external_failure',            scenario: 'external_failure',           faultPoint: null },
      { role: 'n_refunded',                    scenario: 'refund_after_ledger',        faultPoint: null },
      { role: 'n_resolved_after_crash',        scenario: 'crash_after_success',        faultPoint: null }
    ];
    const needsSecondPass = role => ['p_refund_unknown', 'n_refunded', 'n_resolved_after_crash'].includes(role);
    const doRetry = opts.retryDriver || (async engine => engine.retry());
    const cases = [];
    for (let i = 0; i < n; i++) {
      const { role, scenario, faultPoint, refundFailMode } = roles[i % roles.length];
      const amount = 500 + ((i * 113 + seed * 7) % 4500);
      const rail = new (require('./rail').PaymentRailSimulator)(refundFailMode ? { refundFailMode } : {});
      const engine = new SagaEngine({ amount, scenario, faultPoint, rail });
      await engine.attempt();
      if (needsSecondPass(role)) await engine.attempt();
      const unsafe = engine.state === 'EXTERNAL_UNKNOWN';
      const result = await doRetry(engine);
      const blocked = result.allowed === false && result.reason === 'EXTERNAL_STATE_UNRESOLVED';
      cases.push({ i, role, scenario, state: engine.state, unsafe, blocked });
    }
    const tp = cases.filter(c => c.unsafe && c.blocked).length;
    const fp = cases.filter(c => !c.unsafe && c.blocked).length;
    const fn = cases.filter(c => c.unsafe && !c.blocked).length;
    const tn = cases.filter(c => !c.unsafe && !c.blocked).length;
    return {
      n, seed, source: 'observed-guard-sweep',
      tp, fp, fn, tn,
      unsafeRetryPrecision: tp / (tp + fp || 1),
      unsafeRetryRecall: tp / (tp + fn || 1),
      cases
    };
  }
}

function createEngine(opts) { return new SagaEngine(opts); }
module.exports = { createEngine, SagaEngine, scenarios, STATES };
