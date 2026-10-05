(() => {
  if (window.top !== window) return;
  window.addEventListener("roamly-native-request", async (event) => {
    let call;
    try {
      call = JSON.parse(event.detail);
      const response = await browser.runtime.sendNativeMessage("roamly", call);
      const result = typeof response === "string" ? JSON.parse(response) : response;
      window.dispatchEvent(new CustomEvent("roamly-native-result", { detail: JSON.stringify({ id: call.id, result }) }));
    } catch {
      if (call?.id) window.dispatchEvent(new CustomEvent("roamly-native-result", {
        detail: JSON.stringify({ id: call.id, result: { error: "手机功能不可用，请重新打开应用" } }),
      }));
    }
  });
})();
