// 真实需求解析回归：只调用 AI，不保存行程或访问用户数据库。
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
process.env.ROAMLY_DB = ":memory:";
const { extractRequirements } = await import("../server/planner.mjs");
const { matchesDestination } = await import("../shared/requirements.mjs");
const preferences = { pace: "balanced", interests: ["自然风景"], travelers: 2, budget: null, transport: "auto" };
const cases = [
  { id: "gannan", message: "甘南6天5晚自驾，夏天去", ready: true, label: "甘南", days: 6, roadtrip: true,
    places: [{ city: "甘南藏族自治州", province: "甘肃省", district: "夏河县" }] },
  { id: "gannan-followup", message: "甘南啊", ready: true, label: "甘南", days: 6, roadtrip: true,
    history: [{ role: "user", content: "甘南6天5晚自驾，夏天去" }, { role: "assistant", content: "你想去哪个城市，计划玩几天？" }],
    places: [{ city: "甘南藏族自治州", province: "甘肃省", district: "夏河县" }] },
  { id: "qingzang", message: "青藏大环线14天自驾，从西宁出发，经青海湖、格尔木到拉萨，在拉萨结束，不走甘肃", ready: true,
    label: "青藏大环线", days: 14, roadtrip: true,
    places: [{ city: "海南藏族自治州", province: "青海省", district: "共和县" }, { city: "格尔木市", province: "青海省" }, { city: "拉萨市", province: "西藏自治区" }],
    excluded: [{ city: "敦煌市", province: "甘肃省" }] },
  { id: "qinggan", message: "青甘大环线6天自驾，西宁出发回西宁，经过青海湖、茶卡盐湖、敦煌", ready: true,
    label: "青甘大环线", days: 6, roadtrip: true,
    places: [{ city: "海南藏族自治州", province: "青海省", district: "共和县" }, { city: "海西蒙古族藏族自治州", province: "青海省", district: "乌兰县" }, { city: "敦煌市", province: "甘肃省" }],
    excluded: [{ city: "拉萨市", province: "西藏自治区" }] },
  { id: "route-clarification", message: "青藏大环线", label: "青藏大环线" },
];
const report = [];
for (const c of cases) {
  const startedAt = Date.now();
  try {
    const result = await extractRequirements({ message: c.message, history: c.history || [], preferences,
      signal: AbortSignal.timeout(90000) });
    const r = result.requirements;
    const errors = [];
    const check = (condition, description) => { if (!condition) errors.push(description); };
    check(r.destinationLabel === c.label, "保留地区或线路名称");
    check(!r.cities.some((name) => /环线/.test(name)), "线路名不能作为行政目的地");
    check(!r.cities.some((name) => /青海湖|茶卡盐湖/.test(name)), "景点名不能作为行政目的地");
    if (c.ready) {
      check(result.status === "ready", "明确需求可以开始规划");
      check(r.days === c.days, "保留旅行天数");
      check(r.preferences.transport === "driving", "保留自驾要求");
      if (c.roadtrip) check(r.routingStyle === "roadtrip", "使用公路旅行选点标准");
      for (const p of c.places || []) check(r.cities.some((d) => matchesDestination(p, d)), `范围包含${p.city}`);
      for (const p of c.excluded || []) check(!r.cities.some((d) => matchesDestination(p, d)), `范围排除${p.city}`);
    } else {
      check(result.status === "clarify", "缺少天数时澄清");
      check(Boolean(result.question) && !/哪个城市/.test(result.question), "询问具体缺项，不强迫选择城市");
    }
    report.push({ id: c.id, message: c.message, elapsedMs: Date.now() - startedAt, passed: !errors.length, errors, result });
    console.log(`${c.id}: ${errors.length ? errors.join("；") : "通过"}`);
  } catch (error) {
    report.push({ id: c.id, passed: false, error: error.message });
    console.log(`${c.id}: ${error.message}`);
  }
}
const output = path.resolve("artifacts/destination-extraction-evaluation.json");
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ evaluatedAt: new Date().toISOString(), cases: report }, null, 2));
assert.ok(report.every((c) => c.passed), `目的地解析回归失败，查看 ${output}`);
