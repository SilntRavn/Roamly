import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createTraceStore, withTrace, traceEvent } from "../server/ai-monitor.mjs";
import { serviceJson } from "../server/service-json.mjs";

function fixture(retention = 50) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  return { db, store: createTraceStore(db, { retention }) };
}
test("concurrent interactions remain isolated, snapshots survive mutation and private keys are hidden", async () => {
  const { db, store } = fixture();
  try {
    const a = store.start("a", "conversation-a", { message: "杭州两天", password: "private" });
    const b = store.start("b", "conversation-b", { message: "甘南六天" });
    const data = { messages: [{ role: "system", content: "保留全部必去点" }], apiKey: "secret" };
    await Promise.all([
      withTrace(a, async () => { await new Promise((r) => setTimeout(r, 15)); traceEvent("model.request", data); }),
      withTrace(b, async () => { traceEvent("tool.result", { name: "get_route", result: 20 }); }),
    ]);
    data.messages[0].content = "changed";
    a.finish("completed", { reply: "完成" }); b.finish("canceled", { error: "取消" });
    const saved = store.get("a", a.id);
    assert.equal(saved.events[0].data.password, "[已隐藏]");
    assert.equal(saved.events[1].data.apiKey, "[已隐藏]");
    assert.equal(saved.events[1].data.messages[0].content, "保留全部必去点");
    assert.equal(store.get("b", a.id), null);
    assert.equal(store.remove("b", a.id), false);
    assert.equal(store.list("a").length, 1);
    assert.equal(store.get("b", b.id).status, "canceled");
    assert.equal(store.get("b", b.id).events[1].type, "tool.result");
  } finally { db.close(); }
});
test("retention prunes finished traces and events while protecting running traces", () => {
  const { db, store } = fixture(2);
  try {
    const running = store.start("a", "c", { message: "running" });
    assert.equal(store.remove("a", running.id), false);
    for (let i = 0; i < 4; i++) store.start("a", "c", { message: String(i) }).finish("completed", {});
    assert.equal(store.list("a").length, 3);
    assert.ok(store.get("a", running.id));
    assert.equal(db.prepare("SELECT count(*) AS n FROM ai_trace_events").get().n, 5);
    createTraceStore(db);
    assert.equal(store.get("a", running.id).status, "interrupted");
  } finally { db.close(); }
});
test("captures each HTTP attempt, actual request settings, raw response and usage without credentials", async () => {
  const { db, store } = fixture(); const old = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async () => ++calls === 1 ? new Response("temporary", { status: 503 }) :
      Response.json({ choices: [{ message: { role: "assistant", content: "好的" } }], usage: { total_tokens: 123 } });
    const trace = store.start("a", "c", { message: "input" });
    await withTrace(trace, () => serviceJson("https://example.invalid/chat?key=secret", {
      headers: { Authorization: "Bearer secret" }, body: JSON.stringify({ temperature: 0.25, messages: [{ role: "system", content: "真实提示词" }] }),
    }));
    trace.finish("completed", {});
    const events = store.get("a", trace.id).events;
    assert.equal(events.filter((e) => e.type === "model.request").length, 2);
    assert.equal(events[1].data.body.temperature, 0.25);
    assert.equal(events[2].data.raw, "temporary");
    assert.equal(JSON.parse(events[4].data.raw).usage.total_tokens, 123);
    assert.ok(!JSON.stringify(events).includes("secret"));
  } finally { globalThis.fetch = old; db.close(); }
});
test("monitoring storage errors do not break the model call", async () => {
  const old = globalThis.fetch; const warn = console.warn;
  try {
    console.warn = () => {};
    globalThis.fetch = async () => Response.json({ ok: true });
    const result = await withTrace({ record() { throw new Error("disk full"); } }, () => serviceJson("https://example.invalid", {}));
    assert.equal(result.data.ok, true);
  } finally { globalThis.fetch = old; console.warn = warn; }
});
