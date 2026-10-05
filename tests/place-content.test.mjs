import test from "node:test";
import assert from "node:assert/strict";
process.env.ROAMLY_DB = ":memory:";
const { normalizePoi, searchPlaces, savePoi, refreshPlacePhotos } = await import("../server/amap.mjs");
const { savePlace, getPlace, db } = await import("../server/db.mjs");
const { getPlaceContent, parseContentResponse, lookupPlaceContent } = await import("../server/place-content.mjs");
const { config } = await import("../server/config.mjs");

const raw = {
  id: "photo-poi", name: "测试景区", location: "119.02,30.03",
  pname: "浙江省", cityname: "杭州市", adname: "临安区", address: "测试地址",
  photos: [
    { url: "http://images.example.com/1.jpg" }, { url: "https://images.example.com/1.jpg" },
    { url: "javascript:alert(1)" }, { url: "https://images.example.com/2.jpg" },
    { url: "https://images.example.com/3.jpg" }, { url: "https://images.example.com/4.jpg" },
  ],
};
const sourceUrl = "https://travel.example.gov.cn/scenic/intro";
const bookingUrl = "https://travel.example.gov.cn/scenic/book";
const content = {
  overview: "山间溪谷与瀑布是主要景观，可沿溪游览。",
  overviewSource: { title: "景区介绍", url: sourceUrl, updatedAt: "2026-10-04T00:00:00Z" },
  bookingChannels: [{ kind: "miniprogram", name: "景区预约", url: null, instructions: "微信搜索小程序名称后选择预约。", source: { title: "官方预约公告", url: bookingUrl, updatedAt: "2026-10-04T00:00:00Z" } }],
};

test("高德最多保存三张有效、不重复照片，第一张作为卡片主照片", () => {
  const place = normalizePoi(raw);
  assert.deepEqual(place.photos, [1, 2, 3].map((n) => `https://images.example.com/${n}.jpg`));
  assert.equal(place.photo, place.photos[0]);
  assert.deepEqual(normalizePoi({ ...raw, photos: undefined }).photos, []);
});

test("介绍和预约必须对应真实联网引用；拒绝虚构入口与非官方渠道", () => {
  const response = {
    output: [
      { type: "web_search_call", status: "completed" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "```json\n" + JSON.stringify({
        overview: content.overview, overviewSourceUrl: sourceUrl, overviewAuthority: "government",
        bookingChannels: [
          { kind: "website", name: "官方网站", url: bookingUrl, sourceUrl: bookingUrl, sourceAuthority: "official" },
          { kind: "miniprogram", name: "景区预约", nameEvidence: "微信搜索“景区预约”小程序进行预约。", url: "https://madeup.example.com/book", sourceUrl: bookingUrl, sourceAuthority: "government" },
          { kind: "miniprogram", name: "测试景区官方购票小程序", nameEvidence: "可在小程序购买测试景区的门票。", sourceUrl: bookingUrl, sourceAuthority: "official" },
          { kind: "website", name: "虚构来源", url: bookingUrl, sourceUrl: "https://madeup.example.com/source", sourceAuthority: "official" },
          { kind: "website", name: "旅行社", url: bookingUrl, sourceUrl: bookingUrl, sourceAuthority: "ota" },
        ],
      }) + "\n```\n引用来源。", annotations: [
        { type: "url_citation", url: sourceUrl, title: "景区介绍" },
        { type: "url_citation", url: bookingUrl, title: "预约公告", summary: "微信搜索“景区预约”小程序进行预约。可在小程序购买测试景区的门票。" },
      ] }] },
    ],
  };
  const result = parseContentResponse(response);
  assert.equal(result.overview, content.overview);
  assert.equal(result.overviewSource.url, sourceUrl);
  assert.equal(result.bookingChannels.length, 2);
  assert.equal(result.bookingChannels[0].url, bookingUrl);
  assert.equal(result.bookingChannels[1].url, null);
  const inventedName = structuredClone(response);
  const inventedJSON = JSON.parse(inventedName.output[1].content[0].text.split("```json\n")[1].split("\n```")[0]);
  inventedJSON.bookingChannels[1].nameEvidence = "微信搜索“景区预约”小程序进入官方预约页面。";
  inventedName.output[1].content[0].text = JSON.stringify(inventedJSON);
  assert.equal(parseContentResponse(inventedName).bookingChannels.length, 1);
  const repost = structuredClone(response);
  const repostUrl = "https://cj.sina.cn/articles/view/123/example";
  const repostJSON = JSON.parse(repost.output[1].content[0].text.split("```json\n")[1].split("\n```")[0]);
  repostJSON.bookingChannels = ["government", "official"].map((sourceAuthority) => ({ kind: "website", name: "转载的预约说明", url: repostUrl, sourceUrl: repostUrl, sourceAuthority }));
  repost.output[1].content[0].text = JSON.stringify(repostJSON);
  repost.output[1].content[0].annotations.push({ type: "url_citation", url: repostUrl, title: "转载" });
  assert.equal(parseContentResponse(repost).bookingChannels.length, 0);
  const ungrounded = structuredClone(response);
  ungrounded.output[1].content[0].annotations = [];
  assert.throws(() => parseContentResponse(ungrounded), /MissingSourceCitations/);
  assert.throws(() => parseContentResponse({ output: response.output.slice(1) }), /MissingWebSearch/);
});

test("联网结果持久化、并发合并，跨日期直接复用，只有明确刷新才重新检索", async () => {
  const place = savePoi(normalizePoi({ ...raw, id: "cached-content" }));
  let queries = 0;
  const now = Date.now();
  const options = { lookup: async () => { queries++; return content; }, now: () => now };
  const [first, second] = await Promise.all([getPlaceContent(place.id, options), getPlaceContent(place.id, options)]);
  assert.equal(queries, 1);
  assert.equal(first.status, "ready");
  assert.deepEqual(first, second);
  assert.equal(getPlace(place.id).overview, content.overview);
  assert.deepEqual(getPlace(place.id).bookingChannels, content.bookingChannels);
  await getPlaceContent(place.id, options);
  assert.equal(queries, 1);
  await getPlaceContent(place.id, { ...options, now: () => now + 8 * 86400000 });
  assert.equal(queries, 1);
  await getPlaceContent(place.id, { ...options, force: true });
  assert.equal(queries, 2);
});

test("搜索和POI刷新保留本地介绍与预约，缓存不返回旧资料", async () => {
  const place = savePlace({ ...normalizePoi(raw), ...content });
  savePoi(normalizePoi(raw));
  assert.equal(getPlace(place.id).overview, content.overview);
  const cacheKey = JSON.stringify(["administrative-v3-photos", "测试缓存内容", "临安"]);
  db.prepare("INSERT INTO search_cache VALUES(?,?,?)").run(cacheKey, JSON.stringify([normalizePoi(raw)]), Date.now() + 60000);
  assert.equal((await searchPlaces("测试缓存内容", "临安"))[0].overview, content.overview);
});

test("旧单图记录通过高德详情补齐照片，不丢失现有介绍", async () => {
  const { photos, ...legacy } = normalizePoi({ ...raw, id: "legacy-photos" });
  savePlace({ ...legacy, ...content });
  const originalFetch = globalThis.fetch;
  const originalKeys = config.amapKeys;
  config.amapKeys = ["test-key"];
  let queries = 0;
  globalThis.fetch = async (url) => {
    queries++;
    assert.match(String(url), /\/v3\/place\/detail/);
    return { json: async () => ({ status: "1", pois: [{ ...raw, id: "legacy-photos" }] }) };
  };
  try {
    const refreshed = await refreshPlacePhotos(getPlace(legacy.id));
    assert.equal(refreshed.photos.length, 3);
    assert.equal(refreshed.overview, content.overview);
    await refreshPlacePhotos(refreshed);
    assert.equal(queries, 1);
  } finally { globalThis.fetch = originalFetch; config.amapKeys = originalKeys; }
});

test("联网失败不抹掉保存信息；失败缓存避免反复调用，重试恢复", async () => {
  const place = savePlace({ ...normalizePoi({ ...raw, id: "failed-content" }), ...content });
  let queries = 0;
  const fail = async () => { queries++; throw new Error("ToolNotOpen"); };
  const first = await getPlaceContent(place.id, { force: true, lookup: fail });
  assert.equal(first.status, "error");
  assert.equal(first.diagnosticCode, "ToolNotOpen");
  assert.equal(first.place.overview, content.overview);
  await getPlaceContent(place.id, { lookup: fail });
  assert.equal(queries, 1);
  assert.equal((await getPlaceContent(place.id, { force: true, lookup: async () => content })).status, "ready");
  const empty = await getPlaceContent(place.id, { force: true, lookup: async () => ({ overview: "", overviewSource: null, bookingChannels: [] }) });
  assert.equal(empty.status, "empty");
  assert.equal(empty.place.overview, content.overview);
});

test("示例和导入快照不被联网覆盖，未知景点返回404", async () => {
  savePlace({ ...normalizePoi(raw), ...content, id: "import-snapshot" });
  const result = await getPlaceContent("import-snapshot", { lookup: async () => { throw new Error("不应调用"); } });
  assert.equal(result.status, "local");
  assert.equal(result.place.overview, content.overview);
  assert.throws(() => getPlaceContent("missing"), (error) => error.status === 404);
});

test("Responses请求启用联网工具，开通错误传递诊断且不返回密钥", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = config.contentKey;
  const originalBase = config.contentBase;
  const originalModel = config.contentModel;
  config.contentKey = "content-test-key";
  config.contentBase = "https://content.example.com/api/v3";
  config.contentModel = "content-test-mini";
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://content.example.com/api/v3/responses");
    assert.equal(options.headers.Authorization, "Bearer content-test-key");
    const request = JSON.parse(options.body);
    assert.equal(request.model, "content-test-mini");
    assert.equal(request.tools[0].type, "web_search");
    assert.equal(request.thinking.type, "disabled");
    assert.equal(request.store, false);
    return { ok: false, json: async () => ({ error: { code: "ToolNotOpen", message: "sensitive provider response" } }) };
  };
  try { await assert.rejects(() => lookupPlaceContent(normalizePoi(raw)), /^Error: ToolNotOpen$/); }
  finally { globalThis.fetch = originalFetch; config.contentKey = originalKey; config.contentBase = originalBase; config.contentModel = originalModel; }
});


test("AI评分基于联网响应，校验范围并保留一位小数", () => {
  const response = (aiRating) => ({ output: [
    { type: "web_search_call", status: "completed" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ aiRating, overview: "", bookingChannels: [] }), annotations: [{ type: "url_citation", url: sourceUrl, title: "景点介绍" }] }] },
  ] });
  assert.equal(parseContentResponse(response(4.26)).aiRating, 4.3);
  assert.equal(parseContentResponse(response(1)).aiRating, 1);
  assert.equal(parseContentResponse(response(5)).aiRating, 5);
  for (const score of [0.9, 5.1, "4.2", null]) assert.throws(() => parseContentResponse(response(score)), /InvalidAIRating/);
});

test("AI评分首次补齐并持久复用，仅手动更新改变评分，POI刷新及查询失败保留评分", async () => {
  const place = normalizePoi({ ...raw, id: "rating-cache" });
  savePlace(place);
  db.prepare("INSERT INTO place_content_cache VALUES(?,?,0)").run(`official-content-v3:${place.id}`, JSON.stringify({ status: "ready" }));
  let calls = 0;
  const options = { photos: async () => place, lookup: async () => { calls++; return { ...content, aiRating: calls === 1 ? 4.2 : 3.7 }; } };
  assert.equal((await getPlaceContent(place.id, options)).place.aiRating, 4.2);
  assert.equal((await getPlaceContent(place.id, options)).place.aiRating, 4.2);
  assert.equal(calls, 1);
  savePoi({ ...place, aiRating: null });
  assert.equal(getPlace(place.id).aiRating, 4.2);
  assert.equal((await getPlaceContent(place.id, { ...options, force: true })).place.aiRating, 3.7);
  assert.equal(calls, 2);
  const failed = await getPlaceContent(place.id, { ...options, force: true, lookup: async () => { throw new Error("offline"); } });
  assert.equal(failed.status, "error");
  assert.equal(failed.place.aiRating, 3.7);
});

test("空介绍定向补查百度百科，保留原评分和官方预约；已有介绍不额外查询", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = config.contentKey;
  config.contentKey = "test-key";
  const baikeUrl = "https://baike.baidu.com/item/拉卜楞寺/123";
  const response = (value, url) => ({ output: [
    { type: "web_search_call", status: "completed" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value), annotations: [{ type: "url_citation", url, title: "景点介绍" }] }] },
  ] });
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    if (String(_url).startsWith("https://wapbaike.baidu.com/")) return { ok: false, status: 404 };
    calls++;
    if (calls === 1) return { ok: true, json: async () => response({ overview: "", aiRating: 4.3, bookingChannels: [{kind:"website",name:"官方购票说明",sourceUrl,sourceAuthority:"government",url:sourceUrl}] }, sourceUrl) };
    assert.match(JSON.parse(options.body).input[0].content, /site:baike.baidu.com/);
    return { ok: true, json: async () => response({ overview: "百度百科提供的寺院历史与特色介绍。", overviewSourceUrl: baikeUrl, bookingChannels: [{kind:"website",name:"百科售票",sourceUrl:baikeUrl,sourceAuthority:"official"}] }, baikeUrl) };
  };
  try {
    const result = await lookupPlaceContent(normalizePoi(raw));
    assert.equal(calls, 2);
    assert.equal(result.overviewSource.url, new URL(baikeUrl).href);
    assert.equal(result.aiRating, 4.3);
    assert.equal(result.bookingChannels.length, 1);
    assert.equal(result.bookingChannels[0].name, "官方购票说明");
    calls = 0;
    globalThis.fetch = async () => { calls++; return {ok:true,json:async()=>response({overview:"官方介绍",overviewSourceUrl:sourceUrl,overviewAuthority:"government",aiRating:4.2},sourceUrl)}; };
    assert.equal((await lookupPlaceContent(normalizePoi(raw))).overview, "官方介绍");
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; config.contentKey = originalKey; }
});

test("百科兜底只接受真实引用的百度百科条目，不接受伪域名和其他来源", () => {
  for (const url of ["https://baike.baidu.com/item/寺院/123", "https://baike.baidu.com.evil.com/item/123", "https://baike.baidu.com/search/word", sourceUrl]) {
    const response = {output:[{type:"web_search_call",status:"completed"},{type:"message",role:"assistant",content:[{type:"output_text",text:JSON.stringify({overview:"百科介绍",overviewSourceUrl:url}),annotations:[{type:"url_citation",url,title:"来源"}]}]}]};
    assert.equal(parseContentResponse(response, undefined, {baikeOnly:true}).overview, url === "https://baike.baidu.com/item/寺院/123" ? "百科介绍" : "");
    response.output[1].content[0].text = JSON.stringify({overview:"伪造引用",overviewSourceUrl:"https://baike.baidu.com/item/未引用/999"});
    assert.equal(parseContentResponse(response, undefined, {baikeOnly:true}).overview, "");
  }
});

test("旧空介绍缓存补查一次，百科仍为空也持久复用", async () => {
  const place = savePlace({...normalizePoi({...raw,id:"legacy-empty-baike"}),aiRating:4.3});
  db.prepare("INSERT INTO place_content_cache VALUES(?,?,0)").run(`official-content-v3:${place.id}`,JSON.stringify({status:"empty",ratingChecked:true}));
  let calls = 0;
  const options = {photos:async()=>place,lookup:async()=>{calls++;return {overview:"",overviewSource:null,bookingChannels:[],aiRating:4.3};}};
  const result = await getPlaceContent(place.id,options);
  assert.equal(result.baikeFallbackChecked,true);
  await getPlaceContent(place.id,options);
  assert.equal(calls,1);
});

test("HTTP政府原始引用保留介绍与预约来源，购票跳转仍要求HTTPS", async () => {
  const {PlaceSchema,ContentSourceSchema} = await import('../shared/schema.mjs');
  const url='http://www.xiahe.gov.cn/info/1160/5087.htm';
  const response={output:[{type:'web_search_call',status:'completed'},{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({overview:'桑科草原的政府介绍',overviewSourceUrl:url,overviewAuthority:'government',bookingChannels:[{kind:'website',name:'官方说明',url,sourceUrl:url,sourceAuthority:'government'}],aiRating:4.2}),annotations:[{type:'url_citation',url,title:'桑科草原国家AA级旅游景区'}]}]}]};
  const result=parseContentResponse(response);
  assert.equal(result.overview,'桑科草原的政府介绍');
  assert.equal(result.overviewSource.url,url);
  assert.equal(result.bookingChannels.length,1);
  assert.equal(result.bookingChannels[0].url,null);
  assert.equal(PlaceSchema.safeParse({...normalizePoi(raw),...result}).success,true);
  for(const unsafe of ['javascript:alert(1)','file:///temp/a','http://user:password@example.gov.cn/a'])assert.equal(ContentSourceSchema.safeParse({title:'来源',url:unsafe,updatedAt:'2026-10-05'}).success,false);
});

test("已有介绍无论缺缓存、缺评分或旧失败状态，普通访问都不联网，手动更新才查询", async () => {
  const {getCachedPlaceContent}=await import('../server/place-content.mjs');
  for(const state of [null,'ready','error']){
    const p=savePlace({...normalizePoi({...raw,id:`preserve-overview-${state}`}),...content,aiRating:null});
    if(state)db.prepare('INSERT INTO place_content_cache VALUES(?,?,0)').run(`official-content-v3:${p.id}`,JSON.stringify({status:state,automaticRetries:0}));
    let calls=0;
    const options={photos:async()=>p,lookup:async()=>{calls++;return {...content,overview:'手动获取的新介绍',aiRating:4.5};}};
    assert.equal(getCachedPlaceContent(p.id).status,'ready');
    assert.equal((await getPlaceContent(p.id,options)).place.overview,content.overview);
    assert.equal(calls,0);
    assert.equal(getPlace(p.id).aiRating,null);
    assert.equal((await getPlaceContent(p.id,{...options,force:true})).place.overview,'手动获取的新介绍');
    assert.equal(calls,1);
  }
});
