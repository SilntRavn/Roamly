const hosts = new Set(["baike.baidu.com", "wapbaike.baidu.com"]);

export function isBaiduBaikeArticle(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && hosts.has(url.hostname) && url.pathname.startsWith("/item/");
  } catch { return false; }
}

function abstractText(nodes) {
  return (nodes || []).map((node) => {
    if (["text", "innerlink"].includes(node.tag)) return node.text || "";
    return node.tag === "paragraph" ? abstractText(node.content) : "";
  }).join("");
}

export function parseBaikePage(html, place, url, updatedAt = new Date().toISOString()) {
  if (!isBaiduBaikeArticle(url)) return null;
  const json = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!json) return null;
  let data;
  try { data = JSON.parse(json).props?.pageProps?.pageData; } catch { return null; }
  if (!data?.lemmaTitle || data.isDeleted) return null;
  const overview = abstractText(data.abstract).trim();
  const compact = (text) => String(text || "").normalize("NFKC").replace(/\s/g, "");
  const evidence = compact(`${data.lemmaTitle}${overview}`);
  // 简称条目也必须在实际摘要中出现完整景点名，并对应地点行政区。
  const area = place.district || place.city || place.province;
  if (overview.length < 40 || !evidence.includes(compact(place.name)) || !area || !evidence.includes(compact(area))) return null;
  return {
    overview: overview.slice(0, 1200),
    overviewSource: { title: `${data.lemmaTitle}_百度百科`, url, updatedAt },
  };
}

export async function lookupBaiduBaike(place, signal) {
  const name = String(place.name || "").trim();
  const shortName = name.replace(/(?:湿地公园|湿地|风景区|景区)$/, "");
  const names = [...new Set([name, shortName])].filter(Boolean);
  for (const candidate of names) {
    let url = `https://wapbaike.baidu.com/item/${encodeURIComponent(candidate)}`;
    try {
      const timeout = AbortSignal.timeout(10000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      for (let redirects = 0; redirects < 4; redirects++) {
        if (!isBaiduBaikeArticle(url)) break;
        const response = await fetch(url, { signal: requestSignal, redirect: "manual" });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          if (!location) break;
          url = new URL(location, url).href;
          continue;
        }
        if (!response.ok) break;
        const result = parseBaikePage(await response.text(), place, url);
        if (result) return result;
        break;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      // 单个条目不可读时继续尝试简称及联网搜索，不覆盖已获取的官方资料。
    }
  }
  return null;
}
