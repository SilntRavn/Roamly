(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const report = { ua: navigator.userAgent, viewTransitions: !!document.startViewTransition, individualRotate: CSS.supports("rotate", "1deg"), individualScale: CSS.supports("scale", "1.1"), reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches, animations: [], navigation: [], errors: [] };
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (frames, options) {
    report.animations.push({ target: this.className || this.tagName, frames, options });
    try { return animate.call(this, frames, options); } catch (error) { report.errors.push(String(error)); throw error; }
  };
  const native = (method, args) => new Promise((resolve, reject) => {
    const id = "qa-" + Date.now() + Math.random();
    const timeout = setTimeout(() => { window.removeEventListener("roamly-native-result", listener); reject(Error('Native bridge timeout')); }, 10000);
    const listener = event => { const data = JSON.parse(event.detail); if (data.id !== id) return; clearTimeout(timeout); window.removeEventListener("roamly-native-result", listener); data.result.error ? reject(Error(data.result.error)) : resolve(data.result.value); };
    window.addEventListener("roamly-native-result", listener);
    window.dispatchEvent(new CustomEvent("roamly-native-request", { detail: JSON.stringify({ id, method, args }) }));
  });
  const click = element => { if (!element) throw Error("QA element missing"); const r = element.getBoundingClientRect(); element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 })); element.click(); };
  try {
    for (let i = 0; !document.querySelector('.nav-items button') && i < 100; i++) await wait(200);
    await wait(1000);
    for (const name of ["探索", "行程", "我的", "首页"]) {
      const before = report.animations.length;
      click(document.querySelector('.nav-items button[aria-label="' + name + '"]'));
      await wait(650);
      report.navigation.push({ name, path: location.pathname, animations: report.animations.slice(before).filter(a => a.options?.pseudoElement) });
    }
    const bootstrap = await (await fetch('/api/bootstrap')).json();
    const trip = await (await fetch('/api/trips', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...bootstrap.demo.trip, title: '动画验证临时行程' }) })).json();
    report.fixtureId = trip.trip?.id;
    click(document.querySelector('.nav-items button[aria-label="行程"]')); await wait(1000);
    click(document.querySelector('button[aria-label="删除行程"]')); await wait(80);
    const card = document.querySelector('.saved-trip-card.is-delete-mode');
    if (!card) throw Error('Missing delete-mode card');
    const computed = getComputedStyle(card);
    report.wiggle = { name: computed.animationName, duration: computed.animationDuration, iterations: computed.animationIterationCount, values: [] };
    for (let i = 0; i < 12; i++) { await wait(30); report.wiggle.values.push(getComputedStyle(card).rotate); }
    click(card.querySelector('button[aria-label="删除行程"]') || card.querySelector('.trip-delete-button')); await wait(120);
    report.confirmPause = getComputedStyle(card).animationPlayState;
    click(document.querySelector('.delete-actions button')); await wait(350);
    const stamps = []; await new Promise(resolve => { const sample = t => { stamps.push(t); if (stamps.length >= 121) resolve(); else requestAnimationFrame(sample); }; requestAnimationFrame(sample); });
    report.raf = { samples: stamps.length, averageFps: 120000 / (stamps[120] - stamps[0]), maxIntervalMs: Math.max(...stamps.slice(1).map((t, i) => t - stamps[i])) };
    report.nativeCopy = await native('copy', { text: '漫迹动画验证' });
    if (report.fixtureId) await fetch('/api/trips/' + report.fixtureId, { method: 'DELETE' });
  } catch (error) { report.errors.push(String(error)); }
  try { for (const trip of await (await fetch('/api/trips')).json()) if (trip.title === '动画验证临时行程') await fetch('/api/trips/' + trip.id, { method: 'DELETE' }); } catch {}
  await native('qaReport', report);
})();
