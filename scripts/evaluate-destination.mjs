import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
process.env.ROAMLY_DB = ":memory:";
const { planTrip } = await import("../server/planner.mjs");
const { checkPlanQuality } = await import("../server/plan-quality.mjs");
const { RequirementsSchema } = await import("../shared/requirements.mjs");
const { root, config } = await import("../server/config.mjs");

const message = "临安两日游，自驾";
const preferences = { pace: "relaxed", interests: ["自然风景"], travelers: 2, budget: null, transport: "transit" };
const trace = [];
const result = await planTrip({
  message, history: [], preferences, existing: null, userId: "destination-evaluation",
  signal: AbortSignal.timeout(180000), progress: console.log,
}, { persist: () => {}, trace: (entry) => trace.push(entry) });
const expected = RequirementsSchema.parse({ cities: ["临安"], days: 2, preferences: { ...preferences, transport: "driving" } });
const quality = result.trip ? checkPlanQuality(result.trip, result.places, expected, result.audit) : null;
const report = { checkedAt: new Date().toISOString(), model: config.aiModel, message, expected, quality, ...result, trace };
mkdirSync(path.join(root, "artifacts"), { recursive: true });
writeFileSync(path.join(root, "artifacts", "destination-evaluation.json"), JSON.stringify(report, null, 2));
assert.ok(result.trip, result.reply);
assert.deepEqual(quality.errors, []);
assert.ok(result.places.length);
assert.ok(result.places.every((place) => place.district === "临安区"), "景点必须全部属于临安区");
const legs = result.audit.days.flatMap((day) => day.legs);
const neededLegs = result.trip.days.reduce((sum, day) => sum + Math.max(0, day.items.filter((item) => item.kind === "place").length - 1), 0);
assert.equal(legs.length, neededLegs);
assert.ok(legs.every((leg) => leg.status === "verified"), "所有必要的景点间驾车路线必须经高德核验");
console.log(JSON.stringify({ pass: true, days: result.trip.days.length, transport: result.trip.preferences.transport, places: result.places.map(({ name, city, district }) => ({ name, city, district })), verifiedLegs: legs.length }, null, 2));
