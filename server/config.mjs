import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parseAmapWebKeys } from "./amap-keys.mjs";
import { resolveArkConfig } from "./ark-config.mjs";
export const root = path.resolve(import.meta.dirname, "..");
if (existsSync(path.join(root, ".env")))
  process.loadEnvFile(path.join(root, ".env"));
const local = existsSync(path.join(root, "key.txt"))
  ? readFileSync(path.join(root, "key.txt"), "utf8")
  : "";
const lines = Object.fromEntries(
  local
    .split(/\r?\n/)
    .filter((x) => /[:：=]/.test(x))
    .map((x) => {
      const i = x.search(/[:：=]/);
      return [x.slice(0, i).trim(), x.slice(i + 1).trim()];
    }),
);
const jsLine =
  Object.entries(lines).find(
    ([key]) => /高德.*JS/i.test(key) && !key.includes("底图"),
  )?.[1] || "";
const jsValues = jsLine.match(/[a-fA-F0-9]{32}/g) || [];
const securityLine =
  Object.entries(lines).find(([key]) => /高德.*(安全|密钥)/i.test(key))?.[1] ||
  "";
export const config = {
  host: process.env.ROAMLY_HOST || "0.0.0.0",
  port: Number(process.env.PORT || 4173),
  ...resolveArkConfig(local),
  amapKeys: parseAmapWebKeys(lines, process.env.AMAP_WEB_KEYS),
  amapJsKey: process.env.AMAP_JS_KEY || jsValues[0] || "",
  amapSecurity:
    process.env.AMAP_SECURITY_JS_CODE ||
    securityLine.match(/[a-fA-F0-9]{32}/)?.[0] ||
    jsValues[1] ||
    "",
  amapStyle: process.env.AMAP_MAP_STYLE || lines["高德底图js api"] || "",
};
