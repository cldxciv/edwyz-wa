"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui";
import { NODE_META, cardSummary, handlesOf, isBranching } from "./catalog";
import { NODE_W, bounds, edgePath, inputPosition, nodeHeight, portPosition } from "./layout";
import { screenToCanvas, zoomAt, type View } from "./viewport";
import type { FlowDefinition, FlowNode, Point } from "./types";

type Drag =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  | { kind: "node"; id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean }
  | { kind: "link"; from: string; label: string | undefined; edgeId?: string; at: Point };

export type CanvasProps = {
  flow: FlowDefinition;
  view: View;
  onView: (v: View) => void;
  selectedId: string | null;
  selectedEdgeId: string | null;
  badNodes: Set<string>;
  warnNodes: Set<string>;
  readOnly?: boolean;
  /** True on phones and small touch screens: the canvas scrolls and shows a fixed scale instead of dragging and zooming. */
  compact?: boolean;
  /** A step was clicked, tapped or opened with Enter (not dragged). Lets the page bring its settings into view. */
  onActivate?: (id: string) => void;
  onSelect: (id: string | null) => void;
  onSelectEdge: (id: string | null) => void;
  onMove: (id: string, p: Point) => void;
  onMoveEnd: () => void;
  onConnect: (from: string, label: string | undefined, to: string) => void;
  onReconnect: (edgeId: string, to: string) => void;
  onDelete: (id: string) => void;
  onSize: (w: number, h: number) => void;
};

export const CANVAS_ID = "cb-canvas";

export function Canvas(p: CanvasProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const viewRef = useRef(p.view);
  viewRef.current = p.view;
  const propsRef = useRef(p);
  propsRef.current = p;
  const compact = Boolean(p.compact);
  const locked = p.readOnly || compact;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => propsRef.current.onSize(el.clientWidth, el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || locked) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0015);
      propsRef.current.onView(zoomAt(viewRef.current, factor, e.clientX - r.left, e.clientY - r.top));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [locked]);

  const setDragBoth = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };

  const local = (e: { clientX: number; clientY: number }) => {
    const r = ref.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  function onBackgroundDown(e: React.PointerEvent) {
    if (locked || e.button !== 0) return;
    p.onSelect(null);
    p.onSelectEdge(null);
    ref.current?.setPointerCapture(e.pointerId);
    setDragBoth({ kind: "pan", sx: e.clientX, sy: e.clientY, vx: p.view.x, vy: p.view.y });
  }

  function onNodeDown(e: React.PointerEvent, node: FlowNode) {
    e.stopPropagation();
    p.onSelect(node.id);
    p.onSelectEdge(null);
    if (locked || e.button !== 0) return;
    ref.current?.setPointerCapture(e.pointerId);
    setDragBoth({ kind: "node", id: node.id, sx: e.clientX, sy: e.clientY, ox: node.position.x, oy: node.position.y, moved: false });
  }

  function startLink(e: React.PointerEvent, node: FlowNode, label: string | undefined, edgeId?: string) {
    e.stopPropagation();
    if (locked || e.button !== 0) return;
    ref.current?.setPointerCapture(e.pointerId);
    const c = screenToCanvas(p.view, local(e).x, local(e).y);
    setDragBoth({ kind: "link", from: node.id, label, edgeId, at: c });
  }

  function onMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === "pan") p.onView({ ...p.view, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy });
    else if (d.kind === "node") {
      const dx = (e.clientX - d.sx) / p.view.k;
      const dy = (e.clientY - d.sy) / p.view.k;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      dragRef.current = { ...d, moved: true };
      p.onMove(d.id, { x: Math.round(d.ox + dx), y: Math.round(d.oy + dy) });
    } else setDragBoth({ ...d, at: screenToCanvas(p.view, local(e).x, local(e).y) });
  }

  function onUp(e: React.PointerEvent) {
    const d = dragRef.current;
    setDragBoth(null);
    if (!d) return;
    if (d.kind === "node" && d.moved) p.onMoveEnd();
    if (d.kind === "node" && !d.moved) p.onActivate?.(d.id);
    if (d.kind === "link") {
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
      if (!target || target === d.from) return;
      if (d.edgeId) p.onReconnect(d.edgeId, target);
      else p.onConnect(d.from, d.label, target);
    }
  }

  function onNodeKey(e: React.KeyboardEvent, node: FlowNode) {
    if (e.target !== e.currentTarget) return;
    const step = e.shiftKey ? 40 : 10;
    const move = (dx: number, dy: number) => {
      e.preventDefault();
      if (p.readOnly) return;
      p.onMove(node.id, { x: node.position.x + dx, y: node.position.y + dy });
    };
    if (e.key === "ArrowLeft") move(-step, 0);
    else if (e.key === "ArrowRight") move(step, 0);
    else if (e.key === "ArrowUp") move(0, -step);
    else if (e.key === "ArrowDown") move(0, step);
    else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      p.onDelete(node.id);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      p.onSelect(node.id);
      p.onActivate?.(node.id);
    }
  }

  function onNodeKeyUp(e: React.KeyboardEvent) {
    if (e.target !== e.currentTarget || p.readOnly) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") p.onMoveEnd();
  }

  const byId = new Map(p.flow.nodes.map((n) => [n.id, n]));
  const b = bounds(p.flow);
  const view: View = compact ? { x: 20 - (b?.x ?? 0) * 0.7, y: 20 - (b?.y ?? 0) * 0.7, k: 0.7 } : p.view;

  const lines = p.flow.edges.flatMap((e) => {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) return [];
    const idx = Math.max(0, handlesOf(from).findIndex((h) => h.label === e.label));
    const a = portPosition(from, idx);
    const z = inputPosition(to);
    const text = e.label ? handlesOf(from).find((h) => h.label === e.label)?.text : undefined;
    return [{ e, a, z, text }];
  });

  const linkFrom = drag?.kind === "link" ? byId.get(drag.from) : undefined;
  const linkStart = linkFrom && drag?.kind === "link" ? portPosition(linkFrom, Math.max(0, handlesOf(linkFrom).findIndex((h) => h.label === drag.label))) : null;

  return (
    <div
      ref={ref}
      id={CANVAS_ID}
      tabIndex={-1}
      role="group"
      aria-label="Chatbot steps. Select a step and use the arrow keys to move it. Use the Step tab to connect steps with the keyboard."
      className={cn(
        "relative h-[62vh] min-h-[420px] rounded-card border border-border bg-surface",
        compact ? "overflow-auto" : "overflow-hidden",
        drag?.kind === "pan" && "cursor-grabbing",
      )}
      style={{
        touchAction: locked ? "auto" : "none",
        backgroundImage: "radial-gradient(var(--border) 1px, transparent 1px)",
        backgroundSize: `${24 * view.k}px ${24 * view.k}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
      onPointerDown={onBackgroundDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => setDragBoth(null)}
    >
      {compact && b && <div aria-hidden style={{ width: b.w * 0.7 + 40, height: b.h * 0.7 + 40 }} />}
      <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1} aria-hidden>
          <defs>
            <marker id="cb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M 0 0 L 10 5 L 0 10 z" style={{ fill: "var(--accent)" }} />
            </marker>
          </defs>
          {lines.map(({ e, a, z, text }) => {
            const selected = p.selectedEdgeId === e.id;
            const mid = { x: (a.x + z.x) / 2, y: (a.y + z.y) / 2 };
            return (
              <g key={e.id}>
                <path d={edgePath(a, z)} fill="none" strokeWidth={14} stroke="transparent" style={{ pointerEvents: locked ? "none" : "stroke", cursor: "pointer" }} onPointerDown={(ev) => { ev.stopPropagation(); p.onSelectEdge(e.id); p.onSelect(null); }} />
                <path d={edgePath(a, z)} fill="none" strokeWidth={selected ? 3 : 2} markerEnd="url(#cb-arrow)" style={{ stroke: "var(--accent)" }} />
                {text && (
                  <text x={mid.x} y={mid.y - 6} textAnchor="middle" fontSize={11} style={{ fill: "var(--foreground)", stroke: "var(--surface)", strokeWidth: 4, paintOrder: "stroke" }}>
                    {text.length > 18 ? `${text.slice(0, 17)}…` : text}
                  </text>
                )}
                {selected && !locked && (
                  <circle cx={z.x} cy={z.y} r={7} strokeWidth={2} style={{ fill: "var(--raised)", stroke: "var(--accent)", pointerEvents: "all", cursor: "grab" }} onPointerDown={(ev) => { const from = byId.get(e.from); if (from) startLink(ev, from, e.label, e.id); }} />
                )}
              </g>
            );
          })}
          {drag?.kind === "link" && linkStart && (
            <path d={edgePath(linkStart, drag.at)} fill="none" strokeWidth={2} strokeDasharray="5 4" style={{ stroke: "var(--accent)" }} />
          )}
        </svg>

        {p.flow.nodes.map((node) => (
          <NodeCard
            key={node.id}
            node={node}
            start={p.flow.start === node.id}
            selected={p.selectedId === node.id}
            bad={p.badNodes.has(node.id)}
            warn={p.warnNodes.has(node.id)}
            connected={new Set(p.flow.edges.filter((e) => e.from === node.id).map((e) => e.label))}
            locked={Boolean(locked)}
            onDown={(e) => onNodeDown(e, node)}
            onKey={(e) => onNodeKey(e, node)}
            onKeyUp={onNodeKeyUp}
            onClick={locked ? () => p.onActivate?.(node.id) : undefined}
            onPort={(e, label) => startLink(e, node, label)}
          />
        ))}
      </div>
      {p.flow.nodes.length === 0 && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted">
          This chatbot has no steps yet. Add one from the list of steps, or start from a template.
        </p>
      )}
    </div>
  );
}

function NodeCard({ node, start, selected, bad, warn, connected, locked, onDown, onKey, onKeyUp, onClick, onPort }: {
  node: FlowNode;
  start: boolean;
  selected: boolean;
  bad: boolean;
  warn: boolean;
  connected: Set<string | undefined>;
  locked: boolean;
  onDown: (e: React.PointerEvent) => void;
  onKey: (e: React.KeyboardEvent) => void;
  onKeyUp: (e: React.KeyboardEvent) => void;
  onClick?: () => void;
  onPort: (e: React.PointerEvent, label: string | undefined) => void;
}) {
  const meta = NODE_META[node.type];
  const handles = handlesOf(node);
  const branching = isBranching(node);
  const text = cardSummary(node);
  // The {" "} text nodes between the parts keep the words apart for axe's label-content-name-mismatch check, which joins text nodes with no spaces.
  // Starts with everything shown on the card, in the order shown, so voice control can say what it sees; the state follows.
  const visible = [meta.label, start ? "Start" : "", bad ? "Fix" : warn ? "Check" : "", text, ...(branching ? handles.map((h) => h.text) : [])].filter(Boolean).join(" ");
  return (
    <div
      data-node-id={node.id}
      tabIndex={0}
      role="button"
      aria-pressed={selected}
      aria-label={`${visible}${bad ? ". Has errors" : warn ? ". Has warnings" : ""}`}
      onPointerDown={onDown}
      onKeyDown={onKey}
      onKeyUp={onKeyUp}
      onClick={onClick}
      className={cn(
        "absolute select-none rounded-pop border-2 bg-raised shadow-raised",
        selected ? "border-accent" : bad ? "border-bad" : warn ? "border-warn" : "border-border-strong",
        locked ? "cursor-pointer" : "cursor-grab",
      )}
      style={{ left: node.position.x, top: node.position.y, width: NODE_W, height: nodeHeight(node) }}
    >
      <div className="flex items-center gap-2 px-3 pt-2">
        <span className="truncate text-xs font-semibold">{meta.label}</span>
        {" "}
        {start && <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold text-on-accent">Start</span>}
        {" "}
        {(bad || warn) && (
          <span className={cn("ml-auto shrink-0 rounded-full border px-1.5 text-[10px] font-semibold", bad ? "border-bad-line bg-bad-soft text-bad-fg" : "border-warn-line bg-warn-soft text-warn-fg")}>
            {bad ? "Fix" : "Check"}
          </span>
        )}
      </div>
      {" "}
      {!branching && <p className="line-clamp-2 break-words px-3 pt-1 text-xs text-muted">{text}</p>}
      {branching && (
        <div className="absolute left-0 right-0" style={{ top: 30 }}>
          <p className="truncate px-3 text-xs text-muted" style={{ height: 22 }}>{text}</p>
          {" "}
          {handles.map((h) => (
            <div key={h.label} className="flex items-center justify-end px-4 text-xs" style={{ height: 24 }}>
              {" "}
              <span className="truncate">{h.text}</span>
            </div>
          ))}
        </div>
      )}
      <span aria-hidden className="absolute -left-1.5 h-3 w-3 rounded-full border-2 border-accent bg-raised" style={{ top: nodeHeight(node) / 2 - 6 }} />
      {handles.map((h, i) => {
        const y = branching ? 52 + i * 24 + 12 : nodeHeight(node) / 2;
        return (
          <span
            key={h.label ?? "next"}
            aria-hidden
            onPointerDown={(e) => onPort(e, h.label)}
            className={cn("absolute -right-2 h-4 w-4 rounded-full border-2 border-accent", connected.has(h.label) ? "bg-accent" : "bg-raised", locked ? "" : "cursor-crosshair")}
            style={{ top: y - 8 }}
          />
        );
      })}
    </div>
  );
}
