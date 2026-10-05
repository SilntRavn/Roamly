import { writeFile } from "node:fs/promises";

// Use the same current data endpoint as AMap's public subway map. The old
// /subway/data files are obsolete and omit many lines.
const base = "https://map.amap.com/service/subway?srhdata=";
const response = await fetch(`${base}citylist.json`, { signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error(`City list: HTTP ${response.status}`);
const { citylist } = await response.json();
const cities = {};
for (let start = 0; start < citylist.length; start += 6) {
  await Promise.all(citylist.slice(start, start + 6).map(async (city) => {
    const file = `${city.adcode}_drw_${city.spell}.json`;
    const r = await fetch(`${base}${file}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`${city.cityname}: HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data.l)) throw new Error(`Missing lines: ${city.cityname}`);
    cities[city.cityname] = Object.fromEntries(data.l
      .filter((line) => line.su === "1" && /^[\da-f]{6}$/i.test(line.cl))
      .map((line) => [line.ln, `#${line.cl.toUpperCase()}`]));
  }));
}
const ordered = Object.fromEntries(Object.entries(cities).sort(([a], [b]) => a.localeCompare(b, "zh-CN")));
await writeFile(new URL("../shared/metro-colors.mjs", import.meta.url),
  `// AMap public subway map palette; refresh with node scripts/update-metro-colors.mjs.\n` +
  `export const metroColorSource = ${JSON.stringify({ url: "https://map.amap.com/subway/index.html", fetchedAt: new Date().toISOString() })};\n` +
  `export const metroColors = ${JSON.stringify(ordered, null, 2)};\n`);
console.log(`Updated subway colours for ${citylist.length} cities.`);
