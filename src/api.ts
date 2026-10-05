import { isAndroidApp, saveNativeFile } from "./native";
export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}
export async function api<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`/api${url}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await res.json();
  if (!res.ok) throw new ApiError(data.error || "请求失败，请稍后重试", res.status, data.code);
  return data;
}
export const post = <T>(url: string, body?: unknown) =>
  api<T>(url, { method: "POST", body: JSON.stringify(body || {}) });
export const patch = <T>(url: string, body: unknown) =>
  api<T>(url, { method: "PATCH", body: JSON.stringify(body) });
export async function downloadFile(file: unknown, name: string, extension: "roamly" | "json" = "roamly") {
  const filename = `${name.replace(/[<>:"/\\|?*]/g, "-")}.${extension}`;
  if (isAndroidApp) return saveNativeFile(JSON.stringify(file, null, 2), filename);
  const blob = new Blob([JSON.stringify(file, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
export async function streamChat(
  body: unknown,
  signal: AbortSignal,
  onEvent: (event: string, data: any) => void,
) {
  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) {
    const data = await r.json();
    throw new ApiError(data.error || "规划失败", r.status, data.code);
  }
  if (!r.body) throw new Error("服务未返回内容");
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = block
        .split("\n")
        .find((x) => x.startsWith("event: "))
        ?.slice(7);
      const data = block
        .split("\n")
        .find((x) => x.startsWith("data: "))
        ?.slice(6);
      if (event && data) onEvent(event, JSON.parse(data));
    }
  }
}
