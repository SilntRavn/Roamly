import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, post, downloadFile, ApiError } from "./api";
import "./ai-monitor.css";

type Summary = { id: string; conversationId: string; startedAt: string; finishedAt: string | null;
  status: string; message: string; eventCount?: number };
type TraceEvent = { sequence: number; at: string; type: string; data: any };
type Trace = Summary & { events: TraceEvent[] };
const statuses: Record<string, string> = { running: "进行中", completed: "已完成", failed: "失败", canceled: "已取消 / 超时", interrupted: "服务中断" };
const labels: Record<string, string> = { "interaction.input": "用户输入与上下文", "model.request": "实际模型请求 · 提示词与参数",
  "model.response": "模型原始返回", "model.error": "模型请求异常", "tool.result": "工具输入与结果",
  "planner.requirements": "提取并合并的用户约束", "planner.candidate": "草稿核验与修正反馈",
  "route.result": "实际交通查询", "route.audit": "完整路线核验",
  "planner.progress": "规划进度", "planner.ai": "模型调用统计", "interaction.completed": "最终输出",
  "interaction.failed": "交互失败", "interaction.canceled": "取消 / 超时" };
const time = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
const pretty = (value: unknown) => JSON.stringify(value, null, 2);

export default function AiMonitor() {
  const [access, setAccess] = useState<"checking" | "allowed" | "denied">("checking");
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [traces, setTraces] = useState<Summary[]>([]);
  const [selected, setSelected] = useState("");
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [live, setLive] = useState(true);
  const [updated, setUpdated] = useState("");
  const [revision, setRevision] = useState(0);
  const detailVersion = useRef("");
  useEffect(() => {
    let alive = true;
    let canPoll = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    detailVersion.current = "";
    async function refresh() {
      try {
        const data = await api<{ traces: Summary[] }>("/ai-monitor/traces", { signal: controller.signal });
        if (!alive) return;
        setAccess("allowed");
        setTraces(data.traces);
        if (!selected && data.traces[0]) setSelected(data.traces[0].id);
        const current = data.traces.find((item) => item.id === selected);
        if (current) {
          const version = `${current.id}:${current.eventCount}:${current.status}`;
          if (detailVersion.current !== version) {
            const detail = await api<Trace>(`/ai-monitor/traces/${encodeURIComponent(selected)}`, { signal: controller.signal });
            if (!alive) return;
            setTrace(detail); detailVersion.current = version;
          }
        } else setTrace(null);
        setError(""); setUpdated(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
      } catch (e) { if (alive) {
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
          canPoll = false; setAccess("denied"); setTrace(null); setTraces([]); setUpdated("");
        }
        setError(e instanceof ApiError && e.status === 401 ? "请使用 SilntRavn 的网站密码验证身份。" :
        e instanceof ApiError && e.status === 404 ? "监视接口尚未启用。刚更新插件后需重启项目后端；生产模式还需设置 ROAMLY_AI_MONITOR=1。" :
        e instanceof Error ? e.message : "读取失败"); } }
      finally { if (alive && live && canPoll) timer = setTimeout(refresh, 2000); }
    }
    void refresh();
    return () => { alive = false; controller.abort(); clearTimeout(timer); };
  }, [selected, live, revision]);
  async function login(event: FormEvent) {
    event.preventDefault(); if (loggingIn) return;
    setLoggingIn(true); setError("");
    try {
      await post("/auth/login", { username: "SilntRavn", password });
      setAccess("checking"); setRevision((value) => value + 1);
    } catch (e) { setError(e instanceof Error ? e.message : "身份验证失败"); }
    finally { setLoggingIn(false); setPassword(""); }
  }
  async function removeTrace() {
    if (!trace || trace.status === "running") return;
    try { await api(`/ai-monitor/traces/${encodeURIComponent(trace.id)}`, { method: "DELETE" });
      setTrace(null); setSelected(""); setRevision((v) => v + 1);
    } catch (e) { setError(e instanceof Error ? e.message : "删除失败"); }
  }
  const events = trace?.events.filter((event) => {
    const category = filter === "all" || (filter === "model" ? event.type.startsWith("model.") :
      filter === "tools" ? event.type.startsWith("tool.") || event.type.startsWith("route.") :
      filter === "tuning" ? ["planner.requirements", "planner.candidate", "route.audit"].includes(event.type) : event.type.startsWith("interaction."));
    return category && (!search || `${event.type} ${pretty(event.data)}`.toLowerCase().includes(search.toLowerCase()));
  }) || [];
  const modelResponses = trace?.events.filter((event) => event.type === "model.response") || [];
  const tokens = modelResponses.reduce((sum, event) => {
    try { return sum + (JSON.parse(event.data.raw).usage?.total_tokens || 0); } catch { return sum; }
  }, 0);
  return <div className="ai-monitor">
    <header><div><a href="/">← 漫迹项目</a><h1>路线 AI 交互监视</h1><p>实际提示词、模型参数、工具证据与每轮修正，按交互完整留档。</p></div>
      {access === "allowed" && <div className="ai-monitor-actions"><label><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />实时刷新</label>
        <button onClick={() => setRevision((v) => v + 1)}>刷新</button><small>{updated && `更新于 ${updated}`}</small></div>}</header>
    {error && <div role="alert" className="ai-monitor-error">{error}</div>}
    {access === "denied" && <form className="ai-monitor-login" onSubmit={(event) => void login(event)}>
      <h2>身份验证</h2><p>此页面仅限 SilntRavn 访问，使用该账号现有的网站密码。</p>
      <label>用户名<input name="username" autoComplete="username" value="SilntRavn" readOnly /></label>
      <label>密码<input name="password" autoComplete="current-password" type="password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button type="submit" disabled={loggingIn}>{loggingIn ? "正在验证…" : "验证并进入"}</button>
    </form>}
    {access === "checking" && <p>正在验证访问权限…</p>}
    {access === "allowed" && <>
    <p className="ai-monitor-note">仅显示当前登录账号的记录；最近 50 次已结束交互保存在本地数据库。调教详情指实际提示词、约束与修正反馈；模型内部训练和未返回的思维过程不可见。</p>
    <div className="ai-monitor-layout"><aside aria-label="交互列表"><h2>交互记录 <span>{traces.length}</span></h2>
      {!traces.length && <p>尚无记录。启用后在项目中发送一次路线规划消息，即可在此查看。</p>}
      {traces.map((item) => <button key={item.id} className={selected === item.id ? "selected" : ""}
        onClick={() => { setSelected(item.id); if (selected !== item.id) setTrace(null); }}>
        <span className={`status ${item.status}`}>{statuses[item.status] || item.status}</span>
        <strong>{item.message}</strong><small>{time(item.startedAt)}</small><small>{item.eventCount} 条事件</small>
      </button>)}
    </aside><main>{trace ? <>
      <div className="ai-monitor-detail-header"><h2>{trace.message}</h2><div className="ai-monitor-actions">
        <button onClick={() => void downloadFile(trace, `ai-trace-${trace.id}`, "json").catch((e) => setError(String(e)))}>导出 JSON</button>
        <button disabled={trace.status === "running"} onClick={() => void removeTrace()}>删除记录</button></div></div>
      <p className="ai-monitor-meta">{statuses[trace.status]} · {time(trace.startedAt)} · {modelResponses.length} 次模型返回 · {tokens ? `${tokens} tokens（服务返回的统计）` : "暂无 token 统计"}<br />交互 ID：{trace.id} · 会话 ID：{trace.conversationId}</p>
      <div className="ai-monitor-filters">{[["all", "全部事件"], ["model", "提示词 / 模型"], ["tools", "工具 / 交通"], ["tuning", "约束 / 调教"], ["io", "输入 / 输出"]].map(([value, label]) =>
        <button key={value} className={filter === value ? "selected" : ""} onClick={() => setFilter(value)}>{label}</button>)}
        <input aria-label="搜索事件内容" placeholder="搜索提示词、工具或反馈…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      <section aria-label="交互时间线">{events.map((event) => <details key={`${trace.id}:${event.sequence}`}>
        <summary><span className="ai-monitor-sequence">{event.sequence}</span><strong>{labels[event.type] || event.type}</strong>
          {event.data.name && <span>{event.data.name}</span>}{event.data.attempt && <span>第 {event.data.attempt} 次尝试</span>}
          {event.data.status && <span>HTTP {event.data.status}</span>}<small>{time(event.at)}</small></summary>
        {event.type === "model.request" && <p className="ai-monitor-meta">请求 body 包含实际 system / user / assistant / tool 消息、工具定义、temperature、max_tokens 和 thinking 配置。</p>}
        {event.type === "model.response" ? <><pre>{pretty({ ...event.data, raw: undefined })}</pre><pre>{event.data.raw}</pre></> : <pre>{pretty(event.data)}</pre>}
      </details>)}{!events.length && <p>没有匹配事件。</p>}</section>
    </> : <div className="ai-monitor-empty">选择一条交互，查看背后的完整调用过程。</div>}</main></div></>}
  </div>;
}
