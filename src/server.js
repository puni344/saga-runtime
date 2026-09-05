const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./store');
const { PaymentRailSimulator } = require('./rail');
const { scenarios } = require('./saga');
const { MockRiskAnalyzer, LLMRiskAnalyzer } = require('./ai/risk-analyzer');
const { validateAndEvaluatePolicy } = require('./ai/policy');
const { evaluate, printReport } = require('./ai/evaluate');
const { getDevSet, getHeldOutSet, getFinalTestSet } = require('./ai/eval-dataset');
const { verify: verifyWebhookSignature } = require('./webhook');

const root = path.join(__dirname, '..', 'static');
const port = process.env.PORT || 3000;
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const rail = new PaymentRailSimulator();
const store = new Store(path.join(dataDir, 'sagas.db'), rail);
const riskAnalyzer = process.env.AI_API_KEY ? new LLMRiskAnalyzer() : new MockRiskAnalyzer();

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
function body(req, maxBytes = 1 << 20) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => {
      s += c;
      if (s.length > maxBytes) { req.destroy(); reject(new Error('BODY_TOO_LARGE')); }
    });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function rawBody(req, maxBytes = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); reject(new Error('BODY_TOO_LARGE')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/api/health') return send(res, 200, { ok: true, service: 'saga-runtime', version: '3.0' });
    if (req.url === '/api/scenarios') return send(res, 200, Object.values(scenarios));
    if (req.method === 'POST' && req.url === '/api/begin') {
      const { idempotencyKey, amount, scenario } = await body(req);
      const result = await store.withLock('__begin_' + (idempotencyKey || ''), () => store.begin(idempotencyKey, Number(amount), scenario));
      return send(res, 200, result);
    }
    if (req.method === 'POST' && req.url === '/api/attempt') {
      const { sagaId } = await body(req);
      const engine = store.load(sagaId);
      if (!engine) return send(res, 404, { error: 'Saga not found' });
      const result = await store.withLock(sagaId, () => engine.attempt());
      return send(res, 200, result);
    }
    if (req.method === 'POST' && req.url === '/api/reconcile') {
      const { sagaId } = await body(req);
      const engine = store.load(sagaId);
      if (!engine) return send(res, 404, { error: 'Saga not found' });
      const result = await store.withLock(sagaId, () => engine.reconcile());
      store.save(engine);
      return send(res, 200, engine.toResult());
    }
    if (req.method === 'POST' && req.url === '/api/retry') {
      const { sagaId } = await body(req);
      const engine = store.load(sagaId);
      if (!engine) return send(res, 404, { error: 'Saga not found' });
      const result = await store.withLock(sagaId, () => engine.retry());
      return send(res, 200, result);
    }
    if (req.method === 'POST' && req.url === '/api/compensate') {
      const { sagaId, reason } = await body(req);
      const engine = store.load(sagaId);
      if (!engine) return send(res, 404, { error: 'Saga not found' });
      await store.withLock(sagaId, () => engine.compensate(reason || 'manual compensation'));
      store.save(engine);
      return send(res, 200, engine.toResult());
    }
    if (req.method === 'POST' && req.url === '/api/simulate') {
      const { amount, scenario } = await body(req);
      const engine = new (require('./saga').SagaEngine)({ amount: Number(amount), scenario, rail });
      const result = await engine.run();
      return send(res, 200, result);
    }
    if (req.method === 'POST' && req.url === '/api/benchmark') {
      const { n, seed } = await body(req);
      const engine = new (require('./saga').SagaEngine)({ amount: 1000, rail });
      return send(res, 200, await engine.benchmark(Number(n) || 100, Number(seed) || 42));
    }
    if (req.method === 'GET' && req.url === '/api/sagas') {
      return send(res, 200, store.list().map(id => store.load(id).toResult()));
    }
    if (req.method === 'POST' && req.url === '/api/analyze') {
      const { instruction, amount, context } = await body(req);
      if (!instruction || typeof instruction !== 'string') return send(res, 400, { error: 'instruction required' });
      const numAmount = Number(amount);
      let aiResult;
      try {
        aiResult = await riskAnalyzer.analyze({ instruction, amount: numAmount, context });
      } catch (e) {
        aiResult = null;
      }
      const decision = validateAndEvaluatePolicy(aiResult, { instruction, amount: numAmount });
      return send(res, 200, { ai: aiResult, policy: decision });
    }
    if (req.method === 'POST' && req.url === '/api/analyze-and-begin') {
      const { instruction, amount, context, scenario } = await body(req);
      if (!instruction || typeof instruction !== 'string') return send(res, 400, { error: 'instruction required' });
      const numAmount = Number(amount);
      let aiResult;
      try {
        aiResult = await riskAnalyzer.analyze({ instruction, amount: numAmount, context });
      } catch (e) {
        aiResult = null;
      }
      const decision = validateAndEvaluatePolicy(aiResult, { instruction, amount: numAmount });
      const idempotencyKey = 'ai_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
      if (decision.decision === 'BLOCK') return send(res, 200, { ai: aiResult, policy: decision, saga: null });
      const review = decision.reviewRequired ? {
        status: 'PENDING', source: 'RISK_CLASSIFIER', flag: decision.riskFlag || 'VERIFICATION_REQUIRED',
        requirements: decision.verificationRequirements || [], createdAt: new Date().toISOString()
      } : null;
      const contextData = {
        aiStructuredIntent: decision.structuredIntent,
        structuredChecks: decision.structuredChecks,
        paymentFacts: decision.paymentFacts,
        verificationRequirements: decision.verificationRequirements || []
      };
      const result = await store.withLock('__begin_' + idempotencyKey, () => store.begin(idempotencyKey, numAmount, scenario || 'clean', { riskFlag: decision.riskFlag, review, context: contextData }));
      if (result.duplicate) return send(res, 200, { ai: aiResult, policy: decision, saga: result });
      const engine = store.load(result.sagaId);
      if (decision.decision === 'REVIEW') {
        // AI interpretation raised verification gates: money stays locked until a
        // human/verifier clears them. No payment is created.
        return send(res, 200, { ai: aiResult, policy: decision, saga: engine.toResult() });
      }
      const sagaResult = await store.withLock(result.sagaId, () => engine.attempt());
      return send(res, 200, { ai: aiResult, policy: decision, saga: sagaResult });
    }
    if (req.method === 'GET' && req.url === '/api/reviews') {
      const reviews = store.list().map(id => store.load(id).toResult()).filter(saga => saga.review && saga.review.status === 'PENDING');
      return send(res, 200, reviews);
    }
    if (req.method === 'POST' && req.url === '/api/review') {
      const { sagaId, decision: reviewAction } = await body(req);
      const engine = store.load(sagaId);
      if (!engine) return send(res, 404, { error: 'Saga not found' });
      if (reviewAction !== 'approve' && reviewAction !== 'deny') return send(res, 400, { error: 'decision must be approve or deny' });
      const result = await store.withLock(sagaId, () => engine.resolveReview(reviewAction));
      return send(res, 200, { ...result, saga: engine.toResult() });
    }
    if (req.method === 'POST' && req.url === '/api/evaluate') {
      const { dataset } = await body(req);
      const data = dataset === 'heldout' ? getHeldOutSet() : dataset === 'final' ? getFinalTestSet() : getDevSet();
      const report = await evaluate(riskAnalyzer, data);
      return send(res, 200, { accuracy: report.accuracy, macro: report.macro, perClass: report.perClass, highRisk: { precision: report.highRiskPrecision, recall: report.highRiskRecall, fp: report.highRiskFalsePositives, fn: report.highRiskFalseNegatives }, confusion: report.confusion, total: report.total });
    }
    if (req.method === 'POST' && req.url === '/webhooks/payment') {
      // Webhook ingestion boundary: HMAC-SHA256 over the exact raw body. Without a
      // valid signature the body is never parsed. The webhook records an external
      // fact and lets the saga reconcile; it NEVER moves money by itself.
      const raw = await rawBody(req);
      const secret = process.env.WEBHOOK_SECRET;
      if (!secret) return send(res, 503, { error: 'WEBHOOK_SECRET_NOT_CONFIGURED' });
      if (!verifyWebhookSignature(secret, raw, req.headers['x-webhook-signature'])) {
        return send(res, 401, { error: 'INVALID_WEBHOOK_SIGNATURE' });
      }
      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: 'INVALID_JSON' }); }
      if (!payload.eventId || !payload.providerPaymentId || !payload.status) return send(res, 400, { error: 'EVENT_MISSING_FIELDS' });

      const sagaId = store.findSagaByProviderPaymentId(payload.providerPaymentId);
      if (!sagaId) {
        const recorded = store.hasEvent(payload.eventId);
        store.recordEvent({ eventId: payload.eventId, providerPaymentId: payload.providerPaymentId, eventType: payload.type || 'payment', receivedAt: payload.receivedAt, signature: req.headers['x-webhook-signature'] });
        return send(res, 200, { status: 'accepted', applied: false, reason: recorded ? 'DUPLICATE_EVENT' : 'UNKNOWN_PAYMENT', eventId: payload.eventId });
      }
      const engine = store.load(sagaId);
      const result = await store.withLock(sagaId, () => engine.applyEvent({ ...payload, signature: req.headers['x-webhook-signature'] }));
      return send(res, 200, { status: 'accepted', ...result, sagaId });
    }
    if (req.method === 'GET' && req.url === '/api/events') {
      return send(res, 200, { events: store.listEvents() });
    }
    const clean = req.url.split('?')[0];
    const file = clean === '/' ? path.join(root, 'index.html') : path.join(root, clean);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: 'not found' });
    const ext = path.extname(file);
    send(res, 200, fs.readFileSync(file), mime[ext] || 'application/octet-stream');
  } catch (e) { send(res, 400, { error: e.message }); }
});

server.listen(port, () => console.log(`Saga Runtime v3 running on http://localhost:${port}`));
module.exports = { server, store, rail };
