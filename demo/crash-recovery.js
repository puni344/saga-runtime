const path = require('path');
const fs = require('fs');
const { Store } = require('../src/store');
const { PaymentRailSimulator } = require('../src/rail');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'demo-crash.db');

(async () => {
  if (process.env.STAGE === 'submit') {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    const rail = new PaymentRailSimulator({ failMode: 'crash_after_success' });
    const store = new Store(STORE_FILE, rail);

    const saga = await store.begin('demo-key-001', 1500, 'crash_after_success');
    console.log('STEP 1: Saga created:', saga.sagaId);
    console.log('STEP 1: Idempotency key: demo-key-001');

    const engine = store.load(saga.sagaId);
    const result = await engine.attempt();
    console.log('STEP 2: Payment submitted. External status:', result.external.status);
    console.log('STEP 2: Local state:', result.state);
    console.log('STEP 2: Ledger entries:', result.ledger.entries.length);

    // A human operator (or an out-of-band rail query) confirms the payment actually
    // succeeded. Rewrite the durable rail truth BEFORE the "crash": the transient
    // submit-time failMode must never be persisted as external truth, exactly as in a
    // real deployment where the rails have no such flag.
    rail._failMode = 'none';
    rail._payments[engine.paymentId].status = 'SUCCEEDED';
    store.save(engine);
    console.log('STEP 3: External rail confirmed SUCCESS (persisted to disk)');
    console.log('STEP 3: But local process is about to "die"...');
    console.log('--- SIMULATING PROCESS CRASH ---');

    process.exit(0);

  } else if (process.env.STAGE === 'recover') {
    if (!fs.existsSync(STORE_FILE)) { console.error('No persisted state found. Run STAGE=submit first.'); process.exit(1); }

    // Brand-new process, brand-new rail, no in-memory continuation: only the
    // database on disk survives. The store reloads the saga AND the rail's durable
    // truth (saga snapshot + rail payment rows commit together).
    const rail = new PaymentRailSimulator();
    const store = new Store(STORE_FILE, rail);
    console.log('STEP 4: New process started. Loading persisted state...');

    const sagas = store.list();
    console.log('STEP 4: Found', sagas.length, 'persisted saga(s)');
    const engine = store.load(sagas[0]);
    console.log('STEP 4: Loaded saga:', engine.sagaId);
    console.log('STEP 4: State:', engine.state);
    console.log('STEP 4: External status:', engine.external.status);

    if (engine.state === 'EXTERNAL_UNKNOWN') {
      console.log('STEP 5: Saga is in EXTERNAL_UNKNOWN. Running reconciliation...');
      await engine.attempt();
      console.log('STEP 5: After reconciliation, state:', engine.state);
      console.log('STEP 5: Ledger debit:', engine.ledger.debit);
      console.log('STEP 5: Ledger entries:', JSON.stringify(engine.ledger.entries, null, 2));

      const v = engine.verify();
      console.log('STEP 6: Verification result:', JSON.stringify(v, null, 2));
      console.log('STEP 6: Invariant pass:', v.invariantPass);
      console.log('---');
      console.log('RESULT: Payment recovered across process crash. One debit recorded.');
      if (v.invariantPass) console.log('RESULT: ALL INVARIANTS PASS');
      else { console.log('RESULT: INVARIANT FAILURE'); process.exit(1); }
      if (engine.state !== 'SUCCEEDED' || engine.ledger.debit !== 1500) {
        console.error('RESULT: RECOVERY FAILED - saga did not reach SUCCEEDED with one debit');
        process.exit(1);
      }
    } else {
      console.log('STEP 4: Saga is in state', engine.state, '- no recovery needed');
    }

    store.close();
    fs.unlinkSync(STORE_FILE);
    console.log('CLEANUP: Temp files removed');
  }
})();
