import { useEffect, useRef } from "react";
import { ExternalLink, Copy, LoaderCircle, RotateCw } from "lucide-react";
import { Photo } from "./components";
import { copyText } from "./native";
import { reducedMotion } from "./motion";
import type { Place, PlaceContentStatus } from "./types";

export function PhotoGallery({ place }: { place: Place }) {
  const photos = [...new Set([place.photo, ...(place.photos || [])].filter(Boolean))].slice(0, 3);
  const track = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<{ pointerId: number; x: number; left: number } | null>(null);
  const photoKey = photos.join("|");
  const loop = photos.length > 1;
  const slides = loop ? [photos[photos.length - 1], ...photos, photos[0]] : photos;
  useEffect(() => {
    const element = track.current;
    if (!element) return;
    element.scrollTo({ left: loop ? element.clientWidth : 0, behavior: "instant" });
    let timer: ReturnType<typeof setTimeout>;
    let wheelAt = 0;
    const normalize = () => {
      if (drag.current) return;
      const page = Math.round(element.scrollLeft / element.clientWidth);
      if (loop && (page === 0 || page === photos.length + 1)) {
        element.scrollTo({ left: element.clientWidth * (page === 0 ? photos.length : 1), behavior: "instant" });
      }
    };
    const onScroll = () => { clearTimeout(timer); timer = setTimeout(normalize, 160); };
    const onWheel = (event: WheelEvent) => {
      if (!loop || event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      if (Date.now() - wheelAt < 450 || Math.abs(event.deltaY) < 4) return;
      wheelAt = Date.now();
      const page = Math.round(element.scrollLeft / element.clientWidth);
      element.scrollTo({ left: element.clientWidth * Math.max(0, Math.min(photos.length + 1, page + Math.sign(event.deltaY))), behavior: reducedMotion() ? "instant" : "smooth" });
    };
    element.addEventListener("scroll", onScroll);
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => { clearTimeout(timer); element.removeEventListener("scroll", onScroll); element.removeEventListener("wheel", onWheel); };
  }, [place.id, photoKey, loop, photos.length]);
  const advance = (direction: number) => {
    const element = track.current;
    if (!element || !loop) return;
    const page = Math.round(element.scrollLeft / element.clientWidth);
    element.scrollTo({ left: element.clientWidth * Math.max(0, Math.min(photos.length + 1, page + direction)), behavior: reducedMotion() ? "instant" : "smooth" });
  };
  const finishDrag = () => {
    const element = track.current;
    const current = drag.current;
    if (!element || !current) return;
    drag.current = null;
    const page = Math.max(0, Math.min(slides.length - 1, Math.round(element.scrollLeft / element.clientWidth)));
    element.classList.remove("is-dragging");
    element.scrollTo({ left: element.clientWidth * page, behavior: reducedMotion() ? "instant" : "smooth" });
    if (element.hasPointerCapture(current.pointerId)) element.releasePointerCapture(current.pointerId);
  };
  if (!photos.length) return <Photo place={place} />;
  return (
    <div className="photo-gallery" role="region" aria-label={`${place.name}照片`} aria-roledescription="轮播图">
      <div ref={track} className="photo-gallery-track" tabIndex={loop ? 0 : -1}
        aria-label="滑动或使用方向键循环切换照片"
        onDragStart={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          if (!loop || event.pointerType !== "mouse" || event.button !== 0) return;
          event.preventDefault();
          const element = event.currentTarget;
          drag.current = { pointerId: event.pointerId, x: event.clientX, left: element.scrollLeft };
          element.classList.add("is-dragging");
          element.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag.current?.pointerId === event.pointerId) event.currentTarget.scrollLeft = drag.current.left - (event.clientX - drag.current.x);
        }}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
        onTouchStart={(event) => { const point = event.touches[0]; touch.current = { x: point.clientX, y: point.clientY }; }}
        onTouchEnd={(event) => {
          const start = touch.current;
          const point = event.changedTouches[0];
          touch.current = null;
          if (start && Math.abs(point.clientY - start.y) > 40 && Math.abs(point.clientY - start.y) > Math.abs(point.clientX - start.x)) advance(point.clientY < start.y ? 1 : -1);
        }}
        onKeyDown={(event) => {
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
            event.preventDefault();
            advance(event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1);
          }
        }}>
        {slides.map((photo, number) => {
          const clone = loop && (number === 0 || number === slides.length - 1);
          return <div className="photo-gallery-slide" key={`${number}:${photo}`} role="group" aria-hidden={clone || undefined} aria-roledescription="照片" aria-label={`第 ${loop ? number : number + 1} 张，共 ${photos.length} 张`}>
            <Photo place={{ ...place, photo }} />
          </div>;
        })}
      </div>
    </div>
  );
}

export function ContentNotice({ status, onRetry, retryCount = 0 }: { status: PlaceContentStatus; onRetry: () => void; retryCount?: number }) {
  if (status === "loading") return <div className="place-content-notice" role="status"><LoaderCircle className="spin" size={15} />正在查找景点介绍与预约方式…</div>;
  if (status === "ready" || status === "empty") return <div className="place-content-notice"><button onClick={onRetry}><RotateCw size={14} />更新介绍与预约信息</button><span className="ai-rating-note">AI评分仅供参考</span></div>;
  if (status !== "error") return null;
  return <div className="place-content-notice" role="status"><span>{retryCount >= 5 ? "已自动重试5次，仍无法更新资料。已保存的信息仍可查看。" : "暂时无法更新资料，已保存的信息仍可查看。"}</span><button onClick={onRetry}><RotateCw size={14} />手动重试</button></div>;
}

const channelType = { website: "官网", miniprogram: "微信小程序", official_account: "微信公众号" };
export function BookingChannels({ place, status, notify }: { place: Place; status: PlaceContentStatus; notify: (message: string) => void }) {
  const channels = place.bookingChannels || [];
  if (!channels.length) return <p className="booking-empty">{status === "loading" ? "正在查询预约渠道…" : status === "error" ? "预约资料暂时无法获取，请重试或向景区确认。" : "暂未查到有来源支持的官方预约渠道，出发前请向景区确认。"}</p>;
  return <div className="booking-channels">
    {channels.map((channel) => <article className="booking-channel" key={`${channel.kind}:${channel.name}`}>
      <div className="booking-channel-heading"><span className="booking-type">{channelType[channel.kind]}</span><strong>{channel.name}</strong></div>
      {channel.instructions && <p>{channel.instructions}</p>}
      <div className="booking-actions">
        {channel.url && <a className="booking-link" href={channel.url} target="_blank" rel="noopener noreferrer">{channel.url === channel.source.url ? "查看购票 / 预约说明" : channel.kind === "website" ? "前往购票 / 预约" : "打开预约入口"}<ExternalLink size={14} /></a>}
        {channel.kind !== "website" && <button className="booking-copy" onClick={async () => {
          try { await copyText(channel.name); notify("已复制名称，可在微信中搜索"); }
          catch { notify("未能复制，请在微信中搜索上面的名称"); }
        }}><Copy size={14} />复制名称</button>}
      </div>
      <p className="booking-source"><a href={channel.source.url} target="_blank" rel="noopener noreferrer">{channel.url ? "查看预约说明" : "查看官方说明"}<ExternalLink size={12} /></a><span>{new Date(channel.source.updatedAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric", timeZone: "Asia/Shanghai" })} 更新</span></p>
    </article>)}
    <p className="booking-reminder">预约名额与最新要求以官方渠道为准。</p>
  </div>;
}
