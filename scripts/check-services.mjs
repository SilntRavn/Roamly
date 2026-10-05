import { config } from "../server/config.mjs";
for (let i = 0; i < config.amapKeys.length; i++) {
  try {
    const url = new URL("https://restapi.amap.com/v3/place/text");
    url.search = new URLSearchParams({
      key: config.amapKeys[i],
      keywords: "西湖",
      city: "杭州",
      offset: "1",
      extensions: "all",
    });
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const d = await r.json();
    console.log(
      JSON.stringify({
        service: `高德 Web Key ${i + 1}`,
        status: d.status,
        info: d.info,
        poi: d.pois?.[0]?.name,
      }),
    );
  } catch {
    console.log(
      JSON.stringify({ service: `高德 Web Key ${i + 1}`, error: "连接失败" }),
    );
  }
}
if (config.aiKey) {
  try {
    const r = await fetch(`${config.aiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.aiKey}`,
      },
      body: JSON.stringify({
        model: config.aiModel,
        messages: [{ role: "user", content: "只回答：连接成功" }],
        max_tokens: 32,
        thinking: { type: "disabled" },
      }),
      signal: AbortSignal.timeout(30000),
    });
    const d = await r.json();
    console.log(
      JSON.stringify({
        service: "豆包",
        model: config.aiModel,
        status: r.status,
        result: d.choices?.[0]?.message?.content,
        errorCode: d.error?.code,
      }),
    );
  } catch {
    console.log(JSON.stringify({ service: "豆包", error: "连接失败" }));
  }
}
