import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { animateMotion, motion } from "./motion";
import {
  X,
  Heart,
  MapPin,
  ArrowLeft,
  Sparkles,
  Image as ImageIcon,
  LoaderCircle,
  ChevronRight,
} from "lucide-react";
import type { Place } from "./types";
import { warmPlace } from "./place-preload";
export function IconButton({
  label,
  children,
  onClick,
  className = "",
  disabled = false,
  pressed,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
  pressed?: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const previous = useRef(pressed);
  useLayoutEffect(() => {
    if (pressed !== undefined && previous.current !== pressed) {
      const icon = button.current?.querySelector("svg");
      if (icon) animateMotion(icon, [
        { scale: "1" },
        { scale: "1.18", offset: .4 },
        { scale: ".96", offset: .72 },
        { scale: "1" },
      ], { duration: 320 });
    }
    previous.current = pressed;
  }, [pressed]);
  return (
    <button
      ref={button}
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
    >
      {children}
    </button>
  );
}
export function Back({
  onClick,
  title,
  actions,
}: {
  onClick: () => void;
  title: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="header-leading">
        <IconButton label="返回" onClick={onClick}>
          <ArrowLeft size={22} />
        </IconButton>
        <h1>{title}</h1>
      </div>
      {actions}
    </header>
  );
}
export function Photo({
  place,
  className = "",
}: {
  place: Place;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [place.photo]);
  return place.photo && !failed ? (
    <img
      className={`place-photo ${className}`}
      src={place.photo}
      alt={place.name}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  ) : (
    <div className={`photo-placeholder ${className}`}>
      <MapPin size={28} />
      <span>{place.name}</span>
    </div>
  );
}
export function PlaceCard({
  place,
  onOpen,
  onFavorite,
  favorite,
}: {
  place: Place;
  onOpen: () => void;
  onFavorite: () => void;
  favorite: boolean;
}) {
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!/^amap-/.test(place.id) || !card.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        warmPlace(place, 2);
        observer.disconnect();
      }
    }, { rootMargin: "120px" });
    observer.observe(card.current);
    return () => observer.disconnect();
  }, [place.id]);
  return (
    <article className="destination-card" ref={card}>
      <button
        className="destination-main"
        onClick={onOpen}
        onPointerEnter={() => warmPlace(place)}
        onFocus={() => warmPlace(place)}
        aria-label={`查看${place.name}`}
      >
        <Photo place={place} />
        <div className="glass-caption">
          <h3>{place.name}</h3>
          <p>
            <MapPin size={16} />
            {place.country} · {place.city}
          </p>
        </div>
      </button>
      <IconButton
        className={`favorite-button ${favorite ? "is-favorite" : ""}`}
        label={favorite ? "取消景点收藏" : "收藏景点"}
        onClick={onFavorite}
        pressed={favorite}
      >
        <Heart size={22} fill={favorite ? "currentColor" : "none"} />
      </IconButton>
    </article>
  );
}
export function PlannerInput({
  value,
  onChange,
  onSubmit,
  busy = false,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy?: boolean;
}) {
  return (
    <section className="planner-card">
      <div className="planner-label">
        <Sparkles size={21} />
        <span>AI 旅行助手</span>
      </div>
      <textarea
        aria-label="旅行需求"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="想去哪儿、玩几天？说说你的想法…"
        rows={3}
        maxLength={4000}
      />
      <button className="primary" onClick={onSubmit} disabled={busy}>
        {busy ? (
          <>
            <LoaderCircle className="spin" size={19} />
            正在规划
          </>
        ) : (
          "帮我规划行程"
        )}
        <Sparkles size={18} />
      </button>
    </section>
  );
}
export function Modal({
  title,
  onClose,
  children,
  wide = false,
  closeDisabled = false,
  className = "",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  closeDisabled?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closing = useRef(false);
  const closeCallback = useRef(onClose);
  closeCallback.current = onClose;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    closing.current = false;
    el.inert = false;
    delete el.dataset.closing;
    if (!el.open) el.showModal();
    const animation = animateMotion(el, [
      { opacity: 0, translate: "0 .75rem", scale: ".98" },
      { opacity: 1, translate: "0 0", scale: "1" },
    ]);
    return () => {
      animation?.cancel();
      el.getAnimations().forEach((running) => running.cancel());
      el.close();
    };
  }, [title]);
  const requestClose = () => {
    const el = ref.current;
    if (!el || closing.current || closeDisabled) return;
    closing.current = true;
    el.inert = true;
    el.dataset.closing = "true";
    const current = getComputedStyle(el);
    const animation = animateMotion(el, [
      { opacity: current.opacity, translate: current.translate, scale: current.scale },
      { opacity: 0, translate: "0 .5rem", scale: ".98" },
    ], { duration: motion.quick });
    if (animation) animation.finished.then(() => closeCallback.current()).catch(() => {});
    else closeCallback.current();
  };
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""} ${className}`}
      onCancel={(e) => {
        e.preventDefault();
        requestClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div className="modal-content">
        <header>
          <h2>{title}</h2>
          <IconButton label="关闭" onClick={requestClose} disabled={closeDisabled}>
            <X size={20} />
          </IconButton>
        </header>
        {children}
      </div>
    </dialog>
  );
}
export function Empty({
  icon,
  children,
  action,
}: {
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon || <MapPin size={32} />}
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Row({
  icon,
  label,
  onClick,
  value,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  value?: string;
}) {
  return (
    <button className="service-row" onClick={onClick}>
      {icon}
      <span>{label}</span>
      {value && <small>{value}</small>}
      <ChevronRight size={17} />
    </button>
  );
}
