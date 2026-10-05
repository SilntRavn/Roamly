import { PreferencesSchema } from "./requirements.mjs";

export function profilePreferences(stored) {
  const preferences = PreferencesSchema.parse(stored);
  // 旧产品给新账号写入的是完整默认公交偏好，无法等同于用户要求只坐公交。
  // 只升级这组旧默认值；手工配置、新版明确选择和已有行程均保持原方式。
  const legacyDefault = stored.transportChoice !== true && preferences.transport === "transit" &&
    ["balanced", "relaxed"].includes(preferences.pace) && preferences.travelers === 2 &&
    preferences.budget === null && preferences.interests.length === 1 && preferences.interests[0] === "自然风景";
  return legacyDefault ? { ...preferences, transport: "auto" } : preferences;
}
