const defaultBase = "https://ark.cn-beijing.volces.com/api/v3";
const defaultModel = "doubao-seed-2-1-turbo-260628";

function profile(text, value = "") {
  const key = text.match(/Bearer\s+([A-Za-z0-9._-]+)/i)?.[1] ||
    (/^[A-Za-z0-9._-]{16,}$/.test(value) ? value : "");
  const model = text.match(/"model"\s*:\s*"([A-Za-z0-9._-]+)"/)?.[1] || "";
  const endpoint = text.match(/https:\/\/[^\s"'\\]+/)?.[0];
  let base = "";
  if (endpoint) {
    const url = new URL(endpoint);
    if (/\/(responses|chat\/completions)\/?$/.test(url.pathname))
      base = `${url.origin}${url.pathname.replace(/\/(responses|chat\/completions)\/?$/, "")}`;
  }
  return { key, model, base };
}

export function resolveArkConfig(local, env = process.env) {
  const headings = [...local.matchAll(/^[ \t]*(豆包\s*api[^\r\n:：=]*)[:：=][ \t]*([^\r\n]*)/gim)];
  const sections = headings.map((heading, index) => ({
    label: heading[1].trim(),
    ...profile(local.slice(heading.index, headings[index + 1]?.index ?? local.length), heading[2].trim()),
  }));
  const cheap = sections.find((section) => /低价|低智|景点|资料/.test(section.label));
  const planning = sections.find((section) => /^豆包\s*api$/i.test(section.label)) ||
    profile(headings.length ? local.slice(0, headings[0].index) : local);
  const aiKey = env.ARK_API_KEY || planning.key;
  const aiBase = env.ARK_BASE_URL || planning.base || defaultBase;
  const aiModel = env.ARK_MODEL || planning.model || defaultModel;
  return {
    aiKey, aiBase, aiModel,
    contentKey: env.ARK_CONTENT_API_KEY || cheap?.key || aiKey,
    contentBase: env.ARK_CONTENT_BASE_URL || cheap?.base || aiBase,
    contentModel: env.ARK_CONTENT_MODEL || cheap?.model || aiModel,
  };
}
