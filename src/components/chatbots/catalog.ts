import { OPT_OUT_REPLY } from "@/lib/contacts/opt-out";
import type { FlowNode, NodeDataMap, NodeType, Point } from "./types";

export type NodeMeta = { label: string; group: "Messages" | "Collect and decide" | "Contact and team" | "Flow control"; help: string };

export const NODE_META: Record<NodeType, NodeMeta> = {
  send_text: { label: "Send a message", group: "Messages", help: "Sends a plain text message." },
  send_buttons: { label: "Send buttons", group: "Messages", help: "A message with up to 3 reply buttons. Each button can lead to its own step." },
  send_list: { label: "Send a menu", group: "Messages", help: "A message with a menu of up to 10 options. Each option can lead to its own step." },
  send_template: { label: "Send a template", group: "Messages", help: "Sends one of your approved message templates." },
  ask: { label: "Ask a question", group: "Collect and decide", help: "Asks something, waits for the reply and remembers the answer." },
  condition: { label: "Check an answer", group: "Collect and decide", help: "Looks at a saved answer and goes one way for yes and another for no." },
  set_attribute: { label: "Save a contact detail", group: "Contact and team", help: "Saves a value on the contact, such as a city or a plan." },
  add_tag: { label: "Add a tag", group: "Contact and team", help: "Adds a tag to the contact so you can find them later." },
  remove_tag: { label: "Remove a tag", group: "Contact and team", help: "Removes a tag from the contact." },
  assign: { label: "Assign to a teammate or team", group: "Contact and team", help: "Gives the conversation to a teammate or a team, or shares chats equally." },
  set_status: { label: "Change chat status", group: "Contact and team", help: "Marks the conversation as open, waiting or solved." },
  delay: { label: "Wait", group: "Flow control", help: "Pauses the bot for a while before the next step." },
  webhook: { label: "Connect to another app", group: "Flow control", help: "Sends information to a website or app you use, and can remember its reply. For advanced use." },
  handoff: { label: "Hand over to your team", group: "Flow control", help: "Stops the bot, passes the conversation to a team or teammate and leaves them a note of what the bot learned." },
  subscribe: { label: "Allow offers", group: "Contact and team", help: "Records that the customer agreed to receive offers and updates from you, and where they agreed." },
  unsubscribe: { label: "Stop messages", group: "Contact and team", help: "Opts the customer out of marketing, like a STOP reply, and ends the chatbot. They still get order updates and replies to their own messages. Use it when someone asks you to stop." },
  end: { label: "End", group: "Flow control", help: "Ends the conversation with the bot." },
};

export const GROUPS: NodeMeta["group"][] = ["Messages", "Collect and decide", "Contact and team", "Flow control"];

export function defaultData(type: NodeType): NodeDataMap[NodeType] {
  switch (type) {
    case "send_text": return { text: "" };
    case "send_buttons": return { text: "", buttons: [{ id: "b1", title: "Yes" }, { id: "b2", title: "No" }] };
    case "send_list": return { text: "", buttonLabel: "Choose", rows: [{ id: "r1", title: "Option 1" }, { id: "r2", title: "Option 2" }] };
    case "send_template": return { templateId: "", variables: {} };
    case "ask": return { text: "", variable: "answer", validate: "text", retryText: "", maxRetries: 2 };
    case "condition": return { variable: "", operator: "equals", value: "" };
    case "set_attribute": return { attribute: "", value: "" };
    case "add_tag": return { tag: "" };
    case "remove_tag": return { tag: "" };
    case "delay": return { minutes: 5 };
    case "webhook": return { url: "", method: "GET", bodyTemplate: "", saveAs: "" };
    case "assign": return { userId: "round_robin" };
    case "set_status": return { status: "pending" };
    case "handoff": return { message: "" };
    case "subscribe": return {};
    case "unsubscribe": return { message: OPT_OUT_REPLY };
    case "end": return {};
  }
}

export function makeNode(type: NodeType, id: string, position: Point): FlowNode {
  return { id, type, position, data: defaultData(type) } as FlowNode;
}

/** Outgoing connection points of a node. `label` is the edge label (undefined for the single default output). */
export type Handle = { label: string | undefined; text: string; /** Leaving it unconnected is normal, so no warning is shown. */ optional?: boolean };

export function handlesOf(node: FlowNode): Handle[] {
  switch (node.type) {
    case "send_buttons": return [...node.data.buttons.map((b) => ({ label: b.id, text: b.title || "(button)" })), { label: "default", text: "Anything else", optional: true }];
    case "send_list": return [...node.data.rows.map((r) => ({ label: r.id, text: r.title || "(row)" })), { label: "default", text: "Anything else", optional: true }];
    case "condition": return [{ label: "yes", text: "Yes" }, { label: "no", text: "No" }];
    case "send_template": return [{ label: undefined, text: "Next" }, { label: "error", text: "If it cannot be sent", optional: true }];
    case "webhook": return [{ label: undefined, text: "Next" }, { label: "error", text: "If it fails", optional: true }];
    case "ask": return [{ label: undefined, text: "Next" }, { label: "invalid", text: "If answers keep failing", optional: true }];
    case "end":
    case "unsubscribe":
    case "handoff": return [];
    default: return [{ label: undefined, text: "Next" }];
  }
}

export const isBranching = (node: FlowNode) => handlesOf(node).length > 1;

export const OPERATOR_TEXT: Record<string, string> = {
  equals: "is",
  not_equals: "is not",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  not_starts_with: "does not start with",
  exists: "has a value",
  gt: "is greater than",
  lt: "is less than",
};

export const STATUS_TEXT: Record<string, string> = { open: "Open", pending: "Pending", solved: "Solved" };

/** "90" becomes "1 hour 30 minutes". Used for wait steps. */
export function formatMinutes(total: number): string {
  if (!Number.isFinite(total) || total < 1) return "0 minutes";
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  const part = (n: number, unit: string) => (n > 0 ? `${n} ${unit}${n === 1 ? "" : "s"}` : "");
  return [part(days, "day"), part(hours, "hour"), part(minutes, "minute")].filter(Boolean).join(" ");
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}\u2026` : text);

/** A name a person can recognise in a menu: "2. Send buttons: Pick one". Never shows internal ids. */
export function describeStep(nodes: FlowNode[], node: FlowNode): string {
  const index = nodes.findIndex((n) => n.id === node.id);
  const text = summarize(node).replace(/\s+/g, " ").trim();
  const head = `${index + 1}. ${NODE_META[node.type].label}`;
  return text ? `${head}: ${clip(text, 32)}` : head;
}

/** Names of answers the bot can have saved by the time it reaches this flow: questions and web replies. */
export function savedVariables(nodes: FlowNode[]): string[] {
  const names = new Set<string>();
  for (const n of nodes) {
    if (n.type === "ask" && n.data.variable) names.add(n.data.variable);
    if (n.type === "webhook" && n.data.saveAs) names.add(n.data.saveAs);
  }
  return [...names];
}

export function summarize(node: FlowNode): string {
  const d = node.data as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (node.type) {
    case "send_text":
    case "send_buttons":
    case "send_list":
    case "ask": return s(d.text);
    case "send_template": return s(d.templateId) ? "Template chosen" : "";
    case "condition": return s(d.variable) ? `${s(d.variable)} ${OPERATOR_TEXT[s(d.operator)] ?? s(d.operator)} ${s(d.value)}`.trim() : "";
    case "set_attribute": return s(d.attribute) ? `${s(d.attribute)} = ${s(d.value)}` : "";
    case "add_tag":
    case "remove_tag": return s(d.tag);
    case "delay": return `Wait ${formatMinutes(Number(d.minutes))}`;
    case "webhook": return s(d.url);
    case "assign": return s(d.teamId) ? "A team" : s(d.userId) === "round_robin" ? "Round robin" : "A teammate";
    case "set_status": return STATUS_TEXT[s(d.status)] ?? s(d.status);
    case "handoff": return s(d.message);
    case "subscribe": return s(d.source) || "Chatbot";
    case "unsubscribe": return s(d.message);
    case "end": return "";
  }
}

/** What a step that works with nothing filled in does, so its card never reads "Not set up yet" when nothing is missing. */
const NOTHING_TO_SET_UP: Partial<Record<FlowNode["type"], (node: FlowNode) => string>> = {
  end: () => "The chat ends here",
  handoff: (n) => ((n.data as Record<string, unknown>).userId === "team_queue" ? "Leaves the chat in your team's queue" : "Hands the chat to your team"),
};

/** The line under a step's name on the canvas: its content, what it does when it needs no content, or else what is missing. */
export function cardSummary(node: FlowNode): string {
  return summarize(node) || NOTHING_TO_SET_UP[node.type]?.(node) || "Not set up yet";
}
