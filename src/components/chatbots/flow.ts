import { handlesOf, makeNode } from "./catalog";
import { DEFAULT_SETTINGS, LIMITS, type BotSettings, type FlowDefinition, type FlowEdge, type FlowNode, type NodeType, type Point } from "./types";

export function nextId(prefix: string, used: Iterable<string>): string {
  const taken = new Set(used);
  let n = taken.size + 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

export const nodeById = (flow: FlowDefinition, id: string | null | undefined) => flow.nodes.find((n) => n.id === id);
export const edgesFrom = (flow: FlowDefinition, id: string) => flow.edges.filter((e) => e.from === id);
export const findEdge = (flow: FlowDefinition, from: string, label: string | undefined) => flow.edges.find((e) => e.from === from && e.label === label);

export function addNode(flow: FlowDefinition, type: NodeType, position: Point): { flow: FlowDefinition; id: string | null } {
  if (flow.nodes.length >= LIMITS.nodes) return { flow, id: null };
  const id = nextId("n", flow.nodes.map((n) => n.id));
  const node = makeNode(type, id, position);
  return { id, flow: { ...flow, start: flow.start || id, nodes: [...flow.nodes, node] } };
}

/** Drops edges whose source handle no longer exists (deleted button or row) or whose ends are missing. */
export function pruneEdges(flow: FlowDefinition): FlowDefinition {
  const ids = new Set(flow.nodes.map((n) => n.id));
  const handles = new Map(flow.nodes.map((n) => [n.id, new Set(handlesOf(n).map((h) => h.label))]));
  const edges = flow.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && handles.get(e.from)?.has(e.label));
  return edges.length === flow.edges.length ? flow : { ...flow, edges };
}

export function updateNode(flow: FlowDefinition, id: string, patch: (n: FlowNode) => FlowNode): FlowDefinition {
  return pruneEdges({ ...flow, nodes: flow.nodes.map((n) => (n.id === id ? patch(n) : n)) });
}

export function moveNode(flow: FlowDefinition, id: string, position: Point): FlowDefinition {
  return { ...flow, nodes: flow.nodes.map((n) => (n.id === id ? ({ ...n, position } as FlowNode) : n)) };
}

/** Connects a handle to a node, replacing any edge already leaving that handle. Self links are ignored. */
export function connect(flow: FlowDefinition, from: string, label: string | undefined, to: string): FlowDefinition {
  if (from === to || !nodeById(flow, from) || !nodeById(flow, to)) return flow;
  if (flow.edges.length >= LIMITS.edges && !findEdge(flow, from, label)) return flow;
  const kept = flow.edges.filter((e) => !(e.from === from && e.label === label));
  const edge: FlowEdge = { id: nextId("e", flow.edges.map((e) => e.id)), from, to, ...(label === undefined ? {} : { label }) };
  return { ...flow, edges: [...kept, edge] };
}

/** Moves the target end of an existing edge to another node. */
export function reconnectEdge(flow: FlowDefinition, edgeId: string, to: string): FlowDefinition {
  const edge = flow.edges.find((e) => e.id === edgeId);
  if (!edge || edge.from === to || !nodeById(flow, to)) return flow;
  return { ...flow, edges: flow.edges.map((e) => (e.id === edgeId ? { ...e, to } : e)) };
}

export const disconnect = (flow: FlowDefinition, from: string, label: string | undefined): FlowDefinition => ({
  ...flow,
  edges: flow.edges.filter((e) => !(e.from === from && e.label === label)),
});

export const removeEdge = (flow: FlowDefinition, edgeId: string): FlowDefinition => ({ ...flow, edges: flow.edges.filter((e) => e.id !== edgeId) });

export function removeNode(flow: FlowDefinition, id: string): FlowDefinition {
  const nodes = flow.nodes.filter((n) => n.id !== id);
  const edges = flow.edges.filter((e) => e.from !== id && e.to !== id);
  const start = flow.start === id ? (nodes[0]?.id ?? "") : flow.start;
  return { ...flow, start, nodes, edges };
}

/** Everything needed to put a deleted step back exactly as it was. */
export type DeletedStep = { node: FlowNode; edges: FlowEdge[]; index: number; wasStart: boolean };

export function snapshotNode(flow: FlowDefinition, id: string): DeletedStep | null {
  const node = nodeById(flow, id);
  if (!node) return null;
  return {
    node,
    edges: flow.edges.filter((e) => e.from === id || e.to === id),
    index: flow.nodes.findIndex((n) => n.id === id),
    wasStart: flow.start === id,
  };
}

/** Puts a deleted step and its connections back into the flow as it is now. Connections that no longer make sense are skipped. */
export function restoreNode(flow: FlowDefinition, d: DeletedStep): FlowDefinition {
  if (nodeById(flow, d.node.id) || flow.nodes.length >= LIMITS.nodes) return flow;
  const nodes = [...flow.nodes];
  nodes.splice(Math.min(d.index, nodes.length), 0, d.node);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = [...flow.edges];
  for (const e of d.edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || edges.length >= LIMITS.edges) continue;
    if (edges.some((x) => x.from === e.from && x.label === e.label)) continue;
    edges.push(edges.some((x) => x.id === e.id) ? { ...e, id: nextId("e", edges.map((x) => x.id)) } : e);
  }
  return pruneEdges({ ...flow, start: d.wasStart || !flow.start ? d.node.id : flow.start, nodes, edges });
}

/** The smallest numbered gap not used yet, so removing gap 2 of 3 and adding again never overwrites gap 3. */
export function nextGapKey(keys: string[]): string {
  const taken = new Set(keys);
  let n = 1;
  while (taken.has(String(n))) n++;
  return String(n);
}

export function duplicateNode(flow: FlowDefinition, id: string): { flow: FlowDefinition; id: string | null } {
  const src = nodeById(flow, id);
  if (!src || flow.nodes.length >= LIMITS.nodes) return { flow, id: null };
  const newId = nextId("n", flow.nodes.map((n) => n.id));
  const copy = structuredClone(src) as FlowNode;
  copy.id = newId;
  copy.position = { x: src.position.x + 40, y: src.position.y + 40 };
  return { flow: { ...flow, nodes: [...flow.nodes, copy] }, id: newId };
}

export const setStart = (flow: FlowDefinition, id: string): FlowDefinition => (nodeById(flow, id) ? { ...flow, start: id } : flow);

export function reachable(flow: FlowDefinition): Set<string> {
  const seen = new Set<string>();
  const stack = nodeById(flow, flow.start) ? [flow.start] : [];
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of flow.edges) if (e.from === id) stack.push(e.to);
  }
  return seen;
}

export function normalizeFlow(raw: unknown): FlowDefinition {
  const f = (raw ?? {}) as Partial<FlowDefinition>;
  return {
    version: 1,
    start: typeof f.start === "string" ? f.start : "",
    nodes: Array.isArray(f.nodes) ? f.nodes : [],
    edges: Array.isArray(f.edges) ? f.edges : [],
    ...(f.settings && typeof f.settings === "object" ? { settings: f.settings } : {}),
  };
}

/** The bot's settings with every missing value filled in, ready to show in the Settings tab. */
export function settingsOf(flow: FlowDefinition): BotSettings {
  const s: Partial<BotSettings> = flow.settings ?? {};
  return { ...DEFAULT_SETTINGS, ...s, escalation: { ...DEFAULT_SETTINGS.escalation, ...(s.escalation ?? {}) } };
}

export function withSettings(flow: FlowDefinition, patch: Partial<Omit<BotSettings, "escalation">> & { escalation?: Partial<BotSettings["escalation"]> }): FlowDefinition {
  const current = settingsOf(flow);
  return { ...flow, settings: { ...current, ...patch, escalation: { ...current.escalation, ...(patch.escalation ?? {}) } } };
}
