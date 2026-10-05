import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
process.env.ROAMLY_DB = ":memory:";
const { planTrip } = await import("../server/planner.mjs");
const { RequirementsSchema, defaultRequirements } =
  await import("../shared/requirements.mjs");
const { checkPlanQuality } = await import("../server/plan-quality.mjs");
const { searchPlaces } = await import("../server/amap.mjs");
const { root, config } = await import("../server/config.mjs");
const preferences = {
  pace: "relaxed",
  interests: ["自然风景"],
  travelers: 2,
  budget: null,
  transport: "transit",
};
const cases = [
  {
    id: "gannan-roadtrip", message: "甘南6天5晚自驾，夏天去",
    preferences: { ...preferences, pace: "balanced", transport: "auto" },
    expected: { cities: ["甘南"], destinationLabel: "甘南", days: 6, routingStyle: "roadtrip",
      preferences: { ...preferences, pace: "balanced", transport: "driving" } },
  },
  {
    id: "flexible-city-outskirts", message: "杭州三日游，前两天市区里玩，第三天去临安",
    preferences: { ...preferences, pace: "balanced", transport: "auto" },
    expected: { cities: ["杭州", "临安"], days: 3, preferences: { ...preferences, pace: "balanced", transport: "auto" } },
    rejectWarnings: ["day_underfilled"],
  },
  {
    id: "flexible-coast", message: "宁波两日游，市区和郊区分别安排，每天充实一点",
    preferences: { ...preferences, pace: "balanced", transport: "auto" },
    expected: { cities: ["宁波"], days: 2, preferences: { ...preferences, pace: "balanced", transport: "auto" } },
  },
  {
    id: "city-outskirts", message: "杭州三日游，前两天市区里玩，第三天去临安",
    preferences: { ...preferences, pace: "balanced" },
    expected: { cities: ["杭州", "临安"], days: 3, preferences: { ...preferences, pace: "balanced" } },
    rejectWarnings: ["day_underfilled"],
  },
  {
    id: "regional-coast", message: "宁波两日游",
    preferences: { ...preferences, pace: "balanced" },
    expected: { cities: ["宁波"], days: 2, preferences: { ...preferences, pace: "balanced" } },
  },
  {
    id: "regional-inland", message: "成都玩2天，2个人打车，正常充实节奏，必去武侯祠、锦里和青城山。",
    preferences: { ...preferences, pace: "balanced", transport: "driving" },
    expected: { cities: ["成都"], days: 2, preferences: { ...preferences, pace: "balanced", transport: "driving" },
      requiredPlaces: [{ name: "武侯祠", city: "成都" }, { name: "锦里", city: "成都" }, { name: "青城山", city: "成都" }] },
  },
  {
    id: "regional-roadtrip", message: "伊宁市和特克斯县玩2天，2个人自驾，是跨城沿途的长距离公路旅行，接受长途赶路。必去喀赞其和特克斯八卦城，白天游览，不安排夜游。",
    preferences: { ...preferences, pace: "balanced", transport: "driving" },
    expected: { cities: ["伊宁市", "特克斯县"], days: 2, routingStyle: "roadtrip", nightTour: "avoid",
      preferences: { ...preferences, pace: "balanced", transport: "driving" },
      requiredPlaces: [{ name: "喀赞其", city: "伊宁市" }, { name: "八卦城", city: "特克斯县" }] },
  },
  {
    id: "daytime",
    message: "杭州玩1天，2个人打车，第一次来，做一份正常节奏的攻略，晚上不玩。",
    preferences: { ...preferences, pace: "balanced", transport: "driving" },
    expected: { cities: ["杭州"], days: 1, nightTour: "avoid",
      preferences: { ...preferences, pace: "balanced", transport: "driving" } },
    rejectWarnings: ["day_underfilled"],
  },
  {
    id: "night",
    message: "南京玩1天，2个人打车，一天多看一些，白天游览之外晚上还想去夫子庙秦淮河看夜景。",
    preferences: { ...preferences, pace: "balanced", transport: "driving" },
    expected: { cities: ["南京"], days: 1, nightTour: "prefer",
      preferences: { ...preferences, pace: "balanced", transport: "driving" } },
    rejectWarnings: ["day_underfilled", "night_missing"],
  },
  ...["summer", "winter"].map((season) => ({
    id: `xinjiang-${season}`,
    message: `乌鲁木齐玩1天，${season === "summer" ? "2027年6月21日" : "2026年12月21日"}出发，2个人打车，按正常充实节奏和当地白昼安排，晚上不安排夜游。`,
    preferences: { ...preferences, pace: "balanced", transport: "driving" },
    expected: { cities: ["乌鲁木齐"], days: 1, nightTour: "avoid",
      startDate: season === "summer" ? "2027-06-21" : "2026-12-21",
      preferences: { ...preferences, pace: "balanced", transport: "driving" } },
    rejectWarnings: ["day_underfilled"],
  })),
  {
    id: "family",
    message:
      "杭州玩2天，2个大人和一个5岁孩子，坐公交地铁。必去西湖和灵隐寺，每天9:30后出发、17:00前结束，每天最多2个景点，午餐和休息每天至少90分钟，不要安排购物。",
    expected: {
      cities: ["杭州"],
      days: 2,
      preferences: { ...preferences, travelers: 3 },
      childrenAges: [5],
      requiredPlaces: [
        { name: "西湖", city: "杭州" },
        { name: "灵隐寺", city: "杭州" },
      ],
      dailyStart: "09:30",
      dailyEnd: "17:00",
      maxDailyStops: 2,
      minRestMinutes: 90,
    },
  },
  {
    id: "fixed",
    message:
      "南京1天，2个人打车慢游。10:00到总统府，至少游览120分钟；还要去南京博物院，不要去中山陵。每天最多2个景点，18点前结束。",
    expected: {
      cities: ["南京"],
      days: 1,
      preferences: { ...preferences, transport: "driving" },
      requiredPlaces: [
        { name: "总统府", city: "南京" },
        { name: "南京博物院", city: "南京" },
      ],
      excludedPlaces: ["中山陵"],
      fixedVisits: [
        {
          placeId: null,
          name: "总统府",
          day: 1,
          arrival: "10:00",
          durationMinutes: 120,
          durationRule: "minimum",
        },
      ],
      maxDailyStops: 2,
      dailyEnd: "18:00",
    },
  },
  {
    id: "elder",
    message:
      "苏州2天，2个大人，其中一位70岁，主要打车。要去拙政园和苏州博物馆，每天10点后出发、16:30前结束，最多2个景点。每天交通接驳步行不要超过1500米，不要求确认景区内的步行距离。",
    expected: {
      cities: ["苏州"],
      days: 2,
      preferences: { ...preferences, transport: "driving" },
      hasElderly: true,
      requiredPlaces: [
        { name: "拙政园", city: "苏州" },
        { name: "苏州博物馆", city: "苏州" },
      ],
      dailyStart: "10:00",
      dailyEnd: "16:30",
      maxDailyStops: 2,
      maxWalkingMeters: 1500,
    },
  },
  {
    id: "impossible",
    message:
      "北京1天，只能9点到10点玩，故宫和颐和园必须各玩120分钟，两个都不能删除，出行打车。",
    expectClarification: true,
  },
];
const args = process.argv.slice(2);
const outputArgument = args.find((arg) => arg.startsWith("--output="));
const reportPath = path.resolve(root, outputArgument?.slice("--output=".length) || "artifacts/planner-evaluation.json");
const markdownPath = reportPath.replace(/\.json$/, "") + ".md";
const repeat = Math.min(5, Math.max(1, Number(args.find((arg) => arg.startsWith("--repeat="))?.slice(9)) || 1));
const filter = args.filter((arg) => !arg.startsWith("--output=") && !arg.startsWith("--repeat="));
if (filter.includes("--report-only")) {
  writeMarkdown(
    JSON.parse(
      readFileSync(
        reportPath,
        "utf8",
      ),
    ),
  );
  console.log(`已从现有结果生成 ${path.relative(root, markdownPath)}，未调用外部服务`);
  process.exit(0);
}
const report = {
  model: config.aiModel,
  startedAt: new Date().toISOString(),
  cases: [],
  note: "调用真实豆包与高德，使用独立内存数据库；通过代表本组可检查要求，不证明任意行程全局最优。",
};
async function run(c, existing = null) {
  const start = Date.now();
  const stages = [],
    trace = [];
  console.log(`开始 ${c.id}`);
  try {
    const result = await planTrip(
      {
        message: c.message,
        history: [],
        preferences: c.preferences || preferences,
        existing,
        userId: "evaluation",
        signal: AbortSignal.timeout(240000),
        progress: (content) => {
          if (stages.at(-1) !== content) {
            stages.push(content);
            console.log(`${c.id} ${content}`);
          }
        },
      },
      {
        persist: () => {},
        trace: (entry) => {
          trace.push(entry);
          report.activeCase = { id: c.id, trace };
          writeJsonReport();
        },
      },
    );
    const expected = c.expected ? RequirementsSchema.parse(c.expected) : null;
    const issues =
      result.trip && expected
        ? checkPlanQuality(result.trip, result.places, expected, result.audit)
            .issues.filter((i) => i.severity === "error" || c.rejectWarnings?.includes(i.code))
        : [];
    const pass = c.expectClarification
      ? !result.trip && Boolean(result.reply)
      : Boolean(result.trip) && !issues.length;
    const entry = {
      id: c.id,
      message: c.message,
      expected: c.expected || null,
      pass,
      seconds: Math.round((Date.now() - start) / 1000),
      issues,
      reply: result.reply,
      trip: result.trip,
      audit: result.audit,
      places: result.places,
      trace,
    };
    report.cases.push(entry);
    delete report.activeCase;
    writeJsonReport();
    console.log(
      `${c.id} ${pass ? "通过" : "未通过"} ${entry.seconds}秒；核验路段 ${result.audit?.days.flatMap((d) => d.legs).filter((l) => l.status === "verified").length || 0}`,
    );
    return result;
  } catch (error) {
    report.cases.push({
      id: c.id,
      pass: false,
      seconds: Math.round((Date.now() - start) / 1000),
      error: error.message,
      trace,
    });
    delete report.activeCase;
    writeJsonReport();
    console.log(`${c.id} 未通过：${error.message}`);
    return null;
  }
}
for (const c of cases.filter((c) => !filter.length || filter.includes(c.id)))
  for (let iteration = 1; iteration <= repeat; iteration++)
    await run({ ...c, id: repeat > 1 ? `${c.id}-${iteration}` : c.id });
if (!filter.length || filter.includes("manual")) {
  const places = [];
  for (const name of ["灵隐寺", "岳王庙", "浙江省博物馆孤山馆区"]) {
    const results = await searchPlaces(
      name,
      "杭州",
      AbortSignal.timeout(15000),
    );
    const place = results.find((p) => !/停车|入口|游客中心/.test(p.name));
    if (!place) throw new Error(`手工测试缺少真实地点：${name}`);
    places.push(place);
  }
  const trip = {
    id: "manual-eval",
    title: "手工杭州行程",
    city: "杭州",
    summary: "",
    preferences: { ...preferences, transport: "driving" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    days: [
      {
        index: 1,
        date: null,
        title: "手工景点",
        items: places.map((p, i) => ({
          id: `manual-${i}`,
          kind: "place",
          placeId: p.id,
          title: p.name,
          arrival: `${9 + i * 3}:00`.padStart(5, "0"),
          durationMinutes: 90,
          notes: "",
        })),
      },
    ],
  };
  trip.requirements = defaultRequirements(trip);
  const changed = await run(
    {
      id: "manual-retain",
      message:
        "请按我的这些手工景点重新排得顺路一点，10点以后再出发，19点前结束，景点都要保留，中午留60分钟吃饭。",
      expected: {
        ...trip.requirements,
        dailyStart: "10:00",
        dailyEnd: "19:00",
      },
    },
    trip,
  );
  if (changed?.trip) {
    const retained = places.slice(1).map((p) => p.id);
    await run(
      {
        id: "manual-remove",
        message: `${places[0].name}不去了，删除这一站，剩下的都保留，其他要求不变。`,
        expected: {
          ...changed.trip.requirements,
          requiredPlaceIds: retained,
          requiredPlaces: [],
          excludedPlaces: [places[0].name],
        },
      },
      changed.trip,
    );
  }
}
report.finishedAt = new Date().toISOString();
report.passed = report.cases.filter((c) => c.pass).length;
report.total = report.cases.length;
writeJsonReport();
writeMarkdown(report);
console.log(
  `结果 ${report.passed}/${report.total}，已保存 ${path.relative(root, reportPath)}`,
);
if (report.passed !== report.total) process.exitCode = 1;

function writeJsonReport() {
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

function writeMarkdown(result) {
  const labels = {
    daytime: "默认全天游览",
    night: "完整白天与夜游",
    "xinjiang-summer": "新疆夏季白昼与晚出晚归",
    "xinjiang-winter": "新疆冬季白昼与提前收尾",
    family: "带娃慢游",
    fixed: "固定到达与最短停留",
    elder: "长者与少走路",
    impossible: "无法兼容的时长要求",
    "manual-retain": "保留手工景点再规划",
    "manual-remove": "继续对话删除一站",
  };
  const rows = result.cases.map((c) => {
    const verified =
      c.audit?.days
        .flatMap((d) => d.legs)
        .filter((l) => l.status === "verified").length || 0;
    const needed =
      c.trip?.days.reduce(
        (sum, d) =>
          sum +
          Math.max(0, d.items.filter((i) => i.kind === "place").length - 1),
        0,
      ) || 0;
    return `| ${labels[c.id] || c.id} | ${c.pass ? "通过" : "未通过"} | ${c.seconds} 秒 | ${verified}/${needed} |`;
  });
  const content = `# 漫迹 AI 规划验证\n\n${result.passed}/${result.total} 组真实调用通过本组可检查规则。模型为 ${result.model}，完成于 ${result.finishedAt}。使用独立内存数据库，没有写入用户行程或评论。\n\n| 案例 | 结果 | 单次耗时 | 已核验/必要景点间路段 |\n| --- | --- | --- | --- |\n${rows.join("\n")}\n\n“通过”表示候选符合案例的可检查约束，或面对无法兼容的要求返回澄清而不保存无效行程。默认节奏案例还要求没有白天过早结束的提醒；夜游案例还要求存在晚间项目。未知营业时间、预约、景区内步行及无障碍仍需来源核实，核验路段不含住宿/出发地接驳。\n\n新疆白昼参考使用 [NOAA 近似太阳位置公式](https://gml.noaa.gov/grad/solcalc/solareqns.PDF)，按实际地点坐标与日期估算并统一为北京时间，不代表天气、山体遮挡、开放时间或灯光时间。此组结果不证明任意路线全局最优，服务与模型结果也可能随时间变化。\n\n完整需求、实际日程、逐段路线、修正记录与提醒见 [原始结果](${path.basename(reportPath)})。可用 npm run eval:planner 重新评估；--output=artifacts/自定义名称.json 可分别保存各轮结果，--report-only 可从已有结果生成本文而不调用外部服务。\n`;
  mkdirSync(path.dirname(markdownPath), { recursive: true });
  writeFileSync(markdownPath, content);
}
