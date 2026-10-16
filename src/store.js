const now = () => new Date().toISOString();
const parse = (value, fallback = null) => {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

export class BuyerStore {
  constructor(db) { this.db = db; }

  async createTask({ id, kind, budgetAtomic, capAtomic, snapshotBlock }) {
    const timestamp = now();
    await this.db.prepare("INSERT OR IGNORE INTO tasks(id,kind,status,budget_atomic,cap_atomic,snapshot_block,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(id, kind, "CREATED", budgetAtomic, capAtomic, snapshotBlock, timestamp, timestamp).run();
    return this.snapshot(id);
  }

  async getTask(id) { return this.db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first(); }

  async recordEvent(taskId, intentId, type, detail = {}) {
    await this.db.prepare("INSERT INTO events(task_id,intent_id,type,detail_json,created_at) VALUES(?,?,?,?,?)")
      .bind(taskId, intentId || null, type, JSON.stringify(detail), now()).run();
  }

  async quoteIntent({ id, taskId, endpoint, amountAtomic, reason }) {
    const timestamp = now();
    await this.db.batch([
      this.db.prepare("INSERT OR IGNORE INTO payment_intents(id,task_id,endpoint,state,amount_atomic,decision_reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
        .bind(id, taskId, endpoint, "QUOTED", amountAtomic, reason, timestamp, timestamp),
      this.db.prepare("UPDATE tasks SET status='QUOTED', updated_at=? WHERE id=? AND status NOT IN ('COMPLETED','STOPPED_BUDGET','REFUSED_PRICE_CAP')").bind(timestamp, taskId),
      this.db.prepare("INSERT INTO events(task_id,intent_id,type,detail_json,created_at) VALUES(?,?,?,?,?)").bind(taskId, id, "QUOTED", JSON.stringify({ endpoint, amountAtomic, reason }), timestamp),
    ]);
  }

  async reserve({ taskId, intentId, amountAtomic, decision }) {
    const task = await this.getTask(taskId);
    if (!task) throw new Error("Task not found");
    const timestamp = now();
    if (!decision.allowed) {
      await this.db.batch([
        this.db.prepare("UPDATE payment_intents SET state=?, decision_reason=?, updated_at=? WHERE id=?").bind(decision.state, decision.reason, timestamp, intentId),
        this.db.prepare("UPDATE tasks SET status=?, updated_at=? WHERE id=?").bind(decision.state, timestamp, taskId),
        this.db.prepare("INSERT INTO events(task_id,intent_id,type,detail_json,created_at) VALUES(?,?,?,?,?)").bind(taskId, intentId, decision.state, JSON.stringify({ reason: decision.reason, noAuthorizationCreated: true, noDebit: true }), timestamp),
      ]);
      return false;
    }
    const reserved = (BigInt(task.reserved_atomic) + BigInt(amountAtomic)).toString();
    await this.db.batch([
      this.db.prepare("UPDATE tasks SET status='APPROVED', reserved_atomic=?, updated_at=? WHERE id=?").bind(reserved, timestamp, taskId),
      this.db.prepare("UPDATE payment_intents SET state='APPROVED', decision_reason=?, updated_at=? WHERE id=?").bind(decision.reason, timestamp, intentId),
      this.db.prepare("INSERT INTO events(task_id,intent_id,type,detail_json,created_at) VALUES(?,?,?,?,?)").bind(taskId, intentId, "RESERVED", JSON.stringify({ amountAtomic, reservedAtomic: reserved }), timestamp),
    ]);
    return true;
  }

  async markPending({ taskId, intentId, authId, payload }) {
    const timestamp = now();
    await this.db.batch([
      this.db.prepare("UPDATE payment_intents SET state='PAYMENT_PENDING', auth_id=?, payment_payload_json=?, updated_at=? WHERE id=?").bind(authId, JSON.stringify(payload), timestamp, intentId),
      this.db.prepare("UPDATE tasks SET status='PAYMENT_PENDING', updated_at=? WHERE id=?").bind(timestamp, taskId),
      this.db.prepare("INSERT INTO events(task_id,intent_id,type,detail_json,created_at) VALUES(?,?,?,?,?)").bind(taskId, intentId, "PAYMENT_PENDING", JSON.stringify({ authId, signedPayloadStoredServerSide: true }), timestamp),
    ]);
  }

  async retireExpiredAuthorization({ taskId, intentId, amountAtomic, authId }) {
    const task = await this.getTask(taskId);
    const intent = await this.db.prepare("SELECT state,auth_id FROM payment_intents WHERE id=?").bind(intentId).first();
    if (!task || !intent) throw new Error("Task or payment intent not found");
    if (intent.auth_id !== authId) throw new Error("Expired authorization identity changed during reconciliation");
    if (!["PAYMENT_PENDING", "PENDING_RECONCILIATION"].includes(intent.state)) throw new Error(`Cannot retire authorization from ${intent.state}`);
    const reserved = (BigInt(task.reserved_atomic) - BigInt(amountAtomic)).toString();
    if (BigInt(reserved) < 0n) throw new Error("Reservation accounting underflow while retiring expired authorization");
    const timestamp = now();
    await this.db.batch([
      this.db.prepare("UPDATE payment_intents SET state='QUOTED', auth_id=NULL, payment_payload_json=NULL, error=NULL, attempt_count=0, updated_at=? WHERE id=? AND auth_id=?")
        .bind(timestamp, intentId, authId),
      this.db.prepare("UPDATE tasks SET status='QUOTED', reserved_atomic=?, readonly=0, updated_at=? WHERE id=?")
        .bind(reserved, timestamp, taskId),
      this.db.prepare("INSERT INTO events(task_id,intent_id,type,detail_json,created_at) VALUES(?,?,?,?,?)")
        .bind(taskId, intentId, "AUTHORIZATION_EXPIRED_UNUSED", JSON.stringify({ authId, noDebit: true, reservationReleased: amountAtomic, requiresFreshQuoteAndDecision: true }), timestamp),
    ]);
  }

  async recordAttempt(taskId, intentId, attempt, delayMs, result) {
    const timestamp = now();
    await this.db.batch([
      this.db.prepare("UPDATE payment_intents SET attempt_count=?, updated_at=? WHERE id=?").bind(attempt, timestamp, intentId),
      this.db.prepare("INSERT INTO events(task_id,intent_id,type,detail_json,created_at) VALUES(?,?,?,?,?)").bind(taskId, intentId, "PAYMENT_ATTEMPT", JSON.stringify({ attempt, delayMs, result }), timestamp),
    ]);
  }

  async settle({ taskId, intentId, amountAtomic, settlementHash, receipt, response }) {
    const intent = await this.db.prepare("SELECT state FROM payment_intents WHERE id=?").bind(intentId).first();
    if (!intent) throw new Error("Payment intent not found");
    if (["SETTLED", "DATA_RECEIVED"].includes(intent.state)) return;
    if (!["PAYMENT_PENDING", "PENDING_RECONCILIATION"].includes(intent.state)) throw new Error(`Cannot settle intent from ${intent.state}`);
    const task = await this.getTask(taskId);
    const confirmed = (BigInt(task.confirmed_atomic) + BigInt(amountAtomic)).toString();
    const reserved = (BigInt(task.reserved_atomic) - BigInt(amountAtomic)).toString();
    if (BigInt(reserved) < 0n) throw new Error("Reservation accounting underflow");
    const timestamp = now();
    await this.db.batch([
      this.db.prepare("UPDATE payment_intents SET state='DATA_RECEIVED', settlement_hash=?, receipt_json=?, response_json=?, updated_at=? WHERE id=?")
        .bind(settlementHash, JSON.stringify(receipt), JSON.stringify(response), timestamp, intentId),
      this.db.prepare("UPDATE tasks SET status='DATA_RECEIVED', confirmed_atomic=?, reserved_atomic=?, updated_at=? WHERE id=?")
        .bind(confirmed, reserved, timestamp, taskId),
      this.db.prepare("INSERT INTO events(task_id,intent_id,type,detail_json,created_at) VALUES(?,?,?,?,?)")
        .bind(taskId, intentId, "SETTLED", JSON.stringify({ settlementHash, amountAtomic, confirmedAtomic: confirmed, reservedAtomic: reserved, receiptStatus: receipt.status }), timestamp),
      this.db.prepare("INSERT INTO events(task_id,intent_id,type,detail_json,created_at) VALUES(?,?,?,?,?)")
        .bind(taskId, intentId, "DATA_RECEIVED", JSON.stringify({ endpoint: response.endpoint, blockNumber: response.blockNumber || response.snapshotBlock }), timestamp),
    ]);
  }

  async fail({ taskId, intentId, amountAtomic, state = "FAILED", error, keepReservation = false }) {
    const task = await this.getTask(taskId);
    const intent = await this.db.prepare("SELECT state FROM payment_intents WHERE id=?").bind(intentId).first();
    const release = !keepReservation && ["APPROVED", "PAYMENT_PENDING"].includes(intent?.state);
    const reserved = release ? (BigInt(task.reserved_atomic) - BigInt(amountAtomic)).toString() : task.reserved_atomic;
    const timestamp = now();
    await this.db.batch([
      this.db.prepare("UPDATE payment_intents SET state=?, error=?, updated_at=? WHERE id=?").bind(state, error, timestamp, intentId),
      this.db.prepare("UPDATE tasks SET status=?, reserved_atomic=?, updated_at=? WHERE id=?").bind(state, reserved, timestamp, taskId),
      this.db.prepare("INSERT INTO events(task_id,intent_id,type,detail_json,created_at) VALUES(?,?,?,?,?)").bind(taskId, intentId, state, JSON.stringify({ error, reservationRetained: keepReservation }), timestamp),
    ]);
  }

  async complete(taskId, report) {
    const timestamp = now();
    await this.db.batch([
      this.db.prepare("UPDATE tasks SET status='COMPLETED', report_json=?, readonly=1, updated_at=? WHERE id=?").bind(JSON.stringify(report), timestamp, taskId),
      this.db.prepare("INSERT INTO events(task_id,intent_id,type,detail_json,created_at) VALUES(?,?,?,?,?)").bind(taskId, null, "COMPLETED", JSON.stringify({ reportUsesBothPurchasedResources: true }), timestamp),
    ]);
  }

  async finalizeStopped(taskId) { await this.db.prepare("UPDATE tasks SET readonly=1, updated_at=? WHERE id=?").bind(now(), taskId).run(); }

  async snapshot(id) {
    const task = await this.getTask(id);
    if (!task) return null;
    const intents = (await this.db.prepare("SELECT id,task_id,endpoint,state,amount_atomic,auth_id,settlement_hash,receipt_json,response_json,attempt_count,decision_reason,error,created_at,updated_at FROM payment_intents WHERE task_id=? ORDER BY created_at,id").bind(id).all()).results;
    const events = (await this.db.prepare("SELECT id,intent_id,type,detail_json,created_at FROM events WHERE task_id=? ORDER BY id").bind(id).all()).results;
    return {
      task: { ...task, report: parse(task.report_json), report_json: undefined },
      intents: intents.map((row) => ({ ...row, receipt: parse(row.receipt_json), response: parse(row.response_json), receipt_json: undefined, response_json: undefined })),
      events: events.map((row) => ({ ...row, detail: parse(row.detail_json, {}), detail_json: undefined })),
    };
  }

  async listReviewerTasks() {
    const rows = (await this.db.prepare("SELECT id,kind,status,confirmed_atomic,reserved_atomic,budget_atomic,cap_atomic,created_at,updated_at FROM tasks WHERE readonly=1 ORDER BY created_at DESC LIMIT 20").all()).results;
    return rows;
  }
}
