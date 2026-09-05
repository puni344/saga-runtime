const path = require('path');
const { runLiveEval } = require('./run-live-eval');

const CACHE_DIR = path.join(__dirname, 'cache');

runLiveEval({
  kind: 'groq',
  providerLabel: 'groq',
  defaultModel: 'qwen/qwen3.8-27b',
  cacheFile: path.join(CACHE_DIR, 'groq-final-eval.json'),
  label: 'GROQ'
}).catch(e => { console.log('FATAL:', e); process.exit(2); });