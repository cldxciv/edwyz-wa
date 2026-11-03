import { LONG_WAIT_MESSAGE, LONG_WAIT_MINUTES, longWaitProblems } from "@/lib/chatbots/long-wait";
import { NODE_META, handlesOf } from "./catalog";
import { reachable } from "./flow";
import { LIMITS, type FlowDefinition, type FlowNode, type TriggerType } from "./types";

export type Issue = { severity: "error" | "warning"; nodeId?: string; message: string; /** Set when the fix is in the Settings tab rather than on a step. */ tab?: "settings" };

// Same rules as the server (lib/chatbots/flow.ts), so a step that looks ready here is accepted when publishing.
const VAR = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ATTRIBUTE = /^[A-Za-z0-9_ -]{1,64}$/;
const CONDITION_VAR = /^[A-Za-z_][A-Za-z0-9_.\- ]{0,127}$/;
const BLOCKED_HOSTS = [/^localhost$/, /\.localhost$/, /\.local$/, /\.internal$/, /\.localdomain$/, /^metadata(\.|$)/];
/** The server's own long-wait rule (lib/chatbots/long-wait): after a wait this long, the bot's next message must be a template. */
export { LONG_WAIT_MINUTES };

export const isVariableName = (v: string) => VAR.test(v);

/** Plain-language reason the server would refuse a web step address, or null. Literal private IPs are caught by the server. */
function webAddressProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "Enter a web address starting with https://.";
  }
  if (url.protocol !== "https:") return "Enter a web address starting with https://.";
  if (url.username || url.password) return "The web address cannot contain a user name or password.";
  if (url.port && url.port !== "443" && url.port !== "8443") return "Use a public address on port 443 or 8443.";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!host || BLOCKED_HOSTS.some((re) => re.test(host)) || isPrivateLiteral(host)) return "Use a public address. Local and private network addresses are not allowed.";
  if (url.href.length > 2048) return "The web address is too long.";
  return null;
}

function isPrivateLiteral(host: string): boolean {
  if (host.includes(":")) return /^(::1?|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:|::ffff:)/.test(host);
  if (/^\d+$/.test(host) || /^0x/i.test(host)) return true;
  const p = host.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return false;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Plain-language problems that stop one step from working. Empty when the step is ready. */
export function validateNode(node: FlowNode): string[] {
  const out: string[] = [];
  const text = (t: string) => {
    if (!t.trim()) out.push("The message text is empty.");
    else if (t.length > LIMITS.text) out.push(`The text is longer than ${LIMITS.text} characters.`);
  };
  const frame = (header?: string, footer?: string) => {
    if ((header ?? "").length > LIMITS.headerText) out.push(`The header can be at most ${LIMITS.headerText} characters.`);
    if ((footer ?? "").length > LIMITS.footer) out.push(`The footer can be at most ${LIMITS.footer} characters.`);
  };
  switch (node.type) {
    case "send_text":
      text(node.data.text);
      break;
    case "send_buttons": {
      text(node.data.text);
      const b = node.data.buttons;
      if (b.length === 0) out.push("Add at least one button.");
      if (b.length > LIMITS.buttons) out.push(`Too many buttons: WhatsApp allows ${LIMITS.buttons}.`);
      if (b.some((x) => !x.title.trim())) out.push("A button has no title.");
      if (b.some((x) => x.title.length > LIMITS.buttonTitle)) out.push(`Button titles can be at most ${LIMITS.buttonTitle} characters.`);
      if (new Set(b.map((x) => x.title.trim().toLowerCase())).size !== b.length) out.push("Two buttons share the same title.");
      frame(node.data.header, node.data.footer);
      break;
    }
    case "send_list": {
      text(node.data.text);
      const r = node.data.rows;
      if (!node.data.buttonLabel.trim()) out.push("The list needs a button label.");
      else if (node.data.buttonLabel.length > LIMITS.buttonTitle) out.push(`The list button label can be at most ${LIMITS.buttonTitle} characters.`);
      if (r.length === 0) out.push("Add at least one row.");
      if (r.length > LIMITS.rows) out.push(`Too many rows: a list allows ${LIMITS.rows}.`);
      if (r.some((x) => !x.title.trim())) out.push("A row has no title.");
      if (r.some((x) => x.title.length > LIMITS.rowTitle)) out.push(`Row titles can be at most ${LIMITS.rowTitle} characters.`);
      frame(node.data.header, node.data.footer);
      break;
    }
    case "send_template":
      if (!node.data.templateId) out.push("Choose a template.");
      if (node.data.headerMediaUrl && !/^(https:\/\/\S+|\{\{\s*[A-Za-z0-9_.\- ]+\s*\}\})$/i.test(node.data.headerMediaUrl.trim())) out.push("The header picture or file link must start with https://.");
      break;
    case "ask":
      text(node.data.text);
      if (!VAR.test(node.data.variable)) out.push("Give the answer a short name using letters, numbers and underscores, starting with a letter.");
      if (!Number.isInteger(node.data.maxRetries) || node.data.maxRetries < 0 || node.data.maxRetries > 5) out.push("Choose between 0 and 5 retries.");
      if (node.data.validate === "choice" && !(node.data.choices ?? []).some((c) => c.trim())) out.push("Add at least one allowed answer.");
      break;
    case "condition":
      if (!node.data.variable.trim()) out.push("Choose which saved answer to check.");
      else if (!CONDITION_VAR.test(node.data.variable)) out.push("The saved answer name cannot start with a number and can only use letters, numbers, spaces, dots, dashes and underscores.");
      if (node.data.operator !== "exists" && !node.data.value.trim()) out.push("Enter the value to compare with.");
      if ((node.data.operator === "gt" || node.data.operator === "lt") && node.data.value.trim() && Number.isNaN(Number(node.data.value))) out.push("Greater and less than need a number.");
      break;
    case "set_attribute":
      if (!node.data.attribute.trim()) out.push("Enter the name of the contact detail.");
      else if (!ATTRIBUTE.test(node.data.attribute)) out.push("The contact detail name can use letters, numbers, spaces, dashes and underscores, up to 64 characters.");
      break;
    case "add_tag":
    case "remove_tag":
      if (!node.data.tag.trim()) out.push("Enter the tag name.");
      break;
    case "delay":
      if (!Number.isInteger(node.data.minutes) || node.data.minutes < LIMITS.delayMin || node.data.minutes > LIMITS.delayMax) out.push("Choose a wait time between 1 minute and 7 days.");
      break;
    case "webhook":
      {
        const problem = webAddressProblem(node.data.url);
        if (problem) out.push(problem);
      }
      if (node.data.saveAs && !VAR.test(node.data.saveAs)) out.push("The name for saving the reply must use letters, numbers and underscores.");
      break;
    case "assign":
      if (!node.data.userId && !node.data.teamId) out.push("Choose a teammate or a team to assign the chat to.");
      break;
    case "handoff":
      if ((node.data.message ?? "").length > LIMITS.text) out.push(`The message is longer than ${LIMITS.text} characters.`);
      break;
    default:
      break;
  }
  return out;
}

export function validateFlowIssues(flow: FlowDefinition): Issue[] {
  const issues: Issue[] = [];
  const add = (severity: Issue["severity"], message: string, nodeId?: string) => issues.push({ severity, message, nodeId });
  if (flow.nodes.length === 0) {
    add("error", "This chatbot has no steps yet. Add one from the list, or start from a template.");
    return issues;
  }
  if (flow.nodes.length > LIMITS.nodes) add("error", `A flow can have at most ${LIMITS.nodes} steps.`);
  if (flow.edges.length > LIMITS.edges) add("error", `A flow can have at most ${LIMITS.edges} connections.`);
  const ids = new Set(flow.nodes.map((n) => n.id));
  if (!flow.start || !ids.has(flow.start)) add("error", "There is no start step. Open a step and choose \"Make this the first step\".");

  const longWaits = new Set(longWaitProblems(flow.nodes, flow.edges).map((n) => n.id));
  for (const node of flow.nodes) {
    const name = NODE_META[node.type].label;
    for (const m of validateNode(node)) add("error", `${name}: ${m}`, node.id);
    const out = flow.edges.filter((e) => e.from === node.id);
    if (longWaits.has(node.id)) add("error", `${name}: ${LONG_WAIT_MESSAGE.charAt(0).toLowerCase()}${LONG_WAIT_MESSAGE.slice(1)}`, node.id);
    for (const h of handlesOf(node)) {
      if (!h.optional && !out.some((e) => e.label === h.label)) {
        const terminalish = h.label === undefined;
        add("warning", terminalish ? `${name}: nothing follows this step, so the chat ends here.` : `${name}: "${h.text}" leads nowhere, so the chat ends there.`, node.id);
      }
    }
  }
  for (const e of flow.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) add("error", "A connection points to a step that was deleted. Remove it and connect the step again.");
  }
  if (ids.has(flow.start)) {
    const seen = reachable(flow);
    for (const node of flow.nodes) {
      if (!seen.has(node.id)) add("warning", `${NODE_META[node.type].label}: this step cannot be reached from the start.`, node.id);
    }
  }
  return issues;
}

/** The per-step problems in a refused publish (422 { errors: [{ nodeId?, message }] }), worded like the checks done while editing. */
export function serverIssuesOf(error: unknown, flow: FlowDefinition): Issue[] {
  const list = (error as { body?: { errors?: unknown } } | null)?.body?.errors;
  if (!Array.isArray(list)) return [];
  const out: Issue[] = [];
  for (const item of list) {
    const message = typeof item?.message === "string" ? item.message : "";
    if (!message) continue;
    const node = typeof item.nodeId === "string" ? flow.nodes.find((n) => n.id === item.nodeId) : undefined;
    out.push({ severity: "error", ...(node ? { nodeId: node.id } : {}), message: node ? `${NODE_META[node.type].label}: ${message}` : message });
  }
  return out;
}

export function validateTrigger(type: TriggerType, keywords: string[], name: string): Issue[] {
  const out: Issue[] = [];
  if (!name.trim()) out.push({ severity: "error", tab: "settings", message: "Give the chatbot a name." });
  if (type === "keyword" && keywords.length === 0) out.push({ severity: "error", tab: "settings", message: "Add at least one keyword so the bot knows when to start." });
  return out;
}

export type PublishedBot = { id: string; name: string; status: string; triggerType: TriggerType; triggerKeywords: string[]; phoneNumberId?: string | null };
export type TriggerDoc = { triggerType: TriggerType; triggerKeywords: string[]; phoneNumberId: string | null };

const STARTS_WHEN: Partial<Record<TriggerType, string>> = { first_message: "when a customer writes for the first time", any_message: "on every message" };
// Same order as the server (lib/chatbots): "Which chatbot goes first" (lowest number), then the older bot.
const WHO_WINS = "Only one chatbot can answer a message: the one with the lower number under Which chatbot goes first, otherwise the older one.";

/**
 * Other published chatbots that would compete for the same messages as this one. Warnings only, since publishing is allowed; the
 * message says which bot wins and what to change. A bot tied to another phone number never competes.
 */
export function validateTriggerConflicts(doc: TriggerDoc, selfId: string | undefined, bots: PublishedBot[]): Issue[] {
  const out: Issue[] = [];
  const sameNumber = (b: PublishedBot) => !doc.phoneNumberId || !b.phoneNumberId || b.phoneNumberId === doc.phoneNumberId;
  const others = bots.filter((b) => b.id !== selfId && b.status === "published" && sameNumber(b));
  const when = STARTS_WHEN[doc.triggerType];
  if (when) {
    for (const b of others.filter((b) => b.triggerType === doc.triggerType)) {
      out.push({ severity: "warning", tab: "settings", message: `"${b.name}" is already published and also starts ${when}. ${WHO_WINS} Pause one of them, or change when this one starts.` });
    }
  }
  if (doc.triggerType === "keyword") {
    const mine = new Set(doc.triggerKeywords.map((k) => k.trim().toLowerCase()).filter(Boolean));
    for (const b of others.filter((b) => b.triggerType === "keyword")) {
      const shared = b.triggerKeywords.filter((k) => mine.has(k.trim().toLowerCase()));
      if (shared.length === 0) continue;
      out.push({ severity: "warning", tab: "settings", message: `"${b.name}" is already published and also starts on ${shared.map((k) => `"${k}"`).join(", ")}. ${WHO_WINS} Remove the shared words from one of them.` });
    }
  }
  return out;
}

export const hasErrors = (issues: Issue[]) => issues.some((i) => i.severity === "error");
