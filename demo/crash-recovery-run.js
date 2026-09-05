// Runs the two-phase crash recovery demo in a single command, sequentially:
// phase 1 (submit) persists a saga mid-flight, phase 2 (recover) loads the
// database in a brand-new process and proves exactly-once reconciliation.
const { spawnSync } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');
const target = path.join(__dirname, 'crash-recovery.js');

for (const stage of ['submit', 'recover']) {
  const res = spawnSync(process.execPath, [target], {
    cwd: root,
    env: { ...process.env, STAGE: stage },
    stdio: 'inherit'
  });
  if (res.status !== 0) process.exit(res.status || 1);
}