import type { Action, Condition, Filters, Group, Trigger } from "./model";

/** Display names for ids stored in a rule, so the summary can say "Welcome template" instead of an id. Missing names fall back to a plain word. */
export type NameLookup = {
  template?: Record<string, string>;
  chatbot?: Record<string, string>;
  material?: Record<string, string>;
  user?: Record<string, string>;
  team?: Record<string, string>;
  sequence?: Record<string, string>;
  segment?: Record<string, string>;
};

export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatMinutes(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`);
const quote = (items: string[], max = 4) => list([...items.slice(0, max).map((i) => `"${i}"`), ...(items.length > max ? [`${items.length - max} more`] : [])]);
const days = (d: number[]) => (d.length === 7 ? "every day" : d.map((x) => DAY_SHORT[x]).join(", "));
const name = (map: Record<string, string> | undefined, id: string, fallback: string) => map?.[id] ?? fallback;

const OP_WORDS: Record<string, string> = {
  equals: "is",
  not_equals: "is not",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  greater_than: "is more than",
  less_than: "is less than",
};

export function describeTrigger(trigger: Trigger): string {
  switch (trigger.type) {
    case "message_received":
      return "a customer sends a message";
    case "contact_created":
      return "a new contact is added";
    case "no_customer_response":
      return `the customer has not replied for ${formatMinutes(trigger.minutes)}`;
    case "scheduled":
      if (trigger.repeat === "once") return `it is ${trigger.time} on ${trigger.date ?? "the chosen day"} (${trigger.timezone})`;
      return `it is ${trigger.time} ${trigger.repeat === "daily" ? "every day" : `on ${days(trigger.days)}`} (${trigger.timezone})`;
    case "tag_added":
      return trigger.tag ? `the tag "${trigger.tag}" is added` : "any tag is added";
    case "tag_removed":
      return trigger.tag ? `the tag "${trigger.tag}" is removed` : "any tag is removed";
    case "attribute_changed":
      return `the contact detail "${trigger.attribute}" changes`;
    case "status_changed":
      return trigger.to ? `a chat is marked ${trigger.to}` : "a chat status changes";
  }
}

export function describeCondition(c: Condition, names: NameLookup = {}): string {
  switch (c.type) {
    case "keyword":
      return `the message ${c.mode === "exact" ? "is exactly" : "contains"} ${quote(c.keywords)}`;
    case "new_chat":
      return c.value ? "it is the customer's first message" : "the customer has written before";
    case "quiet_for":
      return `it is the customer's first message or they were quiet for at least ${formatMinutes(c.minutes)}`;
    case "time_window":
      return `${c.inside ? "it is" : "it is not"} ${days(c.days)} ${c.start} to ${c.end} (${c.timezone})`;
    case "attribute":
      return c.op === "exists" ? `"${c.name}" is filled in` : c.op === "not_exists" ? `"${c.name}" is empty` : `"${c.name}" ${OP_WORDS[c.op]} "${c.value}"`;
    case "tag":
      return c.has ? `the contact has the tag "${c.tag}"` : `the contact does not have the tag "${c.tag}"`;
    case "segment":
      return `${c.member ? "the contact is in" : "the contact is not in"} the segment "${name(names.segment, c.segmentId, "chosen segment")}"`;
    case "message_type":
      return `the message is ${list(c.types)}`;
    case "phone":
      return `the phone number ${c.op === "equals" ? "is" : c.op === "starts_with" ? "starts with" : "contains"} ${c.value}`;
    case "assignment":
      return c.state === "assigned" ? "the chat is assigned to someone" : c.state === "unassigned" ? "the chat is not assigned" : `the chat is assigned to ${name(names.user, c.userId ?? "", "the chosen person")}`;
  }
}

function describeGroup(group: Group, names: NameLookup, top: boolean): string {
  const parts = group.items.map((item) => (item.type === "group" ? describeGroup(item, names, false) : describeCondition(item, names))).filter(Boolean);
  if (parts.length === 0) return "";
  const joined = parts.join(group.op === "and" ? " and " : " or ");
  return top || parts.length === 1 ? joined : `(${joined})`;
}

export function describeFilters(filters: Filters, names: NameLookup = {}): string {
  return describeGroup(filters.root, names, true);
}

export function describeAction(a: Action, names: NameLookup = {}): string {
  switch (a.type) {
    case "send_text":
      return "send a text reply";
    case "send_template":
      return `send the template "${name(names.template, a.templateId, "chosen template")}"`;
    case "send_material":
      return `send "${name(names.material, a.materialId, "chosen reply material")}"`;
    case "assign_user":
      return `assign the chat to ${name(names.user, a.userId, "the chosen person")}`;
    case "assign_team":
      return `assign the chat to the team "${name(names.team, a.teamId, "chosen team")}"`;
    case "assign_round_robin":
      return "assign the chat to the next available agent";
    case "start_chatbot":
      return `start the chatbot "${name(names.chatbot, a.chatbotId, "chosen chatbot")}"`;
    case "start_ai_agent":
      return "let the AI agent answer";
    case "update_attribute":
      return a.remove ? `clear the contact detail "${a.name}"` : `set "${a.name}" to "${a.value}"`;
    case "add_tag":
      return `add the tag "${a.tag}"`;
    case "remove_tag":
      return `remove the tag "${a.tag}"`;
    case "set_status":
      return `mark the chat ${a.status}`;
    case "notify":
      return a.target === "assigned" ? "notify the assigned agent" : a.target === "admins" ? "notify the admins" : `notify ${name(names.user, a.userId ?? "", "the chosen person")}`;
    case "start_lead_sequence":
      return `start the follow-up sequence "${name(names.sequence, a.sequenceId, "chosen sequence")}"`;
  }
}

/** One sentence for the whole rule, for example: When a customer sends a message and the message contains "price", send the template "Prices". */
export function describeRule(def: { trigger: Trigger; filters: Filters; actions: Action[] }, names: NameLookup = {}): string {
  const when = describeTrigger(def.trigger);
  const cond = describeFilters(def.filters, names);
  const then = def.actions.map((a) => describeAction(a, names));
  const doing = then.length === 0 ? "do nothing yet" : then.length === 1 ? then[0] : `${then.slice(0, -1).join(", ")} and ${then[then.length - 1]}`;
  return `When ${when}${cond ? ` and ${cond}` : ""}, ${doing}.`;
}
