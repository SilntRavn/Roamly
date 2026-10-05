import { setTimeout } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { traceEvent } from "./ai-monitor.mjs";

// 一次短重试仅恢复网络中断/临时服务错误，重复同一请求，不新增规划对话轮次。
export async function serviceJson(url, options, signal) {
  const callId = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    const started = Date.now();
    let body = options.body;
    try { body = JSON.parse(body); } catch {}
    traceEvent("model.request", { callId, attempt: attempt + 1,
      endpoint: String(url).split(/[?#]/)[0], body });
    try {
      const response = await fetch(url, { ...options,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000) });
      if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
        const raw = await response.text();
        traceEvent("model.response", { callId, attempt: attempt + 1, status: response.status,
          elapsedMs: Date.now() - started, retry: true, raw });
        await setTimeout(250, undefined, { signal });
        continue;
      }
      const raw = await response.text();
      traceEvent("model.response", { callId, attempt: attempt + 1, status: response.status,
        elapsedMs: Date.now() - started, raw });
      return { response, data: JSON.parse(raw) };
    } catch (error) {
      traceEvent("model.error", { callId, attempt: attempt + 1, elapsedMs: Date.now() - started,
        name: error.name, message: error.message, canceled: Boolean(signal?.aborted) });
      if (signal?.aborted || attempt || !["TypeError", "TimeoutError", "SyntaxError"].includes(error.name)) throw error;
      await setTimeout(250, undefined, { signal });
    }
  }
}
