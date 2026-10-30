"use client";

import { cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { cn } from "./cn";

type Side = "top" | "bottom";

const POSITION: Record<Side, string> = {
  top: "bottom-full left-1/2 pb-2",
  bottom: "top-full left-1/2 pt-2",
};

/**
 * Short, non-interactive hint for an icon button or truncated text. Opens on hover (after a short delay) and on keyboard
 * focus, closes on Escape, blur and pointer leave, and stays open while the pointer is over the bubble.
 * Never put essential information or links in a tooltip.
 */
export function Tooltip({ content, children, side = "top", delay = 350, className }: { content: ReactNode; children: ReactNode; side?: Side; delay?: number; className?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [placed, setPlaced] = useState<{ side: Side; dx: number }>({ side, dx: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bubble = useRef<HTMLSpanElement>(null);

  const show = useCallback((wait: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), wait);
  }, []);
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setOpen(false);
    setPlaced({ side, dx: 0 });
  }, [side]);

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
    };
  }, [open, hide]);

  useLayoutEffect(() => {
    if (!open || !bubble.current) return;
    const rect = bubble.current.getBoundingClientRect();
    const margin = 8;
    const flip: Side = side === "top" && rect.top < margin ? "bottom" : side === "bottom" && rect.bottom > window.innerHeight - margin ? "top" : side;
    const dx = rect.left < margin ? margin - rect.left : rect.right > window.innerWidth - margin ? window.innerWidth - margin - rect.right : 0;
    setPlaced({ side: flip, dx });
  }, [open, side]);

  const child = isValidElement(children)
    ? cloneElement(children as ReactElement<{ "aria-describedby"?: string }>, {
        "aria-describedby": [(children.props as { "aria-describedby"?: string })["aria-describedby"], id].filter(Boolean).join(" "),
      })
    : children;

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => show(delay)}
      onMouseLeave={hide}
      onFocus={() => show(0)}
      onBlur={hide}
    >
      {child}
      <span
        ref={bubble}
        id={id}
        role="tooltip"
        hidden={!open}
        style={{ transform: `translateX(calc(-50% + ${placed.dx}px))` }}
        className={cn("absolute z-(--z-tooltip) w-max max-w-64", POSITION[placed.side], className)}
      >
        <span className="ui-fade-in block rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium text-background shadow-pop">{content}</span>
      </span>
    </span>
  );
}
