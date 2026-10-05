import test from "node:test";
import assert from "node:assert/strict";
import { isBaiduBaikeArticle, parseBaikePage, lookupBaiduBaike } from "../server/baike.mjs";

const place = { name: "阿万仓湿地", district: "玛曲县" };
const overview = "阿万仓湿地位于甘肃省甘南藏族自治州玛曲县，是黄河上游重要水源涵养区。这里的河流、沼泽与草甸形成高原湿地景观，可观赏草原风光。";
const html = (text = overview) => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props:{pageProps:{pageData:{lemmaTitle:"阿万仓",abstract:[{tag:"paragraph",content:[{tag:"text",text},{tag:"reference",text:"1"}]}]}}}})}</script>`;

test("百科手机版简称条目按完整景点名和区县核对，拒绝安全验证及同名异地", () => {
  const url = "https://wapbaike.baidu.com/item/阿万仓/17391174";
  assert.equal(parseBaikePage(html(), place, url).overview, overview);
  assert.equal(parseBaikePage(html(), place, url).overviewSource.title, "阿万仓_百度百科");
  assert.equal(parseBaikePage(html(), {...place,district:"夏河县"}, url), null);
  assert.equal(parseBaikePage(html(), {...place,name:"阿万仓湿地停车场"}, url), null);
  assert.equal(parseBaikePage("<title>百度安全验证</title>", place, url), null);
  assert.equal(isBaiduBaikeArticle("https://wapbaike.baidu.com.evil.com/item/阿万仓"), false);
  assert.equal(isBaiduBaikeArticle("https://wapbaike.baidu.com/tashuo/browse/content"), false);
});

test("完整名称404后读取简称真实摘要，拒绝外站重定向", async () => {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return decodeURIComponent(url).endsWith("/阿万仓湿地") ? {ok:false,status:404} : {ok:true,status:200,text:async()=>html()};
  };
  try {
    const result = await lookupBaiduBaike(place);
    assert.equal(urls.length, 2);
    assert.equal(result.overview, overview);
    assert.equal(new URL(result.overviewSource.url).hostname, "wapbaike.baidu.com");
    urls.length=0;
    globalThis.fetch = async (url) => {urls.push(url);return {status:302,headers:new Headers({location:"https://evil.com/item/阿万仓"})};};
    assert.equal(await lookupBaiduBaike(place), null);
    assert.equal(urls.some(url=>url.includes("evil.com")), false);
  } finally { globalThis.fetch = original; }
});
