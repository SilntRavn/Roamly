import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export default function GlassSelect({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selected = Math.max(0, options.findIndex((option) => option.value === value));
  const [active, setActive] = useState(selected);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 260 });
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    menu.current?.showPopover();
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const height = Math.min(260, options.length * 46 + 18);
      const below = window.innerHeight - rect.bottom - 16;
      const above = rect.top - 16;
      const upwards = below < height && above > below;
      const maxHeight = Math.max(46, Math.min(height, upwards ? above : below));
      setPosition({ left: rect.left, top: upwards ? rect.top - maxHeight - 8 : rect.bottom + 8, width: rect.width, maxHeight });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, options.length]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  useEffect(() => { if (open) menu.current?.querySelector(`#${CSS.escape(`${id}-${active}`)}`)?.scrollIntoView({ block: "nearest" }); }, [active, open, id]);
  const choose = (index: number) => { onChange(options[index].value); setOpen(false); trigger.current?.focus(); };
  return <>
    <button ref={trigger} type="button" className="glass-select-trigger" role="combobox" aria-label={label}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} aria-activedescendant={open ? `${id}-${active}` : undefined}
      onClick={() => { setActive(selected); setOpen(!open); }}
      onBlur={(event) => { if (!menu.current?.contains(event.relatedTarget as Node)) setOpen(false); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); setOpen(false); return; }
        if (event.key === "Tab") { setOpen(false); return; }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          setOpen(true);
          setActive(event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : open ? (active + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length : selected);
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (open) choose(active); else { setActive(selected); setOpen(true); }
        }
      }}>
      <span>{options[selected]?.label}</span><ChevronDown size={18} className={open ? "is-open" : ""} />
    </button>
    {open && createPortal(<div ref={menu} id={id} popover="manual" role="listbox" aria-label={label} className="glass-select-menu" style={position}
      onPointerDown={(event) => event.preventDefault()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>
      {options.map((option, index) => <div key={option.value} id={`${id}-${index}`} role="option" aria-selected={option.value === value}
        className={`glass-select-option ${index === active ? "is-active" : ""}`} onPointerMove={() => setActive(index)} onClick={() => choose(index)}>
        <span>{option.label}</span>{option.value === value && <Check size={17} />}
      </div>)}
    </div>, trigger.current?.closest("dialog") || document.body)}
  </>;
}
