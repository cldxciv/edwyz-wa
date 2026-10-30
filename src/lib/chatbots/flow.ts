import { parseWebhookUrl } from "@/lib/integrations/ssrf";
import { HttpError } from "@/lib/tenancy";

/** userId value of a hand-over that leaves the chat in the chosen team's queue without picking a teammate. */
export const TEAM_QUEUE = "team_queue";

export const FLOW_LIMITS = { nodes: 100, edges: 200, text: 1024, buttons: 3, buttonTitle: 20, rows: 10, rowTitle: 24, delayMin: 1, delayMax: 10080, maxRetries: 5, body: 4096, headerText: 60, footer: 60 } as const;

export const NODE_TYPES = [
  "send_text",
  "send_buttons",
  "send_list",
  "send_template",
  "ask",
  "condition",
  "set_attribute",
  "add_tag",
  "remove_tag",
  "delay",
  "webhook",
  "assign",
  "set_status",
  "handoff",
  "subscribe",
  "unsubscribe",
  "end",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const VALIDATIONS = ["text", "number", "email", "phone", "date", "choice"] as const;
export type AskValidation = (typeof VALIDATIONS)[number];
export const OPERATORS = ["equals", "not_equals", "contains", "not_contains", "starts_with", "not_starts_with", "exists", "gt", "lt"] as const;
export type ConditionOperator = (typeof OPERATORS)[number];
export const BOT_STATUSES = ["open", "pending", "solved"] as const;
export type BotStatus = (typeof BOT_STATUSES)[number];

export type ButtonOption = { id: string; title: string };
export type ListRow = { id: string; title: string; description?: string };

export type NodeDataMap = {
  send_text: { text: string };
  send_buttons: { text: string; buttons: ButtonOption[]; header?: string; footer?: string };
  send_list: { text: string; buttonLabel: string; rows: ListRow[]; header?: string; footer?: string };
  /** headerVariable fills a text header's {{1}}, headerMediaUrl is the https link of an image, video or document header, buttonVariable fills the {{1}} of a URL button. */
  send_template: { templateId: string; variables: Record<string, string>; headerVariable?: string; headerMediaUrl?: string; buttonVariable?: string };
  ask: { text: string; variable: string; validate: AskValidation; retryText?: string; maxRetries: number; choices?: string[] };
  condition: { variable: string; operator: ConditionOperator; value?: string };
  set_attribute: { attribute: string; value: string };
  add_tag: { tag: string };
  remove_tag: { tag: string };
  delay: { minutes: number };
  webhook: { url: string; method: "GET" | "POST"; bodyTemplate?: string; saveAs?: string };
  /** userId is a teammate id, "round_robin" (next free teammate, within the team when teamId is set) or empty when only a team is chosen. */
  assign: { userId: string; teamId?: string };
  set_status: { status: BotStatus };
  /** teamId and userId say who receives the chat; note (default on) leaves a private summary of the answers the bot collected. */
  handoff: { message?: string; teamId?: string; userId?: string; note?: boolean };
  /** source is the consent proof kept on the contact ("Chatbot" when empty). */
  subscribe: { source?: string };
  /** message is the confirmation sent before the contact is opted out; the chatbot ends there. */
  unsubscribe: { message?: string };
  end: Record<string, never>;
};

export type FlowNode = { [T in NodeType]: { id: string; type: T; position: { x: number; y: number }; data: NodeDataMap[T] } }[NodeType];
export type FlowEdge = { id: string; from: string; to: string; label?: string };
export type EscalationSettings = { enabled: boolean; useAi: boolean; keywords: string[]; message?: string; teamId?: string; userId?: string };
export type BotSettings = {
  /** Lower numbers are checked first when several chatbots could start. */
  priority: number;
  keywordMatch: "contains" | "exact";
  /** Never start this bot on a chat that a teammate owns. */
  skipAssignedChats: boolean;
  /** End the session when a teammate replies in the chat. */
  stopOnHumanReply: boolean;
  /** Send real WhatsApp buttons and lists instead of numbered text. */
  interactive: boolean;
  /** Replaces the standard "Please reply with one of the options." message. */
  fallbackText?: string;
  /** Minutes of silence after which a waiting session ends (1 to 1440, default 1440). */
  timeoutMinutes: number;
  /** Sent once when the session ends from silence, if the chat is still inside the 24 hour window. */
  timeoutMessage?: string;
  escalation: EscalationSettings;
};
export type FlowDefinition = { version: 1; start: string; nodes: FlowNode[]; edges: FlowEdge[]; settings?: BotSettings };

export type FlowIssue = { nodeId?: string; edgeId?: string; message: string };
export type FlowValidation = { ok: boolean; errors: FlowIssue[]; warnings: FlowIssue[]; flow?: FlowDefinition };

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ATTRIBUTE = /^[A-Za-z0-9_ -]{1,64}$/;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const MEDIA_LINK = /^(https:\/\/\S+|\{\{\s*[A-Za-z0-9_.\- ]{1,128}\s*\}\})$/i;

type Report = (message: string) => void;
type DataCheck = (data: Rec, fail: Report) => Rec;

function optText(v: unknown, max: number, label: string, fail: Report): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || v.length > max) fail(`${label} must be text of at most ${max} characters.`);
  return typeof v === "string" ? v.slice(0, max) : undefined;
}

function reqText(v: unknown, max: number, label: string, fail: Report): string {
  if (!isStr(v, max)) {
    fail(`${label} is required and must be at most ${max} characters.`);
    return "";
  }
  return v;
}

function variableName(v: unknown, label: string, fail: Report): string {
  if (typeof v !== "string" || !NAME.test(v) || RESERVED.has(v)) {
    fail(`${label} must be a name of letters, numbers and underscores, not starting with a number.`);
    return "";
  }
  return v;
}

function checkOptions(items: unknown, max: number, titleMax: number, label: string, fail: Report, withDescription: boolean) {
  const out: ListRow[] = [];
  if (!Array.isArray(items) || items.length === 0 || items.length > max) {
    fail(`${label} needs between 1 and ${max} entries.`);
    return out;
  }
  const seen = new Set<string>();
  for (const raw of items) {
    const item = isRec(raw) ? raw : {};
    const id = typeof item.id === "string" && ID.test(item.id) ? item.id : "";
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!id) fail(`Each ${label} entry needs an id of letters, numbers, dashes or underscores.`);
    if (id && seen.has(id)) fail(`Duplicate ${label} id "${id}".`);
    seen.add(id);
    if (!title || title.length > titleMax) fail(`Each ${label} title must be 1 to ${titleMax} characters.`);
    const description = withDescription ? optText(item.description, 72, `${label} description`, fail) : undefined;
    out.push({ id, title, ...(description ? { description } : {}) });
  }
  return out;
}

const CHECKS: { [T in NodeType]: (data: Rec, fail: Report) => NodeDataMap[T] } = {
  send_text: (d, fail) => ({ text: reqText(d.text, FLOW_LIMITS.text, "Message text", fail) }),
  send_buttons: (d, fail) => {
    const header = optText(d.header, FLOW_LIMITS.headerText, "Header", fail);
    const footer = optText(d.footer, FLOW_LIMITS.footer, "Footer", fail);
    return {
      text: reqText(d.text, FLOW_LIMITS.text, "Message text", fail),
      buttons: checkOptions(d.buttons, FLOW_LIMITS.buttons, FLOW_LIMITS.buttonTitle, "button", fail, false),
      ...(header ? { header } : {}),
      ...(footer ? { footer } : {}),
    };
  },
  send_list: (d, fail) => {
    const header = optText(d.header, FLOW_LIMITS.headerText, "Header", fail);
    const footer = optText(d.footer, FLOW_LIMITS.footer, "Footer", fail);
    return {
      text: reqText(d.text, FLOW_LIMITS.text, "Message text", fail),
      buttonLabel: reqText(d.buttonLabel, FLOW_LIMITS.buttonTitle, "Button label", fail),
      rows: checkOptions(d.rows, FLOW_LIMITS.rows, FLOW_LIMITS.rowTitle, "row", fail, true),
      ...(header ? { header } : {}),
      ...(footer ? { footer } : {}),
    };
  },
  send_template: (d, fail) => {
    const variables: Record<string, string> = {};
    const raw = isRec(d.variables) ? d.variables : {};
    for (const [key, value] of Object.entries(raw)) {
      if (!/^[1-9]\d?$/.test(key) || typeof value !== "string" || value.length > 1024) fail("Template variables must be numbered 1-99 with text values.");
      else variables[key] = value;
    }
    const headerVariable = optText(d.headerVariable, 1024, "Header text", fail);
    const buttonVariable = optText(d.buttonVariable, 1024, "Button text", fail);
    const headerMediaUrl = optText(d.headerMediaUrl, 2000, "Header media link", fail);
    if (headerMediaUrl && !MEDIA_LINK.test(headerMediaUrl)) fail("The header media link must start with https:// or be a saved answer.");
    return {
      templateId: reqText(d.templateId, 64, "Template", fail),
      variables,
      ...(headerVariable ? { headerVariable } : {}),
      ...(headerMediaUrl ? { headerMediaUrl } : {}),
      ...(buttonVariable ? { buttonVariable } : {}),
    };
  },
  ask: (d, fail) => {
    const validate = (VALIDATIONS as readonly unknown[]).includes(d.validate) ? (d.validate as AskValidation) : "text";
    if (d.validate !== undefined && validate !== d.validate) fail(`Validation must be one of ${VALIDATIONS.join(", ")}.`);
    const retries = d.maxRetries === undefined ? 2 : d.maxRetries;
    if (typeof retries !== "number" || !Number.isInteger(retries) || retries < 0 || retries > FLOW_LIMITS.maxRetries) fail(`Retries must be a whole number from 0 to ${FLOW_LIMITS.maxRetries}.`);
    const choices = Array.isArray(d.choices) ? d.choices.filter((c): c is string => typeof c === "string" && c.trim().length > 0 && c.length <= 100).slice(0, 20) : undefined;
    if (validate === "choice" && (!choices || choices.length === 0)) fail("A choice question needs at least one choice.");
    const retryText = optText(d.retryText, FLOW_LIMITS.text, "Retry text", fail);
    return {
      text: reqText(d.text, FLOW_LIMITS.text, "Question text", fail),
      variable: variableName(d.variable, "Variable", fail),
      validate,
      maxRetries: typeof retries === "number" ? retries : 2,
      ...(retryText ? { retryText } : {}),
      ...(choices && choices.length > 0 ? { choices } : {}),
    };
  },
  condition: (d, fail) => {
    const operator = (OPERATORS as readonly unknown[]).includes(d.operator) ? (d.operator as ConditionOperator) : "equals";
    if (operator !== d.operator) fail(`Operator must be one of ${OPERATORS.join(", ")}.`);
    const value = optText(d.value, 512, "Value", fail);
    if (operator !== "exists" && value === undefined) fail("A comparison value is required.");
    if (typeof d.variable !== "string" || !/^[A-Za-z_][A-Za-z0-9_.\- ]{0,127}$/.test(d.variable)) fail("Variable is required.");
    return { variable: typeof d.variable === "string" ? d.variable : "", operator, ...(value !== undefined ? { value } : {}) };
  },
  set_attribute: (d, fail) => {
    const attribute = typeof d.attribute === "string" && ATTRIBUTE.test(d.attribute) && !RESERVED.has(d.attribute) ? d.attribute : "";
    if (!attribute) fail("Attribute name must be 1-64 letters, numbers, spaces, dashes or underscores.");
    return { attribute, value: optText(d.value, 512, "Value", fail) ?? "" };
  },
  add_tag: (d, fail) => ({ tag: reqText(d.tag, 64, "Tag", fail).trim() }),
  remove_tag: (d, fail) => ({ tag: reqText(d.tag, 64, "Tag", fail).trim() }),
  delay: (d, fail) => {
    const minutes = d.minutes;
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < FLOW_LIMITS.delayMin || minutes > FLOW_LIMITS.delayMax) fail(`Delay must be a whole number of minutes from ${FLOW_LIMITS.delayMin} to ${FLOW_LIMITS.delayMax}.`);
    return { minutes: typeof minutes === "number" ? minutes : 0 };
  },
  webhook: (d, fail) => {
    const method = d.method === "GET" || d.method === "POST" ? d.method : "POST";
    if (d.method !== undefined && method !== d.method) fail("Method must be GET or POST.");
    let url = "";
    if (typeof d.url !== "string") fail("A webhook URL is required.");
    else {
      try {
        parseWebhookUrl(d.url);
        url = d.url;
      } catch (e) {
        fail(e instanceof HttpError ? e.message : "Enter a valid URL.");
      }
    }
    const bodyTemplate = optText(d.bodyTemplate, 4096, "Body", fail);
    const saveAs = d.saveAs === undefined || d.saveAs === "" ? undefined : variableName(d.saveAs, "Save as", fail);
    return { url, method, ...(bodyTemplate ? { bodyTemplate } : {}), ...(saveAs ? { saveAs } : {}) };
  },
  assign: (d, fail) => {
    const teamId = optText(d.teamId, 64, "Team", fail);
    const userId = typeof d.userId === "string" ? d.userId.trim().slice(0, 64) : "";
    if (!userId && !teamId) fail("Choose a teammate or a team to assign the chat to.");
    return { userId, ...(teamId ? { teamId } : {}) };
  },
  set_status: (d, fail) => {
    const ok = (BOT_STATUSES as readonly unknown[]).includes(d.status);
    if (!ok) fail(`Status must be one of ${BOT_STATUSES.join(", ")}.`);
    return { status: ok ? (d.status as BotStatus) : "open" };
  },
  handoff: (d, fail) => {
    const message = optText(d.message, FLOW_LIMITS.text, "Handoff message", fail);
    const teamId = optText(d.teamId, 64, "Team", fail);
    const userId = optText(d.userId, 64, "Teammate", fail);
    if (userId === TEAM_QUEUE && !teamId) fail("Choose a team to leave the chat in its queue.");
    return { ...(message ? { message } : {}), ...(teamId ? { teamId } : {}), ...(userId ? { userId } : {}), ...(d.note === false ? { note: false } : {}) };
  },
  subscribe: (d, fail) => {
    const source = optText(d.source, 100, "Consent note", fail);
    return source ? { source } : {};
  },
  unsubscribe: (d, fail) => {
    const message = optText(d.message, FLOW_LIMITS.text, "Confirmation message", fail);
    return message ? { message } : {};
  },
  end: () => ({}) as Record<string, never>,
};

const BRANCHING: Partial<Record<NodeType, (data: never) => string[]>> = {
  send_buttons: (d: NodeDataMap["send_buttons"]) => [...d.buttons.map((b) => b.id), "default"],
  send_list: (d: NodeDataMap["send_list"]) => [...d.rows.map((r) => r.id), "default"],
  send_template: () => ["error"],
  condition: () => ["yes", "no"],
  ask: () => ["invalid"],
  webhook: () => ["error"],
};
const TERMINAL: NodeType[] = ["end", "handoff", "unsubscribe"];

export const DEFAULT_ESCALATION: EscalationSettings = { enabled: true, useAi: false, keywords: [] };
export const TIMEOUT_MAX_MINUTES = 1440;
export const DEFAULT_BOT_SETTINGS: BotSettings = { priority: 100, timeoutMinutes: TIMEOUT_MAX_MINUTES, keywordMatch: "contains", skipAssignedChats: true, stopOnHumanReply: true, interactive: true, escalation: DEFAULT_ESCALATION };

/** Reads bot settings. Without a reporter it is lenient (bad values fall back to defaults); with one, every bad value is reported. */
export function parseSettings(raw: unknown, fail?: Report): BotSettings {
  const d = DEFAULT_BOT_SETTINGS;
  const s = isRec(raw) ? raw : {};
  const report: Report = fail ?? (() => undefined);
  const flag = (v: unknown, fallback: boolean, label: string) => {
    if (v === undefined) return fallback;
    if (typeof v !== "boolean") report(`${label} must be on or off.`);
    return typeof v === "boolean" ? v : fallback;
  };
  let priority = d.priority;
  if (s.priority !== undefined) {
    if (typeof s.priority === "number" && Number.isInteger(s.priority) && s.priority >= 1 && s.priority <= 999) priority = s.priority;
    else report("Priority must be a whole number from 1 to 999.");
  }
  let timeoutMinutes = d.timeoutMinutes;
  if (s.timeoutMinutes !== undefined) {
    if (typeof s.timeoutMinutes === "number" && Number.isInteger(s.timeoutMinutes) && s.timeoutMinutes >= 1 && s.timeoutMinutes <= TIMEOUT_MAX_MINUTES) timeoutMinutes = s.timeoutMinutes;
    else report(`Inactivity time must be a whole number of minutes from 1 to ${TIMEOUT_MAX_MINUTES}.`);
  }
  const timeoutMessage = optText(s.timeoutMessage, FLOW_LIMITS.text, "Reminder message", report);
  const keywordMatch = s.keywordMatch === "exact" ? "exact" : "contains";
  if (s.keywordMatch !== undefined && s.keywordMatch !== "exact" && s.keywordMatch !== "contains") report("Keyword matching must be contains or exact.");
  const e = isRec(s.escalation) ? s.escalation : {};
  const keywords = Array.isArray(e.keywords) ? e.keywords.filter((k): k is string => typeof k === "string" && k.trim().length > 0 && k.length <= 64).map((k) => k.trim()).slice(0, 30) : [];
  if (e.keywords !== undefined && (!Array.isArray(e.keywords) || e.keywords.length > 30)) report("Escalation words must be a list of at most 30 words.");
  const message = optText(e.message, FLOW_LIMITS.text, "Escalation message", report);
  const teamId = typeof e.teamId === "string" && e.teamId.length <= 64 && e.teamId ? e.teamId : undefined;
  const userId = typeof e.userId === "string" && e.userId.length <= 64 && e.userId ? e.userId : undefined;
  if (userId === TEAM_QUEUE && !teamId) report("Choose a team to leave the chat in its queue.");
  const fallbackText = optText(s.fallbackText, FLOW_LIMITS.text, "Fallback message", report);
  return {
    priority,
    timeoutMinutes,
    ...(timeoutMessage ? { timeoutMessage } : {}),
    keywordMatch,
    skipAssignedChats: flag(s.skipAssignedChats, d.skipAssignedChats, "Skip assigned chats"),
    stopOnHumanReply: flag(s.stopOnHumanReply, d.stopOnHumanReply, "Stop on teammate reply"),
    interactive: flag(s.interactive, d.interactive, "Interactive messages"),
    ...(fallbackText ? { fallbackText } : {}),
    escalation: {
      enabled: flag(e.enabled, d.escalation.enabled, "Smart escalation"),
      useAi: flag(e.useAi, d.escalation.useAi, "AI check"),
      keywords,
      ...(message ? { message } : {}),
      ...(teamId ? { teamId } : {}),
      ...(userId ? { userId } : {}),
    },
  };
}

function parseNode(raw: unknown, index: number, errors: FlowIssue[]): FlowNode | null {
  const node = isRec(raw) ? raw : {};
  const id = typeof node.id === "string" && ID.test(node.id) ? node.id : "";
  const at = id ? { nodeId: id } : {};
  if (!id) errors.push({ message: `Node ${index + 1} needs an id of letters, numbers, dashes or underscores.` });
  const type = node.type;
  if (typeof type !== "string" || !(NODE_TYPES as readonly string[]).includes(type)) {
    errors.push({ ...at, message: `Node ${id || index + 1} has an unknown type.` });
    return null;
  }
  const pos = isRec(node.position) ? node.position : {};
  const position = { x: Number.isFinite(pos.x) ? (pos.x as number) : 0, y: Number.isFinite(pos.y) ? (pos.y as number) : 0 };
  const fail: Report = (message) => errors.push({ ...at, message });
  const data = CHECKS[type as NodeType](isRec(node.data) ? node.data : {}, fail);
  return { id, type, position, data } as FlowNode;
}

function checkEdges(rawEdges: unknown, nodes: Map<string, FlowNode>, errors: FlowIssue[]): FlowEdge[] {
  const edges: FlowEdge[] = [];
  const ids = new Set<string>();
  const perNode = new Map<string, FlowEdge[]>();
  for (const raw of Array.isArray(rawEdges) ? rawEdges : []) {
    const e = isRec(raw) ? raw : {};
    const edge: FlowEdge = {
      id: typeof e.id === "string" && ID.test(e.id) ? e.id : "",
      from: typeof e.from === "string" ? e.from : "",
      to: typeof e.to === "string" ? e.to : "",
      ...(typeof e.label === "string" && e.label ? { label: e.label.slice(0, 64) } : {}),
    };
    const at = { edgeId: edge.id || undefined };
    if (!edge.id) errors.push({ message: "Every edge needs an id." });
    else if (ids.has(edge.id)) errors.push({ ...at, message: `Duplicate edge id "${edge.id}".` });
    ids.add(edge.id);
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      errors.push({ ...at, message: "An edge points to a step that does not exist." });
      continue;
    }
    perNode.set(edge.from, [...(perNode.get(edge.from) ?? []), edge]);
    edges.push(edge);
  }
  for (const [from, list] of perNode) checkOutgoing(nodes.get(from)!, list, errors);
  return edges;
}

function checkOutgoing(node: FlowNode, list: FlowEdge[], errors: FlowIssue[]) {
  const at = { nodeId: node.id };
  if (TERMINAL.includes(node.type)) {
    errors.push({ ...at, message: `A ${node.type} step cannot have outgoing connections.` });
    return;
  }
  const allowed = BRANCHING[node.type]?.(node.data as never) ?? [];
  const seen = new Set<string>();
  for (const edge of list) {
    const key = edge.label ?? "";
    if (key && !allowed.includes(key)) errors.push({ ...at, edgeId: edge.id, message: `Connection label "${key}" is not valid for a ${node.type} step.` });
    if (seen.has(key)) errors.push({ ...at, edgeId: edge.id, message: key ? `Two connections use the label "${key}".` : "A step can have only one unlabeled connection." });
    seen.add(key);
  }
}

function reachable(start: string, edges: FlowEdge[]): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const current = queue.pop()!;
    for (const e of edges) if (e.from === current && !seen.has(e.to)) (seen.add(e.to), queue.push(e.to));
  }
  return seen;
}

export function validateFlow(input: unknown): FlowValidation {
  const errors: FlowIssue[] = [];
  const warnings: FlowIssue[] = [];
  const flow = isRec(input) ? input : {};
  if (!isRec(input)) errors.push({ message: "The flow must be an object." });
  if (flow.version !== 1) errors.push({ message: "Flow version must be 1." });
  const rawNodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  if (rawNodes.length === 0) errors.push({ message: "Add at least one step." });
  if (rawNodes.length > FLOW_LIMITS.nodes) errors.push({ message: `A flow can have at most ${FLOW_LIMITS.nodes} steps.` });
  if (Array.isArray(flow.edges) && flow.edges.length > FLOW_LIMITS.edges) errors.push({ message: `A flow can have at most ${FLOW_LIMITS.edges} connections.` });
  if (errors.length && rawNodes.length > FLOW_LIMITS.nodes) return { ok: false, errors, warnings };

  const nodes = new Map<string, FlowNode>();
  rawNodes.forEach((raw, i) => {
    const node = parseNode(raw, i, errors);
    if (!node) return;
    if (node.id && nodes.has(node.id)) errors.push({ nodeId: node.id, message: `Duplicate step id "${node.id}".` });
    else if (node.id) nodes.set(node.id, node);
  });

  const start = typeof flow.start === "string" ? flow.start : "";
  if (!nodes.has(start)) errors.push({ message: "The start step does not exist." });
  const edges = Array.isArray(flow.edges) && flow.edges.length <= FLOW_LIMITS.edges ? checkEdges(flow.edges, nodes, errors) : [];

  if (nodes.has(start)) {
    const seen = reachable(start, edges);
    for (const id of nodes.keys()) if (!seen.has(id)) warnings.push({ nodeId: id, message: "This step cannot be reached from the start." });
  }
  const settings = flow.settings === undefined ? undefined : parseSettings(flow.settings, (message) => errors.push({ message }));
  const result: FlowValidation = { ok: errors.length === 0, errors, warnings };
  if (result.ok) result.flow = { version: 1, start, nodes: [...nodes.values()], edges, ...(settings ? { settings } : {}) };
  return result;
}
