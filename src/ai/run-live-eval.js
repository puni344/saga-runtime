const fs = require('fs');
const path = require('path');
const { LLMRiskAnalyzer } = require('./risk-analyzer');
const { getFinalTestSet } = require('./eval-dataset');
const { computeMetrics } = require('./evaluate');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isDone(entry) {
  if (!entry) return false;
  if (entry.parsed && entry.parsed.risk_level) return true;
  if (entry.raw && entry.raw.risk_level) return true;
  return false;
}

async function attemptWithQuotaRecovery(analyzer, ex) {
  const QUOTA_WAIT_MS = Number(process.env.AI_QUOTA_WAIT_MS) || 60000;
  const QUOTA_ROUNDS = Number(process.env.AI_QUOTA_ROUNDS) || 3;
  for (let round = 0; round <= QUOTA_ROUNDS; round++) {
    try {
      return { ok: true, value: await analyzer.analyze({ instruction: ex.instruction, amount: ex.amount, context: ex.context }) };
    } catch (e) {
      const isQuota = (e && (e.status === 429 || /quota|rate.?limit|429/i.test(e.message || '')));
      if (isQuota && round < QUOTA_ROUNDS) {
        console.log('  ... quota hit, waiting', QUOTA_WAIT_MS, 'ms (round', (round + 1) + '/' + QUOTA_ROUNDS + ')');
        await sleep(QUOTA_WAIT_MS);
        continue;
      }
      return { ok: false, error: e };
    }
  }
}

function loadCache(cacheFile) {
  if (!fs.existsSync(cacheFile)) return { provider: null, model: null, entries: {} };
  try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); }
  catch { return { provider: null, model: null, entries: {} }; }
}

function saveCache(cacheFile, cache) {
  const dir = path.dirname(cacheFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
}

async function runLiveEval({ kind, providerLabel, defaultModel, cacheFile, label }) {
  const RATE_LIMIT_MS = Number(process.env.AI_RATE_LIMIT_MS) || 1500;
  const PROVIDER = process.env.AI_PROVIDER || providerLabel;
  const MODEL = process.env.AI_MODEL || defaultModel;

  let analyzer;
  try {
    analyzer = new LLMRiskAnalyzer({ provider: PROVIDER, model: MODEL });
  } catch (e) {
    console.log('FATAL: could not construct analyzer:', e.message);
    process.exit(2);
  }
  if (!analyzer._apiKey) {
    console.log('FATAL: AI_API_KEY not set. Refusing to guess live results.');
    process.exit(2);
  }

  const dataset = getFinalTestSet();
  const cache = loadCache(cacheFile);
  cache.provider = providerLabel;
  cache.model = MODEL;

  console.log('=== ' + label + ' LIVE EVAL ===');
  console.log('Provider:', cache.provider, '| model:', cache.model);
  console.log('Dataset: final-45 frozen (read-only). Total examples:', dataset.length);
  console.log('Rate limit between calls:', RATE_LIMIT_MS, 'ms');

  const results = [];
  let completed = 0, errors = 0;

  for (let i = 0; i < dataset.length; i++) {
    const ex = dataset[i];
    const id = ex.id || ('final_' + i);
    if (isDone(cache.entries[id])) {
      const entry = cache.entries[id];
      const rlabel = entry.parsed && entry.parsed.risk_level ? entry.parsed.risk_level : entry.raw.risk_level;
      results.push({ ...ex, id, predicted: rlabel, raw: entry });
      completed++;
      console.log('[' + (i + 1) + '/' + dataset.length + '] CACHED ' + id + ' -> ' + rlabel);
      continue;
    }
    const attempt = await attemptWithQuotaRecovery(analyzer, ex);
    if (attempt.ok) {
      const parsed = attempt.value;
      cache.entries[id] = { provider: providerLabel, model: MODEL, requestedAt: new Date().toISOString(), raw: parsed, parsed: parsed };
      saveCache(cacheFile, cache);
      results.push({ ...ex, id, predicted: parsed.risk_level, raw: parsed });
      completed++;
      console.log('[' + (i + 1) + '/' + dataset.length + '] OK ' + id + ' -> ' + parsed.risk_level);
    } else {
      const e = attempt.error;
      const errRec = { provider: providerLabel, model: MODEL, requestedAt: new Date().toISOString(), raw: null, parsed: null, error: e && e.message };
      cache.entries[id] = errRec;
      saveCache(cacheFile, cache);
      results.push({ ...ex, id, predicted: 'ERROR', raw: errRec });
      errors++;
      console.log('[' + (i + 1) + '/' + dataset.length + '] ERROR ' + id + ' -> ' + (e && e.message));
    }
    if (i < dataset.length - 1) await sleep(RATE_LIMIT_MS);
  }

  const fullMetrics = computeMetrics(results);
  const completedResults = results.filter(r => r.predicted !== 'ERROR');
  const completedMetrics = completed > 0 ? computeMetrics(completedResults) : null;

  console.log('');
  console.log('=== RESULT (' + label + ' live) ===');
  console.log('Completed:', completed, '/', dataset.length, '| errors:', errors);
  console.log('--- Metrics over COMPLETED examples only (' + completed + '), errors excluded ---');
  if (completedMetrics) {
    console.log('Accuracy:', (completedMetrics.accuracy * 100).toFixed(1) + '%');
    console.log('Macro F1:', (completedMetrics.macro.f1 * 100).toFixed(1) + '%');
    console.log('HIGH_RISK P/R:', (completedMetrics.highRiskPrecision * 100).toFixed(1) + '% / ' + (completedMetrics.highRiskRecall * 100).toFixed(1) + '%',
      'TP/FP/FN:', completedMetrics.perClass.HIGH_RISK.tp, completedMetrics.perClass.HIGH_RISK.fp, completedMetrics.perClass.HIGH_RISK.fn);
    console.log('Per-class:');
    for (const c of ['LOW_RISK', 'AMBIGUOUS', 'HIGH_RISK']) {
      const p = completedMetrics.perClass[c];
      console.log('  ' + c + ': P=' + (p.precision * 100).toFixed(1) + '% R=' + (p.recall * 100).toFixed(1) + '% F1=' + (p.f1 * 100).toFixed(1) + '% TP=' + p.tp + ' FP=' + p.fp + ' FN=' + p.fn);
    }
    console.log('Confusion (rows=actual, cols=predicted):');
    const classes = ['LOW_RISK', 'AMBIGUOUS', 'HIGH_RISK'];
    console.log(' ' + classes.map(c => c.padStart(10)).join(''));
    for (const a of classes) {
      console.log(a.padEnd(10) + classes.map(c => String(completedMetrics.confusion[a][c] || 0).padStart(10)).join(''));
    }
  }
  console.log('--- Metrics over ALL 45 (incomplete/error examples counted as ERROR/incorrect) ---');
  console.log('Accuracy:', (fullMetrics.accuracy * 100).toFixed(1) + '%');
  console.log('Macro F1:', (fullMetrics.macro.f1 * 100).toFixed(1) + '%');
  console.log('HIGH_RISK P/R (errors counted as FP):',
    (fullMetrics.highRiskPrecision * 100).toFixed(1) + '% / ' + (fullMetrics.highRiskRecall * 100).toFixed(1) + '%',
    'TP/FP/FN:', fullMetrics.perClass.HIGH_RISK.tp, fullMetrics.perClass.HIGH_RISK.fp, fullMetrics.perClass.HIGH_RISK.fn);

  console.log('');
  console.log('Cache written to:', cacheFile);
}

module.exports = { runLiveEval };