import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Clock, Check } from "lucide-react";

export default function GlassTimePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 280, maxHeight: 320 });
  const [hour, minute] = value.split(":");
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    panel.current?.showPopover();
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const width = Math.min(Math.max(280, rect.width), window.innerWidth - 24);
      const below = window.innerHeight - rect.bottom - 16;
      const above = rect.top - 16;
      const upwards = below < 320 && above > below;
      const height = Math.min(320, upwards ? above : below);
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: upwards ? rect.top - height - 8 : rect.bottom + 8, width, maxHeight: height });
    };
    place();
    panel.current?.querySelectorAll('[aria-selected="true"]').forEach((option) => option.scrollIntoView({ block: "center" }));
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return <>
    <input type="hidden" name="arrival" value={value} />
    <button ref={trigger} type="button" className="glass-select-trigger" aria-label="到达时间" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(!open)}><span>{value}</span><Clock size={18} /></button>
    {open && createPortal(<div ref={panel} id={id} popover="manual" role="dialog" aria-label="选择到达时间" className="glass-select-menu glass-time-panel" style={position}
      onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <div className="glass-time-columns">
        {[{ title: "小时", count: 24, selected: hour }, { title: "分钟", count: 60, selected: minute }].map((column, part) => <div key={column.title} className="glass-time-column">
          <span className="glass-time-heading">{column.title}</span>
          <div role="listbox" aria-label={column.title} className="glass-time-list" onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
            const current = options.indexOf(event.target as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? column.count - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + column.count) % column.count;
            options[next].focus(); options[next].click();
          }}>
            {Array.from({ length: column.count }, (_, index) => String(index).padStart(2, "0")).map((number) => <button key={number} type="button" role="option" aria-selected={number === column.selected}
              tabIndex={number === column.selected ? 0 : -1} className="glass-select-option" onClick={(event) => { event.preventDefault(); onChange(part === 0 ? `${number}:${minute}` : `${hour}:${number}`); }}>
              {number}{number === column.selected && <Check size={15} />}
            </button>)}
          </div>
        </div>)}
      </div>
      <button type="button" className="glass-time-done" onClick={close}>确定<Check size={16} /></button>
    </div>, trigger.current?.closest("dialog") || document.body)}
  </>;
}
