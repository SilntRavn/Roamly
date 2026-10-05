// Native messaging is scoped to the app's trusted top-level origin.
export const isAndroidApp = /RoamlyAndroid\/1\.0/.test(navigator.userAgent);
const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
declare global {
  interface Window { roamlyNativeResult?: (id: string, result: { value?: any; error?: string; code?: number }) => void }
}
window.roamlyNativeResult = (id, result) => {
  const call = pending.get(id);
  if (!call) return;
  clearTimeout(call.timer);
  pending.delete(id);
  if (result.error) call.reject(Object.assign(new Error(result.error), { code: result.code }));
  else call.resolve(result.value);
};
window.addEventListener("roamly-native-result", (event) => {
  try {
    const { id, result } = JSON.parse((event as CustomEvent<string>).detail);
    window.roamlyNativeResult?.(id, result);
  } catch {}
});
function nativeCall<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("手机操作超时，请重试")); }, method === "saveFile" ? 300000 : 25000);
    pending.set(id, { resolve, reject, timer });
    const call = JSON.stringify({ id, method, args });
    if (navigator.userAgent.includes("RoamlyGecko")) {
      window.dispatchEvent(new CustomEvent("roamly-native-request", { detail: call }));
    } else if (window.prompt(`roamly-native:${call}`, "") !== "accepted") {
      clearTimeout(timer); pending.delete(id); reject(new Error("手机功能不可用，请重新打开应用"));
    }
  });
}
export async function copyText(text: string) {
  if (isAndroidApp) await nativeCall("copy", { text });
  else await navigator.clipboard.writeText(text);
}
export async function saveNativeFile(text: string, name: string) {
  return nativeCall<boolean>("saveFile", { text, name });
}
export const nativeGeolocation = {
  getCurrentPosition(success: (position: any) => void, failure: (error: any) => void) {
    nativeCall("location").then(success, failure);
  },
};
