(() => {
  if (window.top !== window) return;
  window.addEventListener("roamly-native-request", async (event) => {
    let call;
    try {
      call = JSON.parse(event.detail);
      const response = await browser.runtime.sendNativeMessage("roamly", call);
      const result = typeof response === "string" ? JSON.parse(response) : response;
      window.dispatchEvent(new CustomEvent("roamly-native-result", { detail: JSON.stringify({ id: call.id, result }) }));
    } catch (error) {
      console.error("Roamly QA bridge", error);
      if (call?.id) window.dispatchEvent(new CustomEvent("roamly-native-result", { detail: JSON.stringify({ id: call.id, result: { error: String(error) } }) }));
    }
  });
  if (new URL(location.href).searchParams.get("roamlyQa") === "1") {
    const inject = () => { const script = document.createElement("script"); script.src = browser.runtime.getURL("probe.js"); document.documentElement.append(script); };
    if (document.documentElement) inject(); else document.addEventListener("DOMContentLoaded", inject, { once: true });
  }
})();
