import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { revealCircle } from "./motion-geometry.mjs";

export const motion = {
  quick: 160,
  standard: 260,
  reveal: 420,
  ease: "cubic-bezier(.22, 1, .36, 1)",
};

export function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const running = new WeakMap<Element, Animation>();
const liveAnimations = new Set<Animation>();
let preferenceWatched = false;
export function animateMotion(
  element: Element,
  frames: Keyframe[],
  options: KeyframeAnimationOptions = {},
) {
  running.get(element)?.cancel();
  if (reducedMotion() || !element.animate) return null;
  if (!preferenceWatched) {
    preferenceWatched = true;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    preference.addEventListener("change", () => {
      if (preference.matches) liveAnimations.forEach((animation) => animation.finish());
    });
  }
  const animation = element.animate(frames, {
    duration: motion.standard,
    easing: motion.ease,
    ...options,
  });
  running.set(element, animation);
  liveAnimations.add(animation);
  animation.finished.catch(() => {}).finally(() => liveAnimations.delete(animation));
  return animation;
}

/** Reveal the opaque incoming page over a snapshot of the previous page. */
export function usePageMotion(root: RefObject<HTMLElement | null>) {
  const active = useRef<ViewTransition | null>(null);
  const revision = useRef(0);
  const pointer = useRef<{ clientX: number; clientY: number; time: number } | null>(null);
  useEffect(() => {
    const record = (event: PointerEvent) => {
      pointer.current = { clientX: event.clientX, clientY: event.clientY, time: performance.now() };
    };
    const keyboard = () => { pointer.current = null; };
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const stop = () => {
      if (!preference.matches) return;
      active.current?.skipTransition();
      if (root.current) running.get(root.current)?.cancel();
    };
    document.addEventListener("pointerdown", record, true);
    document.addEventListener("keydown", keyboard, true);
    preference.addEventListener("change", stop);
    return () => {
      document.removeEventListener("pointerdown", record, true);
      document.removeEventListener("keydown", keyboard, true);
      preference.removeEventListener("change", stop);
      active.current?.skipTransition();
      if (root.current) running.get(root.current)?.cancel();
    };
  }, [root]);

  return useCallback((update: () => void, reveal = false, direction = 1) => {
    const sequence = ++revision.current;
    active.current?.skipTransition();
    const pane = root.current;
    if (pane) running.get(pane)?.cancel();
    let applied = false;
    const apply = () => {
      if (sequence !== revision.current || applied) return;
      applied = true;
      flushSync(update);
    };
    if (!pane || reducedMotion()) {
      apply();
      return;
    }
    const recent = pointer.current && performance.now() - pointer.current.time < 800
      ? pointer.current : null;
    const trigger = document.activeElement?.getBoundingClientRect();
    const rect = pane.getBoundingClientRect();
    const origin = recent || {
      clientX: trigger?.width ? trigger.left + trigger.width / 2 : rect.left + rect.width / 2,
      clientY: trigger?.height ? trigger.top + trigger.height / 2 : rect.top + rect.height / 2,
    };
    const circle = revealCircle(origin, rect);
    const fallback = () => {
      if (sequence !== revision.current) return;
      apply();
      animateMotion(pane, [
        { opacity: 0, translate: `0 ${direction * .5}rem` },
        { opacity: 1, translate: "0 0" },
      ]);
    };
    if (!document.startViewTransition) {
      fallback();
      return;
    }
    try {
      const transition = document.startViewTransition(apply);
      active.current = transition;
      transition.ready.then(() => {
        if (sequence !== revision.current || reducedMotion()) {
          transition.skipTransition();
          return;
        }
        const frames: Keyframe[] = reveal ? [
          { clipPath: `circle(0px at ${circle.x}px ${circle.y}px)` },
          { clipPath: `circle(${circle.radius}px at ${circle.x}px ${circle.y}px)` },
        ] : [
          { opacity: 0, translate: `${direction * .75}rem 0` },
          { opacity: 1, translate: "0 0" },
        ];
        document.documentElement.animate(frames, {
          duration: reveal ? motion.reveal : motion.standard,
          easing: motion.ease,
          fill: "both",
          pseudoElement: "::view-transition-new(roamly-page)",
        }).finished.catch(() => {});
        if (!reveal) document.documentElement.animate([
          { opacity: 1, translate: "0 0" },
          { opacity: 0, translate: `${direction * -.5}rem 0` },
        ], {
          duration: motion.quick,
          easing: motion.ease,
          fill: "both",
          pseudoElement: "::view-transition-old(roamly-page)",
        }).finished.catch(() => {});
      }).catch(() => {
        if (sequence === revision.current) fallback();
      });
      transition.updateCallbackDone.catch(() => {
        if (sequence === revision.current) apply();
      });
      transition.finished.catch(() => {}).finally(() => {
        if (active.current === transition) active.current = null;
      });
    } catch {
      fallback();
    }
  }, [root]);
}

/** An exiting overlay keeps its last appearance but immediately stops input. */
export function MotionPresence({
  show,
  motionKey,
  variant = "scale",
  children,
}: {
  show: boolean;
  motionKey?: string | number | null;
  variant?: "scale" | "fade";
  children: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const last = useRef(children);
  const [retained, setRetained] = useState(show);
  if (show) last.current = children;
  useLayoutEffect(() => {
    const element = host.current?.firstElementChild;
    if (!element) return;
    if (show) setRetained(true);
    const animation = animateMotion(element, show ? [
      { opacity: 0, scale: variant === "scale" ? ".94" : "1" },
      { opacity: 1, scale: "1" },
    ] : [
      { opacity: getComputedStyle(element).opacity, scale: getComputedStyle(element).scale },
      { opacity: 0, scale: variant === "scale" ? ".97" : "1" },
    ], { duration: show ? motion.standard : motion.quick });
    if (!show) {
      if (animation) animation.finished.then(() => setRetained(false)).catch(() => {});
      else setRetained(false);
    }
    return () => animation?.cancel();
  }, [show, motionKey, variant]);
  if (!show && !retained) return null;
  return <div ref={host} className="motion-presence" inert={!show} aria-hidden={!show || undefined}>
    {show ? children : last.current}
  </div>;
}

/** A measured indicator also follows font loading, wrapping and container resize. */
export function MotionTabs({
  value,
  children,
  className = "",
  scrollable = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & { value: string | number; scrollable?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ x: number; left: number; moved: boolean } | null>(null);
  const suppressClick = useRef(0);
  useLayoutEffect(() => {
    const el = root.current;
    const selected = el?.querySelector<HTMLButtonElement>("button[aria-selected='true']");
    if (!scrollable || !el || !selected) return;
    const container = el.getBoundingClientRect();
    const rect = selected.getBoundingClientRect();
    if (rect.left < container.left + 5) el.scrollTo({ left: el.scrollLeft + rect.left - container.left - 5, behavior: reducedMotion() ? "instant" : "smooth" });
    else if (rect.right > container.right - 5) el.scrollTo({ left: el.scrollLeft + rect.right - container.right + 5, behavior: reducedMotion() ? "instant" : "smooth" });
  }, [value, scrollable]);
  useEffect(() => {
    const el = root.current;
    if (!scrollable || !el) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX) || el.scrollWidth <= el.clientWidth) return;
      event.preventDefault();
      el.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientWidth : 1);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [scrollable]);
  useLayoutEffect(() => {
    const el = root.current;
    const pill = indicator.current;
    if (!el || !pill) return;
    const measure = () => {
      const selected = el.querySelector<HTMLButtonElement>("button[aria-selected='true'], button.selected, button.active");
      if (!selected) return;
      const container = el.getBoundingClientRect();
      const rect = selected.getBoundingClientRect();
      pill.style.width = `${rect.width}px`;
      pill.style.height = `${rect.height}px`;
      pill.style.transform = `translate(${rect.left - container.left + el.scrollLeft}px, ${rect.top - container.top + el.scrollTop}px)`;
      el.dataset.motionReady = "true";
      el.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
        if (button.getAttribute("role") === "tab") button.tabIndex = button === selected ? 0 : -1;
        else button.setAttribute("aria-pressed", String(button === selected));
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    el.querySelectorAll("button").forEach((button) => observer.observe(button));
    return () => observer.disconnect();
  }, [value, children]);
  return <div {...props} ref={root} className={`${className} motion-tabs`} onPointerDown={(event) => {
    props.onPointerDown?.(event);
    if (scrollable && !event.defaultPrevented && event.pointerType === "mouse" && event.button === 0) drag.current = { x: event.clientX, left: event.currentTarget.scrollLeft, moved: false };
  }} onPointerMove={(event) => {
    props.onPointerMove?.(event);
    const current = drag.current;
    if (!current || event.defaultPrevented) return;
    if (!current.moved && Math.abs(event.clientX - current.x) < 5) return;
    current.moved = true;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add("is-dragging");
    event.currentTarget.scrollLeft = current.left - (event.clientX - current.x);
  }} onPointerUp={(event) => {
    props.onPointerUp?.(event);
    if (drag.current?.moved) suppressClick.current = Date.now() + 150;
    drag.current = null;
    event.currentTarget.classList.remove("is-dragging");
  }} onPointerCancel={(event) => {
    props.onPointerCancel?.(event);
    drag.current = null;
    event.currentTarget.classList.remove("is-dragging");
  }} onClickCapture={(event) => {
    if (Date.now() < suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = 0; }
    else props.onClickCapture?.(event);
  }} onKeyDown={(event) => {
    props.onKeyDown?.(event);
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || []);
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault();
    buttons[next].focus();
    buttons[next].click();
  }}>
    <span ref={indicator} className="motion-tab-indicator" aria-hidden="true" />
    {children}
  </div>;
}

export function useContentMotion(root: RefObject<HTMLElement | null>, key: string, selector: string) {
  useLayoutEffect(() => {
    if (!root.current || reducedMotion()) return;
    const viewport = root.current.getBoundingClientRect();
    const animations = Array.from(root.current.querySelectorAll<HTMLElement>(selector))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      }).map((el, index) => animateMotion(el, [
        { opacity: 0, translate: "0 .5rem" },
        { opacity: 1, translate: "0 0" },
      ], { delay: Math.min(index * 30, 120), fill: "backwards" }));
    return () => animations.forEach((animation) => animation?.cancel());
  }, [root, key, selector]);
}
