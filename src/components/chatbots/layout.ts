import { handlesOf, isBranching } from "./catalog";
import type { FlowDefinition, FlowNode, Point } from "./types";

export const NODE_W = 220;
const COL_GAP = 100;
const ROW_GAP = 32;
const HEAD = 52;
const ROW_H = 24;

export function nodeHeight(node: FlowNode): number {
  return isBranching(node) ? HEAD + handlesOf(node).length * ROW_H + 8 : 84;
}

/** Canvas position of the output port for handle `index`. */
export function portPosition(node: FlowNode, index: number): Point {
  const x = node.position.x + NODE_W;
  if (!isBranching(node)) return { x, y: node.position.y + nodeHeight(node) / 2 };
  return { x, y: node.position.y + HEAD + index * ROW_H + ROW_H / 2 };
}

export const inputPosition = (node: FlowNode): Point => ({ x: node.position.x, y: node.position.y + nodeHeight(node) / 2 });

export function edgePath(a: Point, b: Point): string {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

/** Layered left-to-right layout from the start node. Unreachable nodes go in a trailing column. Returns a new flow. */
export function autoLayout(flow: FlowDefinition, origin: Point = { x: 40, y: 40 }): FlowDefinition {
  const ids = new Set(flow.nodes.map((n) => n.id));
  const depth = new Map<string, number>();
  const order: string[] = [];
  const queue: string[] = ids.has(flow.start) ? [flow.start] : [];
  if (queue.length) depth.set(flow.start, 0);
  while (queue.length) {
    const id = queue.shift() as string;
    order.push(id);
    for (const e of flow.edges) {
      if (e.from === id && !depth.has(e.to) && ids.has(e.to)) {
        depth.set(e.to, (depth.get(id) ?? 0) + 1);
        queue.push(e.to);
      }
    }
  }
  const trailing = Math.max(-1, ...depth.values()) + 1;
  for (const n of flow.nodes) {
    if (!depth.has(n.id)) {
      depth.set(n.id, trailing);
      order.push(n.id);
    }
  }
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const cursor = new Map<number, number>();
  const pos = new Map<string, Point>();
  for (const id of order) {
    const node = byId.get(id) as FlowNode;
    const d = depth.get(id) as number;
    const y = cursor.get(d) ?? origin.y;
    pos.set(id, { x: origin.x + d * (NODE_W + COL_GAP), y });
    cursor.set(d, y + nodeHeight(node) + ROW_GAP);
  }
  return { ...flow, nodes: flow.nodes.map((n) => ({ ...n, position: pos.get(n.id) as Point }) as FlowNode) };
}

/** Space kept clear around a step when looking for a free place. */
const CLEAR = 16;

/**
 * Where a new step of the given height can go: `want` when that place is free, otherwise straight below the steps in the
 * way. Without this a new step could land on top of another one and hide its text until Tidy up.
 */
export function freeSpot(flow: FlowDefinition, want: Point, height: number): Point {
  const boxes = flow.nodes.map((n) => ({ x: n.position.x, y: n.position.y, h: nodeHeight(n) }));
  const blocker = (p: Point) => boxes.find((b) => p.x < b.x + NODE_W + CLEAR && b.x < p.x + NODE_W + CLEAR && p.y < b.y + b.h + CLEAR && b.y < p.y + height + CLEAR);
  let p = want;
  // Each move goes below one more step and never back up, so this ends after at most one move per step.
  for (let b = blocker(p); b; b = blocker(p)) p = { x: p.x, y: b.y + b.h + ROW_GAP };
  return p;
}

export function bounds(flow: FlowDefinition): { x: number; y: number; w: number; h: number } | null {
  if (!flow.nodes.length) return null;
  const x = Math.min(...flow.nodes.map((n) => n.position.x));
  const y = Math.min(...flow.nodes.map((n) => n.position.y));
  const x2 = Math.max(...flow.nodes.map((n) => n.position.x + NODE_W));
  const y2 = Math.max(...flow.nodes.map((n) => n.position.y + nodeHeight(n)));
  return { x, y, w: x2 - x, h: y2 - y };
}
