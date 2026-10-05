import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const context = new AsyncLocalStorage();
const privateKey = /^(authorization|cookie|set-cookie|password|api[_-]?key|access[_-]?token|secret)$/i;
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, privateKey.test(key) ? "[已隐藏]" : redact(item)]));
  return value;
}
// Monitoring must never turn a successful planning request into a failure.
export function traceEvent(type, data) {
  try { context.getStore()?.record(type, data); }
  catch (error) { console.warn("AI monitor could not record event:", error.name); }
}
export function withTrace(trace, action) { return context.run(trace, action); }

export function createTraceStore(db, { retention = 50 } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS ai_traces(
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT,
    started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, message TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_trace_events(
    trace_id TEXT NOT NULL REFERENCES ai_traces(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY(trace_id,sequence));
    CREATE INDEX IF NOT EXISTS idx_ai_traces_user ON ai_traces(user_id,started_at);`);
  db.prepare("UPDATE ai_traces SET status='interrupted',finished_at=? WHERE status='running'").run(new Date().toISOString());
  const store = {
    start(userId, conversationId, input) {
      const id = randomUUID(); let sequence = 0; let finished = false;
      db.prepare("INSERT INTO ai_traces VALUES(?,?,?,?,NULL,'running',?)")
        .run(id, userId, conversationId, new Date().toISOString(), input.message);
      const trace = { id,
        record(type, data) {
          if (finished) return;
          db.prepare("INSERT INTO ai_trace_events VALUES(?,?,?,?,?)")
            .run(id, ++sequence, new Date().toISOString(), type, JSON.stringify(redact(data)));
        },
        finish(status, data) {
          if (finished) return;
          trace.record("interaction." + status, data);
          db.prepare("UPDATE ai_traces SET status=?,finished_at=? WHERE id=?")
            .run(status, new Date().toISOString(), id);
          finished = true;
          const old = db.prepare("SELECT id FROM ai_traces WHERE user_id=? AND status!='running' ORDER BY started_at DESC,rowid DESC LIMIT -1 OFFSET ?")
            .all(userId, retention);
          for (const row of old) store.remove(userId, row.id);
        },
      };
      trace.record("interaction.input", input);
      return trace;
    },
    list(userId) {
      return db.prepare(`SELECT id,conversation_id AS conversationId,started_at AS startedAt,
        finished_at AS finishedAt,status,message,
        (SELECT COUNT(*) FROM ai_trace_events WHERE trace_id=ai_traces.id) AS eventCount
        FROM ai_traces WHERE user_id=? ORDER BY started_at DESC,rowid DESC LIMIT ?`).all(userId, retention + 1);
    },
    get(userId, id) {
      const trace = db.prepare("SELECT id,conversation_id AS conversationId,started_at AS startedAt,finished_at AS finishedAt,status,message FROM ai_traces WHERE id=? AND user_id=?").get(id, userId);
      if (!trace) return null;
      return { ...trace, events: db.prepare("SELECT sequence,at,type,data FROM ai_trace_events WHERE trace_id=? ORDER BY sequence").all(id)
        .map((event) => ({ ...event, data: JSON.parse(event.data) })) };
    },
    remove(userId, id) {
      const row = db.prepare("SELECT id FROM ai_traces WHERE id=? AND user_id=? AND status!='running'").get(id, userId);
      if (!row) return false;
      db.prepare("DELETE FROM ai_trace_events WHERE trace_id=?").run(id);
      db.prepare("DELETE FROM ai_traces WHERE id=? AND user_id=?").run(id, userId);
      return true;
    },
  };
  return store;
}
