// Refresh visible sessions; never overlap requests or keep them alive after cleanup.
export function startAccountSync({ refresh, window, document, intervalMs = 5000 }) {
  let stopped = false;
  let controller;
  const run = async () => {
    if (stopped || controller || document.visibilityState === "hidden" || window.navigator?.onLine === false) return;
    controller = new AbortController();
    try {
      await refresh(controller.signal);
    } catch {
      // A transient network failure is retried on the next tick or online event.
    } finally {
      controller = undefined;
    }
  };
  const timer = window.setInterval(run, intervalMs);
  window.addEventListener("focus", run);
  window.addEventListener("pageshow", run);
  window.addEventListener("online", run);
  document.addEventListener("visibilitychange", run);
  run();
  return () => {
    stopped = true;
    controller?.abort();
    window.clearInterval(timer);
    window.removeEventListener("focus", run);
    window.removeEventListener("pageshow", run);
    window.removeEventListener("online", run);
    document.removeEventListener("visibilitychange", run);
  };
}
