import { OPERATOR_TEXT, STATUS_TEXT, formatMinutes } from "./catalog";
import { detectEscalation } from "@/lib/chatbots/escalation-detect";
import { parseDate } from "@/lib/chatbots/vars";
import { edgesFrom, findEdge, nodeById, settingsOf } from "./flow";
import type { ConditionOperator, FlowDefinition, FlowNode, TriggerType } from "./types";

export type PreviewMessage = {
  from: "bot" | "customer" | "note";
  text: string;
  options?: { id: string; title: string }[];
  optionsLabel?: string;
};

export type Waiting =
  | { kind: "buttons"; nodeId: string }
  | { kind: "list"; nodeId: string }
  | { kind: "ask"; nodeId: string; retries: number };

export type PreviewStatus = "waiting" | "ended" | "handoff";

export type PreviewState = {
  nodeId: string | null;
  variables: Record<string, string>;
  messages: PreviewMessage[];
  waiting: Waiting | null;
  status: PreviewStatus;
};

export const MAX_STEPS = 200;

export function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_m, k: string) => vars[k] ?? "");
}

export function triggerMatches(type: TriggerType, keywords: string[], text: string, isFirstMessage: boolean): boolean {
  switch (type) {
    case "any_message": return true;
    case "first_message": return isFirstMessage;
    case "manual": return false;
    case "keyword": {
      const t = text.toLowerCase();
      return keywords.some((k) => k.trim() && t.includes(k.trim().toLowerCase()));
    }
  }
}

export function evaluateCondition(operator: ConditionOperator, actual: string | undefined, expected: string): boolean {
  const a = (actual ?? "").trim().toLowerCase();
  const b = expected.trim().toLowerCase();
  switch (operator) {
    case "equals": return a === b;
    case "not_equals": return a !== b;
    case "contains": return b !== "" && a.includes(b);
    case "not_contains": return b === "" || !a.includes(b);
    case "starts_with": return b !== "" && a.startsWith(b);
    case "not_starts_with": return b === "" || !a.startsWith(b);
    case "exists": return actual !== undefined && actual.trim() !== "";
    case "gt": return a !== "" && Number(a) > Number(b);
    case "lt": return a !== "" && Number(a) < Number(b);
  }
}

export function validateAnswer(kind: "text" | "number" | "email" | "phone" | "date" | "choice", value: string, choices?: string[]): boolean {
  const v = value.trim();
  if (!v) return false;
  if (kind === "choice" && choices && choices.length > 0) return choices.some((c) => c.trim().toLowerCase() === v.toLowerCase());
  if (kind === "number") return Number.isFinite(Number(v));
  if (kind === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  if (kind === "date") return parseDate(v) !== null;
  if (kind === "phone") return /^\+?[0-9][0-9\s-]{6,17}$/.test(v);
  return true;
}

function nextNode(flow: FlowDefinition, from: string, label?: string): string | null {
  return findEdge(flow, from, label)?.to ?? null;
}

type Draft = { state: PreviewState };

const note = (d: Draft, text: string) => d.state.messages.push({ from: "note", text });
const say = (d: Draft, text: string, extra: Partial<PreviewMessage> = {}) => d.state.messages.push({ from: "bot", text, ...extra });

function enter(flow: FlowDefinition, d: Draft, startId: string | null) {
  let id = startId;
  let steps = 0;
  const s = d.state;
  while (id) {
    if (++steps > MAX_STEPS) {
      note(d, "Preview stopped: the chatbot loops without waiting for the customer. Add a question or buttons inside the loop.");
      s.status = "ended";
      s.nodeId = null;
      return;
    }
    const node = nodeById(flow, id);
    if (!node) {
      note(d, "Preview stopped: a connection points to a step that was deleted.");
      break;
    }
    s.nodeId = id;
    const result = run(flow, d, node);
    if (result === "wait") return;
    id = result;
  }
  s.nodeId = null;
  s.status = s.status === "handoff" ? "handoff" : "ended";
  s.waiting = null;
  if (s.status === "ended") note(d, "The chat ended.");
}

/** Executes one node. Returns the next node id, null to stop, or "wait" when the customer must answer. */
function run(flow: FlowDefinition, d: Draft, node: FlowNode): string | null | "wait" {
  const s = d.state;
  const vars = s.variables;
  switch (node.type) {
    case "send_text":
      say(d, interpolate(node.data.text, vars));
      return nextNode(flow, node.id);
    case "send_buttons":
      say(d, interpolate(node.data.text, vars), { options: node.data.buttons.map((b) => ({ id: b.id, title: b.title })) });
      s.waiting = { kind: "buttons", nodeId: node.id };
      return "wait";
    case "send_list":
      say(d, interpolate(node.data.text, vars), { options: node.data.rows.map((r) => ({ id: r.id, title: r.title })), optionsLabel: node.data.buttonLabel });
      s.waiting = { kind: "list", nodeId: node.id };
      return "wait";
    case "send_template":
      say(d, node.data.templateId ? "[A template message would be sent here]" : "[No template chosen yet]");
      return nextNode(flow, node.id);
    case "ask":
      say(d, interpolate(node.data.text, vars));
      s.waiting = { kind: "ask", nodeId: node.id, retries: 0 };
      return "wait";
    case "condition": {
      const yes = evaluateCondition(node.data.operator, vars[node.data.variable], interpolate(node.data.value, vars));
      note(d, `Checked: ${node.data.variable} ${OPERATOR_TEXT[node.data.operator] ?? node.data.operator} ${node.data.value}`.trim() + `. Answer: ${yes ? "yes" : "no"}.`);
      return nextNode(flow, node.id, yes ? "yes" : "no");
    }
    case "set_attribute":
      vars[`attr.${node.data.attribute}`] = interpolate(node.data.value, vars);
      note(d, `Contact detail "${node.data.attribute}" saved as "${interpolate(node.data.value, vars)}".`);
      return nextNode(flow, node.id);
    case "add_tag":
      note(d, `Tag "${node.data.tag}" added.`);
      return nextNode(flow, node.id);
    case "remove_tag":
      note(d, `Tag "${node.data.tag}" removed.`);
      return nextNode(flow, node.id);
    case "delay":
      note(d, `Waits ${formatMinutes(node.data.minutes)} (skipped in preview).`);
      return nextNode(flow, node.id);
    case "webhook":
      note(d, `Would contact ${node.data.url} (not contacted in preview).`);
      if (node.data.saveAs) vars[node.data.saveAs] = "sample response";
      return nextNode(flow, node.id);
    case "assign":
      note(d, node.data.teamId ? "Put in a team's queue." : node.data.userId === "round_robin" ? "Assigned to the next teammate in turn." : "Assigned to a teammate.");
      return nextNode(flow, node.id);
    case "set_status":
      note(d, `Chat status changed to ${(STATUS_TEXT[node.data.status] ?? node.data.status).toLowerCase()}.`);
      return nextNode(flow, node.id);
    case "handoff":
      if (node.data.message?.trim()) say(d, interpolate(node.data.message, vars));
      note(d, node.data.userId === "team_queue" ? "Left in the team's queue for someone to pick up. The bot stops." : node.data.note === false ? "Handed over to your team. The bot stops." : "Handed over to your team with a private note of what the bot learned. The bot stops.");
      s.status = "handoff";
      return null;
    case "subscribe":
      note(d, `Customer marked as agreed to offers (${node.data.source?.trim() || "Chatbot"}).`);
      return nextNode(flow, node.id);
    case "unsubscribe":
      if (node.data.message?.trim()) say(d, interpolate(node.data.message, vars));
      note(d, "Customer opted out of messages. The bot stops.");
      return null;
    case "end":
      return null;
  }
}

function fresh(): Draft {
  return { state: { nodeId: null, variables: {}, messages: [], waiting: null, status: "waiting" } };
}

/** Starts a simulated run at the flow's start step. Nothing touches the network. */
export function startPreview(flow: FlowDefinition, opening?: string): PreviewState {
  const d = fresh();
  if (opening) d.state.messages.push({ from: "customer", text: opening });
  if (!nodeById(flow, flow.start)) {
    note(d, "This flow has no start step.");
    d.state.status = "ended";
    return d.state;
  }
  enter(flow, d, flow.start);
  return d.state;
}

export type Reply = { text?: string; optionId?: string };

/** Feeds one customer reply to a waiting preview. Returns the same state when the preview is not waiting. */
export function reply(flow: FlowDefinition, prev: PreviewState, input: Reply): PreviewState {
  const w = prev.waiting;
  if (!w || prev.status !== "waiting") return prev;
  const d: Draft = { state: { ...prev, variables: { ...prev.variables }, messages: [...prev.messages] } };
  const node = nodeById(flow, w.nodeId);
  if (!node) return prev;
  const typed = (input.text ?? "").trim();
  const escalate = (fits: boolean, offered: boolean): PreviewState | null => {
    const esc = settingsOf(flow).escalation;
    if (!esc.enabled || offered) return null;
    const signal = detectEscalation(typed, { keywords: esc.keywords, loose: !fits, frustration: true });
    if (!signal) return null;
    say(d, esc.message?.trim() ? interpolate(esc.message, d.state.variables) : "I am connecting you with a member of our team who will reply here shortly.");
    note(d, signal.kind === "frustration" ? "The customer seemed frustrated, so the chat was handed to your team." : "The customer asked for a person, so the chat was handed to your team.");
    d.state.status = "handoff";
    d.state.waiting = null;
    d.state.nodeId = null;
    return d.state;
  };

  if (w.kind === "ask" && node.type === "ask") {
    d.state.messages.push({ from: "customer", text: typed });
    const fits = validateAnswer(node.data.validate, typed, node.data.choices);
    const handed = escalate(fits, fits && node.data.validate === "choice");
    if (handed) return handed;
    if (!validateAnswer(node.data.validate, typed, node.data.choices)) {
      if (w.retries >= node.data.maxRetries) {
        note(d, "Too many invalid answers. The bot stops.");
        d.state.status = "ended";
        d.state.waiting = null;
        d.state.nodeId = null;
        return d.state;
      }
      say(d, node.data.retryText?.trim() ? interpolate(node.data.retryText, d.state.variables) : "Sorry, that does not look right. Please try again.");
      d.state.waiting = { ...w, retries: w.retries + 1 };
      return d.state;
    }
    d.state.variables[node.data.variable] = typed;
    d.state.waiting = null;
    enter(flow, d, nextNode(flow, node.id));
    return d.state;
  }

  const options = node.type === "send_buttons" ? node.data.buttons : node.type === "send_list" ? node.data.rows : [];
  const chosen = options.find((o) => o.id === input.optionId) ?? options.find((o) => o.title.trim().toLowerCase() === typed.toLowerCase()) ?? (/^\d{1,2}$/.test(typed) ? options[Number(typed) - 1] : undefined);
  d.state.messages.push({ from: "customer", text: chosen ? chosen.title : typed });
  const handedOver = escalate(Boolean(chosen), Boolean(chosen));
  if (handedOver) return handedOver;
  if (!chosen) {
    say(d, "Please choose one of the options.");
    return d.state;
  }
  d.state.waiting = null;
  const target = findEdge(flow, node.id, chosen.id)?.to ?? null;
  if (!target && edgesFrom(flow, node.id).length === 0) note(d, "Nothing is connected to this option, so the chat ends.");
  enter(flow, d, target);
  return d.state;
}
