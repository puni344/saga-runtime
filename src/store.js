// Store — SQLite-backed transactional persistence.
//
// A single SQLite file is the one commit point for a saga transition: the saga
// snapshot row, the externally-visible payment row, and (optionally) a webhook
// event row all update inside one `BEGIN IMMEDIATE` transaction. Two OS
// processes opening the same file are serialized by SQLite's writer lock: the
// first committed transaction wins, the second sees the committed version and
// is rejected as a stale writer with CONCURRENT_ACCESS. There is no
// read-then-write generation check in user code — the database is the
// compare-and-swap.
//
// The public Store API is unchanged: constructor(filePath, rail), begin, load,
// save, delete, list, withLock.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { SagaEngine } = require('./saga');

const openStores = new Set();

const CONCURRENT_ACCESS_MESSAGE = 'CONCURRENT_ACCESS: saga store was modified by another process (stale writer rejected). Reload the store and retry.';

function concurrentAccessError() {
  const err = new Error(CONCURRENT_ACCESS_MESSAGE);
  err.code = 'CONCURRENT_ACCESS';
  return err;
}

class Store {
  constructor(filePath, rail) {
    this.filePath = filePath;
    this.rail = rail || null;
    this.sagas = {};
    this._versions = {};
    this._locks = {};
    openStores.add(this);
    this._open();
    this._hydrate();
  }

  _legacyJsonPath() {
    return this.filePath.replace(/\.db$/, '') + '.json';
  }

  _open() {
    const legacyJson = this._legacyJsonPath();
    const migratedLegacy = fs.existsSync(legacyJson) && !fs.existsSync(this.filePath);

    if (fs.existsSync(this.filePath) && fs.statSync(this.filePath).size > 0) {
      // A non-empty file must be a real SQLite database. Refuse to start against
      // unknown contents rather than risk losing a money ledger (or duplicate a
      // debit) later.
      const header = fs.readFileSync(this.filePath).slice(0, 16);
      if (header.toString('latin1') !== 'SQLite format 3\u0000') {
        throw new Error('PERSISTED_STATE_CORRUPT: ' + this.filePath + ' is not a valid database. Refusing to proceed rather than risk duplicate debits.');
      }
    }

    try {
      this.db = new DatabaseSync(this.filePath, { timeout: 2000 });
      this.db.exec('PRAGMA journal_mode=DELETE');
      this.db.exec('CREATE TABLE IF NOT EXISTS sagas (' +
        'saga_id TEXT PRIMARY KEY, ' +
        'idempotency_key TEXT NOT NULL UNIQUE, ' +
        'snapshot TEXT NOT NULL, ' +
        'version INTEGER NOT NULL, ' +
        'updated_at TEXT NOT NULL)');
      this.db.exec('CREATE TABLE IF NOT EXISTS rail_payments (' +
        'payment_id TEXT PRIMARY KEY, ' +
        'provider_payment_id TEXT, ' +
        'payment_attempt_id TEXT, ' +
        'order_id TEXT, ' +
        'amount REAL NOT NULL, ' +
        'status TEXT NOT NULL, ' +
        'idempotency_key TEXT, ' +
        'refunded INTEGER NOT NULL DEFAULT 0, ' +
        'refund_id TEXT, ' +
        'created_at TEXT NOT NULL)');
      // Tolerant column migration for databases created before the payment-domain
      // columns existed: payment id and attempt id columns are added in place.
      const railColumns = this.db.prepare('PRAGMA table_info(rail_payments)').all().map(c => c.name);
      if (railColumns.includes('payment_id') && !railColumns.includes('provider_payment_id')) {
        this.db.exec('ALTER TABLE rail_payments ADD COLUMN provider_payment_id TEXT');
      }
      if (railColumns.includes('payment_id') && !railColumns.includes('payment_attempt_id')) {
        this.db.exec('ALTER TABLE rail_payments ADD COLUMN payment_attempt_id TEXT');
      }
      this.db.exec('CREATE TABLE IF NOT EXISTS events (' +
        'event_id TEXT PRIMARY KEY, ' +
        'provider_payment_id TEXT, ' +
        'event_type TEXT NOT NULL, ' +
        'received_at TEXT NOT NULL, ' +
        'payload_hash TEXT, ' +
        'signature TEXT, ' +
        'applied_at TEXT)');
      const eventColumns = this.db.prepare('PRAGMA table_info(events)').all().map(c => c.name);
      if (eventColumns.includes('payload_hash') && !eventColumns.includes('signature')) {
        this.db.exec('ALTER TABLE events ADD COLUMN signature TEXT');
      }
      // Validate the file is a queryable database (empty file opens as a valid
      // empty DB; garbage does not).
      this.db.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
    } catch (e) {
      // A failed open must not leak the database handle: on Windows an open
      // SQLite file cannot be removed or replaced, which turns a refused start
      // into a stuck directory until the process exits.
      if (this.db) { try { this.db.close(); } catch { /* already gone */ } this.db = null; }
      if (e.code === 'ERR_SQLITE_ERROR' || /database|locked|not a database/i.test(e.message)) {
        throw new Error('PERSISTED_STATE_CORRUPT: cannot open ' + this.filePath + ' (' + e.message.split('\n')[0] + '). Refusing to proceed rather than risk duplicate debits.');
      }
      throw e;
    }

    if (migratedLegacy) {
      try {
        this._migrateLegacy(legacyJson);
      } catch (e) {
        if (this.db) { try { this.db.close(); } catch {} this.db = null; }
        throw e;
      }
    }
  }

  _migrateLegacy(legacyJson) {
    try {
      const raw = fs.readFileSync(legacyJson, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('bad shape');
      const insert = this.db.prepare('INSERT OR IGNORE INTO sagas (saga_id, idempotency_key, snapshot, version, updated_at) VALUES (?,?,?,?,?)');
      for (const [sagaId, data] of Object.entries(parsed)) {
        if (sagaId === '__generation__') continue;
        insert.run(sagaId, data.idempotencyKey || sagaId, JSON.stringify(data), 1, new Date().toISOString());
      }
      const legacyRail = legacyJson + '.rail.json';
      if (fs.existsSync(legacyRail)) {
        const railState = JSON.parse(fs.readFileSync(legacyRail, 'utf8'));
        const rp = this.db.prepare('INSERT OR IGNORE INTO rail_payments (payment_id, provider_payment_id, payment_attempt_id, order_id, amount, status, idempotency_key, refunded, refund_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
        for (const payment of Object.values(railState._payments || {})) {
          rp.run(payment.paymentId, payment.providerPaymentId || payment.paymentId, payment.paymentAttemptId || null, payment.orderId, payment.amount, payment.status, payment.idempotencyKey || null, payment.refunded ? 1 : 0, payment.refundId || null, payment.createdAt || new Date().toISOString());
        }
      }
    } catch (e) {
      throw new Error('PERSISTED_STATE_CORRUPT: legacy store ' + legacyJson + ' could not be migrated (' + e.message + '). Refusing to proceed rather than risk duplicate debits.');
    }
  }

  _hydrate() {
    const rows = this.db.prepare('SELECT saga_id, snapshot, version FROM sagas').all();
    for (const row of rows) {
      try {
        this.sagas[row.saga_id] = JSON.parse(row.snapshot);
        this._versions[row.saga_id] = row.version;
      } catch (e) {
        if (this.db) { try { this.db.close(); } catch {} this.db = null; }
        throw new Error('PERSISTED_STATE_CORRUPT: saga snapshot for ' + row.saga_id + ' is unreadable (' + e.message + '). Refusing to proceed.');
      }
    }
    if (this.rail) {
      const payments = {};
      const pr = this.db.prepare('SELECT payment_id, provider_payment_id, payment_attempt_id, order_id, amount, status, idempotency_key, refunded, refund_id, created_at FROM rail_payments').all();
      for (const r of pr) {
        payments[r.payment_id] = {
          paymentId: r.payment_id,
          providerPaymentId: r.provider_payment_id || r.payment_id,
          paymentAttemptId: r.payment_attempt_id || null,
          orderId: r.order_id, amount: r.amount, status: r.status,
          idempotencyKey: r.idempotency_key, createdAt: r.created_at,
          ...(r.refunded ? { refunded: true, refundId: r.refund_id } : {})
        };
      }
      // Only the payment journal is replaced on hydration. The simulator's
      // transient failMode / refundFailMode belong to the owning process and
      // must not be clobbered here.
      this.rail._payments = payments;
    }
  }

  _requireReady() {
    if (!this.db) throw new Error('PERSISTED_STATE_CORRUPT: store is not open');
  }

  withLock(sagaId, fn) {
    if (this._locks[sagaId]) {
      const err = new Error('CONCURRENT_ACCESS');
      err.code = 'CONCURRENT_ACCESS';
      throw err;
    }
    this._locks[sagaId] = true;
    return Promise.resolve().then(fn).finally(() => { delete this._locks[sagaId]; });
  }

  _findByIdempotency(idempotencyKey) {
    for (const data of Object.values(this.sagas)) {
      if (data.idempotencyKey === idempotencyKey) return data;
    }
    return null;
  }

  begin(idempotencyKey, amount, scenario, metadata = {}) {
    const existing = this._findByIdempotency(idempotencyKey);
    if (existing) {
      return {
        duplicate: true, sagaId: existing.sagaId, paymentIntentId: existing.paymentIntentId || existing.sagaId,
        state: existing.state,
        conflict: existing.amount !== Number(amount) ? 'AMOUNT_MISMATCH' : null
      };
    }
    const engine = new SagaEngine({
      store: this, amount, scenario, rail: this.rail, idempotencyKey,
      riskFlag: metadata.riskFlag, review: metadata.review,
      context: metadata.context
    });
    let inserted = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('INSERT INTO sagas (saga_id, idempotency_key, snapshot, version, updated_at) VALUES (?,?,?,?,?)')
          .run(engine.sagaId, idempotencyKey, JSON.stringify(engine.toResult()), 1, new Date().toISOString());
        this.db.exec('COMMIT');
        inserted = true;
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    } catch (e) {
      if (!inserted && e.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(e.message)) {
        // The same idempotency key was begun concurrently by another process.
        const winner = this.db.prepare('SELECT saga_id, snapshot FROM sagas WHERE idempotency_key = ?').get(idempotencyKey);
        if (winner) {
          try {
            const data = JSON.parse(winner.snapshot);
            this.sagas[winner.saga_id] = data;
            this._versions[winner.saga_id] = this.db.prepare('SELECT version FROM sagas WHERE saga_id = ?').get(winner.saga_id).version;
            return {
              duplicate: true, sagaId: winner.saga_id, paymentIntentId: data.paymentIntentId || data.sagaId,
              state: data.state,
              conflict: data.amount !== Number(amount) ? 'AMOUNT_MISMATCH' : null
            };
          } catch {}
        }
      }
      throw e;
    }
    this.sagas[engine.sagaId] = engine.toResult();
    this._versions[engine.sagaId] = 1;
    return { duplicate: false, sagaId: engine.sagaId, paymentIntentId: engine.paymentIntentId };
  }

  load(sagaId) {
    const data = this.sagas[sagaId];
    if (!data) return null;
    return new SagaEngine({ store: this, rail: this.rail, data });
  }

  save(saga) {
    this._requireReady();
    const sagaId = saga.sagaId;
    const expectedVersion = this._versions[sagaId];
    const snapshot = JSON.stringify(saga.toResult());
    const now = new Date().toISOString();

    const updateSaga = this.db.prepare('UPDATE sagas SET snapshot = ?, version = ?, updated_at = ? WHERE saga_id = ?');
    const insertSaga = this.db.prepare('INSERT OR IGNORE INTO sagas (saga_id, idempotency_key, snapshot, version, updated_at) VALUES (?,?,?,?,?)');
    const selectVersion = this.db.prepare('SELECT version FROM sagas WHERE saga_id = ?');
    const upsertPayment = this.db.prepare('INSERT INTO rail_payments (payment_id, provider_payment_id, payment_attempt_id, order_id, amount, status, idempotency_key, refunded, refund_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?) ' +
      'ON CONFLICT(payment_id) DO UPDATE SET provider_payment_id=excluded.provider_payment_id, payment_attempt_id=excluded.payment_attempt_id, amount=excluded.amount, status=excluded.status, idempotency_key=excluded.idempotency_key, refunded=excluded.refunded, refund_id=excluded.refund_id');
    const upsertEvent = this.db.prepare('INSERT OR IGNORE INTO events (event_id, provider_payment_id, event_type, received_at, payload_hash, signature, applied_at) VALUES (?,?,?,?,?,?,?)');

    let committed = false;
    let nextVersion;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const row = selectVersion.get(sagaId);
        if (row && row.version !== expectedVersion) {
          this.db.exec('ROLLBACK');
          throw concurrentAccessError();
        }
        if (row) {
          nextVersion = expectedVersion + 1;
          updateSaga.run(snapshot, nextVersion, now, sagaId);
        } else {
          // First transition of an engine not created through store.begin() (e.g. a
          // directly-constructed SagaEngine). The UNIQUE idempotency key is the race
          // guard: if another process already owns this key, the insert is ignored.
          const inserted = insertSaga.run(sagaId, saga.idempotencyKey || sagaId, snapshot, 1, now);
          if (inserted.changes === 0) {
            this.db.exec('ROLLBACK');
            throw concurrentAccessError();
          }
          nextVersion = 1;
        }
        if (this.rail && saga.paymentId) {
          const payment = this.rail.getPaymentRecord(saga.paymentId);
          if (payment) {
            upsertPayment.run(
              payment.paymentId, payment.providerPaymentId || payment.paymentId, payment.paymentAttemptId || null,
              payment.orderId, payment.amount, payment.status,
              payment.idempotencyKey || null, payment.refunded ? 1 : 0, payment.refundId || null,
              payment.createdAt || now
            );
          }
        }
        if (saga._pendingEvent) {
          const ev = saga._pendingEvent;
          upsertEvent.run(ev.eventId, ev.providerPaymentId || null, ev.eventType, ev.receivedAt, ev.payloadHash || null, ev.signature || null, ev.appliedAt || now);
        }
        this.db.exec('COMMIT');
        committed = true;
      } catch (e) {
        if (!committed) { try { this.db.exec('ROLLBACK'); } catch {} }
        throw e;
      }
    } catch (e) {
      // A writer lock held by another process (SQLITE_BUSY) surfaces the same
      // way as a stale writer: the competing transition must be retried against
      // a fresh snapshot, never silently overwritten.
      if (/database is locked|database table is locked/i.test(e.message) && !e.code) {
        throw concurrentAccessError();
      }
      throw e;
    }
    this._versions[sagaId] = nextVersion;
    this.sagas[sagaId] = JSON.parse(snapshot);
    if (saga._pendingEvent) delete saga._pendingEvent;
  }

  delete(sagaId) {
    this._requireReady();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM sagas WHERE saga_id = ?').run(sagaId);
      this.db.prepare('DELETE FROM rail_payments WHERE payment_id NOT IN (SELECT saga_id FROM sagas)').run();
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw e;
    }
    delete this.sagas[sagaId];
    delete this._versions[sagaId];
  }

  list() { return Object.keys(this.sagas); }

  hasEvent(eventId) {
    const row = this.db.prepare('SELECT 1 FROM events WHERE event_id = ?').get(eventId);
    return !!row;
  }

  recordEvent(event) {
    this.db.prepare('INSERT OR IGNORE INTO events (event_id, provider_payment_id, event_type, received_at, payload_hash, signature, applied_at) VALUES (?,?,?,?,?,?,?)')
      .run(event.eventId, event.providerPaymentId || null, event.eventType || 'payment', event.receivedAt || new Date().toISOString(), event.payloadHash || null, event.signature || null, event.appliedAt || null);
  }

  listEvents() {
    return this.db.prepare('SELECT event_id, provider_payment_id, event_type, received_at, signature, applied_at FROM events ORDER BY received_at').all();
  }

  findSagaByProviderPaymentId(providerPaymentId) {
    for (const [sagaId, data] of Object.entries(this.sagas)) {
      if (data.paymentId === providerPaymentId || data.providerPaymentId === providerPaymentId) return sagaId;
    }
    return null;
  }

  close() {
    if (this.db) {
      try { this.db.close(); } catch {}
      this.db = null;
      openStores.delete(this);
    }
  }

  static closeAll() {
    for (const store of [...openStores]) store.close();
  }
}

module.exports = { Store };