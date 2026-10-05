import test from "node:test";
import assert from "node:assert/strict";
import { resolveArkConfig } from "../server/ark-config.mjs";
const primary = `豆包api：curl https://ark.cn-beijing.volces.com/api/v3/responses
-H "Authorization: Bearer primary-test-key"
-d '{"model":"planning-lite"}'`;
const cheap = `豆包api低价低智力版（生成景点介绍、生成景点购票预约方式用这个）：curl https://content.example.com/api/v3/responses
-H "Authorization: Bearer cheap-test-key"
-d '{"model":"content-mini"}'`;

test("低价段落的 Key、模型和地址独立用于景点资料，规划保持原配置", () => {
  for (const local of [`${primary}\n${cheap}`, `${cheap}\n${primary}`]) {
    const c = resolveArkConfig(local, {});
    assert.equal(c.aiKey, "primary-test-key");
    assert.equal(c.aiModel, "planning-lite");
    assert.equal(c.aiBase, "https://ark.cn-beijing.volces.com/api/v3");
    assert.equal(c.contentKey, "cheap-test-key");
    assert.equal(c.contentModel, "content-mini");
    assert.equal(c.contentBase, "https://content.example.com/api/v3");
  }
});
test("规划环境变量不覆盖文件中的低价资料模型和密钥；专用环境变量优先", () => {
  const env = { ARK_API_KEY: "env-planning", ARK_MODEL: "env-planning-model", ARK_BASE_URL: "https://planning.example.com" };
  const c = resolveArkConfig(`${primary}\n${cheap}`, env);
  assert.equal(c.aiKey, env.ARK_API_KEY);
  assert.equal(c.contentKey, "cheap-test-key");
  assert.equal(c.contentModel, "content-mini");
  const overridden = resolveArkConfig(`${primary}\n${cheap}`, { ...env, ARK_CONTENT_API_KEY: "env-content", ARK_CONTENT_MODEL: "env-mini", ARK_CONTENT_BASE_URL: "https://env-content.example.com" });
  assert.equal(overridden.contentKey, "env-content");
  assert.equal(overridden.contentModel, "env-mini");
  assert.equal(overridden.contentBase, "https://env-content.example.com");
});
test("未配置低价版时兼容旧 curl、直接 Key 和环境变量配置", () => {
  for (const local of [primary, primary.replace(/^豆包api：/, "")]) {
    const c = resolveArkConfig(local, {});
    assert.equal(c.contentKey, c.aiKey);
    assert.equal(c.contentModel, c.aiModel);
    assert.equal(c.aiModel, "planning-lite");
  }
  assert.equal(resolveArkConfig("豆包api=direct-test-key-12345", {}).aiKey, "direct-test-key-12345");
  const c = resolveArkConfig("", { ARK_API_KEY: "env-only", ARK_MODEL: "env-model" });
  assert.equal(c.contentKey, "env-only");
  assert.equal(c.contentModel, "env-model");
});
