import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("monitor API captures a failed real chat, isolates accounts, exports JSON and removes traces", async (t) => {
  const folder = mkdtempSync(path.join(tmpdir(), "roamly-monitor-test-"));
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "Unauthorized", message: "test error" } }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const server = spawn(process.execPath, ["server/index.mjs", "--production"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, PORT: String(port), ROAMLY_HOST: "127.0.0.1", ROAMLY_AI_MONITOR: "1",
      ROAMLY_DB: path.join(folder, "monitor.sqlite"), ARK_API_KEY: "test-private-key",
      ARK_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, ARK_MODEL: "test-model" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    server.kill(); if (server.exitCode === null) await once(server, "exit");
    await new Promise((resolve) => upstream.close(resolve));
    const resolved = path.resolve(folder);
    if (resolved.startsWith(path.join(path.resolve(tmpdir()), "roamly-monitor-test-"))) rmSync(resolved, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server startup timed out")), 10000);
    server.stdout.once("data", () => { clearTimeout(timer); resolve(); });
    server.once("exit", () => { clearTimeout(timer); reject(new Error("server exited")); });
  });
  const origin = `http://127.0.0.1:${port}`;
  let cookie = "";
  async function call(url, method = "GET", body, useCookie = true) {
    const res = await fetch(origin + "/api" + url, { method,
      headers: { "Content-Type": "application/json", cookie: useCookie ? cookie : "", Origin: origin },
      body: body ? JSON.stringify(body) : undefined });
    if (useCookie) cookie = res.headers.getSetCookie().at(-1)?.split(";")[0] || cookie;
    return { status: res.status, data: await res.json() };
  }
  assert.equal((await call("/ai-monitor")).status, 401);
  assert.equal((await call("/ai-monitor/traces")).status, 401);
  await call("/auth/register", "POST", { username: "SilntRavn", password: "test-pass" });
  assert.equal((await call("/ai-monitor")).data.enabled, true);
  await call("/auth/logout", "POST");
  assert.equal((await call("/auth/login", "POST", { username: "SilntRavn", password: "wrong-pass" })).status, 401);
  assert.equal((await call("/ai-monitor/traces")).status, 401);
  assert.equal((await call("/auth/login", "POST", { username: "silntravn", password: "test-pass" })).status, 200);
  const stream = await fetch(origin + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json", cookie, Origin: origin },
    body: JSON.stringify({ message: "杭州两天" }) });
  assert.equal(stream.status, 200);
  assert.match(await stream.text(), /event: trace/);
  const listing = (await call("/ai-monitor/traces")).data.traces;
  assert.equal(listing.length, 1); assert.equal(listing[0].status, "failed");
  const detail = (await call(`/ai-monitor/traces/${listing[0].id}`)).data;
  assert.ok(detail.events.some((e) => e.type === "model.request" && e.data.body.model === "test-model"));
  assert.ok(detail.events.some((e) => e.type === "model.response" && e.data.status === 401));
  assert.ok(!JSON.stringify(detail).includes("test-private-key"));
  const ownerCookie = cookie; cookie = "";
  await call("/auth/register", "POST", { username: "Stranger", password: "test-pass" });
  assert.equal((await call("/ai-monitor")).status, 403);
  assert.equal((await call("/ai-monitor/traces")).status, 403);
  assert.equal((await call(`/ai-monitor/traces/${detail.id}`)).status, 403);
  assert.equal((await call(`/ai-monitor/traces/${detail.id}`, "DELETE")).status, 403);
  cookie = ownerCookie;
  assert.equal((await fetch(origin + "/api/ai-monitor/traces/" + detail.id, { method: "DELETE", headers: { cookie, Origin: "https://other.invalid" } })).status, 403);
  assert.equal((await call(`/ai-monitor/traces/${detail.id}`, "DELETE")).status, 200);
  assert.equal((await call("/ai-monitor/traces")).data.traces.length, 0);
  assert.equal((await fetch(origin + "/ai-monitor")).status, 200);
});
