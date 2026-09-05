const path = require('path');
const { runLiveEval } = require('./run-live-eval');

const CACHE_DIR = path.join(__dirname, 'cache');

runLiveEval({
  kind: 'gemini',
  providerLabel: 'gemini',
  defaultModel: 'gemini-3.6-flash',
  cacheFile: path.join(CACHE_DIR, 'gemini-final-eval.json'),
  label: 'GEMINI'
}).catch(e => { console.log('FATAL:', e); process.exit(2); });