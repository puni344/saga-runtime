const { getDevSet, getHeldOutSet, getFinalTestSet, getClassDistribution, DATASET_PROVENANCE } = require('./eval-dataset');
const { MockRiskAnalyzer } = require('./risk-analyzer');

const AI_EVAL_VERSION = 'AI-EVAL-0.1';

async function evaluate(analyzer, dataset) {
  const results = [];
  for (const example of dataset) {
    let predicted;
    try {
      predicted = await analyzer.analyze({
        instruction: example.instruction,
        amount: example.amount,
        context: example.context
      });
    } catch (e) {
      predicted = { risk_level: 'ERROR', error: e.message };
    }
    results.push({ ...example, predicted: predicted.risk_level, raw: predicted });
  }
  return computeMetrics(results);
}

function computeMetrics(results) {
  const classes = ['LOW_RISK', 'AMBIGUOUS', 'HIGH_RISK'];
  const confusion = {};
  for (const actual of classes) {
    confusion[actual] = {};
    for (const predicted of classes) confusion[actual][predicted] = 0;
    confusion[actual]['ERROR'] = 0;
  }

  let correct = 0;
  for (const r of results) {
    const a = r.expected;
    const p = r.predicted;
    if (p === a) correct++;
    if (confusion[a] && confusion[a][p] !== undefined) confusion[a][p]++;
    else if (confusion[a]) confusion[a]['ERROR'] = (confusion[a]['ERROR'] || 0) + 1;
  }

  const accuracy = correct / results.length;
  const perClass = {};
  for (const cls of classes) {
    const tp = confusion[cls][cls] || 0;
    let fp = 0, fn = 0;
    for (const other of classes) {
      if (other !== cls) {
        fp += (confusion[other][cls] || 0);
        fn += (confusion[cls][other] || 0);
      }
    }
    fp += (confusion[cls]['ERROR'] || 0);
    const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
    const recall = (tp + fn) > 0 ? tp / (tp + fn) : 0;
    const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;
    perClass[cls] = { tp, fp, fn, precision: round4(precision), recall: round4(recall), f1: round4(f1) };
  }

  let macroPrecision = 0, macroRecall = 0, macroF1 = 0;
  for (const cls of classes) {
    macroPrecision += perClass[cls].precision;
    macroRecall += perClass[cls].recall;
    macroF1 += perClass[cls].f1;
  }
  macroPrecision /= classes.length;
  macroRecall /= classes.length;
  macroF1 /= classes.length;

  const highRisk = perClass['HIGH_RISK'] || { tp: 0, fp: 0, fn: 0, precision: 0, recall: 0, f1: 0 };
  const lowRisk = perClass['LOW_RISK'] || { tp: 0, fp: 0, fn: 0, precision: 0, recall: 0, f1: 0 };
  const ambiguous = perClass['AMBIGUOUS'] || { tp: 0, fp: 0, fn: 0, precision: 0, recall: 0, f1: 0 };

  return {
    version: AI_EVAL_VERSION,
    total: results.length,
    correct,
    accuracy: round4(accuracy),
    perClass,
    macro: { precision: round4(macroPrecision), recall: round4(macroRecall), f1: round4(macroF1) },
    highRiskPrecision: highRisk.precision,
    highRiskRecall: highRisk.recall,
    highRiskFalsePositives: highRisk.fp,
    highRiskFalseNegatives: highRisk.fn,
    lowRiskPrecision: lowRisk.precision,
    lowRiskRecall: lowRisk.recall,
    ambiguousPrecision: ambiguous.precision,
    ambiguousRecall: ambiguous.recall,
    confusion,
    results
  };
}

function round4(n) { return Math.round(n * 10000) / 10000; }

function printReport(report) {
  console.log('=== EVALUATION REPORT ===');
  console.log(`Version: ${report.version || AI_EVAL_VERSION}`);
  console.log(`Total: ${report.total} | Correct: ${report.correct} | Accuracy: ${(report.accuracy * 100).toFixed(1)}%`);
  console.log('');
  console.log('Per-class results:');
  for (const [cls, m] of Object.entries(report.perClass)) {
    console.log(`  ${cls}: P=${(m.precision * 100).toFixed(1)}% R=${(m.recall * 100).toFixed(1)}% F1=${(m.f1 * 100).toFixed(1)}% TP=${m.tp} FP=${m.fp} FN=${m.fn}`);
  }
  console.log('');
  console.log(`Macro: P=${(report.macro.precision * 100).toFixed(1)}% R=${(report.macro.recall * 100).toFixed(1)}% F1=${(report.macro.f1 * 100).toFixed(1)}%`);
  console.log('');
  console.log(`HIGH_RISK safety: precision=${(report.highRiskPrecision * 100).toFixed(1)}% recall=${(report.highRiskRecall * 100).toFixed(1)}% FP=${report.highRiskFalsePositives} FN=${report.highRiskFalseNegatives}`);
  console.log('');
  console.log('Confusion matrix (rows=actual, cols=predicted):');
  const classes = ['LOW_RISK', 'AMBIGUOUS', 'HIGH_RISK'];
  console.log('               ' + classes.map(c => c.padStart(12)).join(''));
  for (const actual of classes) {
    const row = classes.map(p => String(report.confusion[actual][p] || 0).padStart(12)).join('');
    console.log(actual.padStart(14) + row);
  }
}

function printProvenance() {
  const p = DATASET_PROVENANCE;
  console.log('=== DATASET PROVENANCE ===');
  console.log(`Version: ${p.version}`);
  console.log(`Created: ${p.created}`);
  console.log('');
  console.log(`DEV SET: ${p.devSet.examples} examples — ${p.devSet.distribution}`);
  console.log(`  Method: ${p.devSet.method}`);
  console.log(`  Status: ${p.devSet.status}`);
  console.log('');
  console.log(`CONTAMINATED HOLDOUT: ${p.heldOutSet.examples} examples — ${p.heldOutSet.distribution}`);
  console.log(`  Method: ${p.heldOutSet.method}`);
  console.log(`  Status: ${p.heldOutSet.status}`);
  console.log(`  Original result: accuracy=${p.heldOutSet.originalResult.accuracy} HIGH_RISK_recall=${p.heldOutSet.originalResult.highRiskRecall}`);
  console.log(`  After contamination: accuracy=${p.heldOutSet.contaminatedResult.accuracy} HIGH_RISK_recall=${p.heldOutSet.contaminatedResult.highRiskRecall}`);
  console.log(`  Note: ${p.heldOutSet.contaminationNote}`);
  console.log('');
  console.log(`FINAL TEST SET: ${p.finalTestSet.examples} examples — ${p.finalTestSet.distribution}`);
  console.log(`  Method: ${p.finalTestSet.method}`);
  console.log(`  Status: ${p.finalTestSet.status} (frozen ${p.finalTestSet.frozenDate})`);
  console.log(`  Hard negatives: ${p.finalTestSet.hardNegatives} (${p.finalTestSet.hardNegativeNote})`);
  console.log(`  Note: ${p.finalTestSet.freezeNote}`);
}

function printAllReports() {
  console.log('=========================================================');
  console.log('AI EVALUATION — FULL REPORT');
  console.log('=========================================================');
  console.log('');

  printProvenance();
  console.log('');
  console.log('=========================================================');
  console.log('MOCK RISK ANALYZER — RULE-BASED BASELINE');
  console.log('=========================================================');
  console.log('');
  console.log('--- Development Set (60 examples) ---');
  console.log('This set was used to develop the classifier.');
  console.log('Results are NOT an unbiased estimate.');
  console.log('');
}

module.exports = { evaluate, computeMetrics, printReport, printProvenance, printAllReports, AI_EVAL_VERSION };
