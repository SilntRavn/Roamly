import test from "node:test";
import assert from "node:assert/strict";
import { startAccountSync } from "../src/account-sync.mjs";

function surfaces() {
  const window = new EventTarget();
  const document = new EventTarget();
  document.visibilityState = "visible";
  window.navigator = { onLine: true };
  let tick;
  window.setInterval = (fn) => { tick = fn; return 1; };
  window.clearInterval = () => { tick = undefined; };
  return { window, document, tick: () => tick?.() };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("account refresh runs on polling, return to foreground and reconnect, and pauses while hidden/offline", async () => {
  const env = surfaces();
  let calls = 0;
  const stop = startAccountSync({ ...env, refresh: async () => { calls++; } });
  await settle();
  assert.equal(calls, 1);
  await env.tick();
  assert.equal(calls, 2);
  env.document.visibilityState = "hidden";
  await env.tick();
  env.window.dispatchEvent(new Event("focus"));
  assert.equal(calls, 2);
  env.document.visibilityState = "visible";
  env.document.dispatchEvent(new Event("visibilitychange"));
  await settle();
  env.window.navigator.onLine = false;
  await env.tick();
  assert.equal(calls, 3);
  env.window.navigator.onLine = true;
  env.window.dispatchEvent(new Event("online"));
  await settle();
  assert.equal(calls, 4);
  env.window.dispatchEvent(new Event("pageshow"));
  await settle();
  assert.equal(calls, 5);
  stop();
  env.window.dispatchEvent(new Event("focus"));
  env.document.dispatchEvent(new Event("visibilitychange"));
  await env.tick();
  assert.equal(calls, 5);
});

test("refresh does not overlap, aborts on cleanup, and retries transient failure", async () => {
  const env = surfaces();
  let calls = 0;
  let signal;
  let finish;
  const stop = startAccountSync({ ...env, refresh: (s) => {
    calls++;
    signal = s;
    return new Promise((resolve) => { finish = resolve; });
  } });
  await env.tick();
  env.window.dispatchEvent(new Event("online"));
  assert.equal(calls, 1);
  stop();
  assert.equal(signal.aborted, true);
  finish();
  await settle();
  const stopRetry = startAccountSync({ ...env, refresh: async () => { calls++; throw new Error("offline"); } });
  await settle();
  await env.tick();
  assert.equal(calls, 3);
  stopRetry();
});
