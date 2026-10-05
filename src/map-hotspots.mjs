/**
 * Keep SDK hotspot and blank-click events in the same gesture, and only select
 * the latest requested POI. The SDK may emit both events for one hotspot tap.
 * @template T
 * @param {{resolve: (id: string, signal: AbortSignal) => Promise<T>,
 * select: (place: T) => void, dismiss: () => void,
 * loading: (value: boolean) => void, error: (message: string) => void}} handlers
 */
export function createHotspotSelection(handlers) {
  let disposed = false, version = 0, hotspotSeen = false;
  /** @type {AbortController | null} */
  let controller = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let blankTimer;
  const cancel = () => {
    version++;
    controller?.abort();
    controller = null;
    clearTimeout(blankTimer);
    if (!disposed) handlers.loading(false);
  };
  return {
    beginGesture() {
      cancel();
      hotspotSeen = false;
      handlers.error("");
    },
    blankClick() {
      if (disposed || hotspotSeen) return;
      clearTimeout(blankTimer);
      blankTimer = setTimeout(() => {
        if (disposed || hotspotSeen) return;
        cancel();
        handlers.dismiss();
      }, 0);
    },
    /** @param {{id?: string}} event */
    async hotspotClick(event) {
      if (disposed || typeof event.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(event.id)) return;
      cancel();
      hotspotSeen = true;
      const current = version;
      controller = new AbortController();
      handlers.error("");
      handlers.dismiss();
      handlers.loading(true);
      try {
        const place = await handlers.resolve(`amap-${event.id}`, controller.signal);
        if (!disposed && current === version) handlers.select(place);
      } catch (error) {
        if (!disposed && current === version)
          handlers.error(error instanceof Error ? error.message : "景点资料加载失败，请重新点击景点");
      } finally {
        if (!disposed && current === version) {
          controller = null;
          handlers.loading(false);
        }
      }
    },
    /** @param {T} place */
    select(place) {
      cancel();
      hotspotSeen = true;
      handlers.error("");
      handlers.select(place);
    },
    dismiss() { cancel(); handlers.error(""); handlers.dismiss(); },
    dispose() { disposed = true; cancel(); },
  };
}
