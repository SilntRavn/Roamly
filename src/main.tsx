import { createRoot } from "react-dom/client";
import { lazy, Suspense } from "react";
import App from "./App";
const AiMonitor = lazy(() => import("./AiMonitor"));
import "./styles.css";
createRoot(document.getElementById("root")!).render(
  window.location.pathname === "/ai-monitor"
    ? <Suspense fallback={<p>正在验证访问权限…</p>}><AiMonitor /></Suspense> : <App />,
);
