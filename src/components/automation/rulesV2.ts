import { describeRule as describeV2, type NameLookup } from "@/lib/automation/v2/describe";
import {
  checkCompatibility,
  emptyFilters,
  MESSAGE_ONLY_CONDITIONS,
  NO_CHAT_TRIGGERS,
  parseActions,
  parseFilters,
  parseTrigger,
  type Action,
  type ActionType,
  type Condition,
  type ConditionType,
  type Filters,
  type Group,
  type Trigger,
  type TriggerType,
} from "@/lib/automation/v2/model";
import type { Rule } from "./helpers";

export type LastRun = { at: string; outcome: string; detail: string | null };

/** A row of the rules list. Classic rules (version 1) keep their old fields; v2 rules carry trigger, filters and actions. */
export type RuleRow = Rule & {
  version: number;
  priority: number;
  phoneNumberId: string | null;
  stopAfterMatch: boolean;
  trigger: unknown;
  filters: unknown;
  actions: unknown;
  lastRun: LastRun | null;
  runs30d: number;
};

export type Options = {
  templates: { id: string; name: string; language: string; category: string; variables: number }[];
  chatbots: { id: string; name: string }[];
  sequences: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  members: { userId: string; name: string }[];
  segments: { id: string; name: string }[];
  materials: { id: string; name: string; kind: string }[];
  phoneNumbers: { id: string; displayPhone: string; verifiedName: string | null }[];
};

export const EMPTY_OPTIONS: Options = { templates: [], chatbots: [], sequences: [], teams: [], members: [], segments: [], materials: [], phoneNumbers: [] };

export function namesFrom(o: Options): NameLookup {
  const map = <T extends { name: string }>(rows: T[], id: (r: T) => string) => Object.fromEntries(rows.map((r) => [id(r), r.name]));
  return {
    template: map(o.templates, (r) => r.id),
    chatbot: map(o.chatbots, (r) => r.id),
    material: map(o.materials, (r) => r.id),
    user: Object.fromEntries(o.members.map((m) => [m.userId, m.name])),
    team: map(o.teams, (r) => r.id),
    sequence: map(o.sequences, (r) => r.id),
    segment: map(o.segments, (r) => r.id),
  };
}

export type RuleDraftV2 = {
  name: string;
  enabled: boolean;
  phoneNumberId: string | null;
  cooldownMinutes: number;
  stopAfterMatch: boolean;
  trigger: Trigger;
  filters: Filters;
  actions: Action[];
};

export const TRIGGERS: { value: TriggerType; label: string; help: string }[] = [
  { value: "message_received", label: "A customer sends a message", help: "Runs for every new message. Add conditions to pick which ones." },
  { value: "contact_created", label: "A new contact is added", help: "Runs once for each new contact, for example when someone writes for the first time." },
  { value: "no_customer_response", label: "A customer has not replied for a while", help: "Runs when your last message in a chat gets no answer for the time you choose." },
  { value: "scheduled", label: "On a schedule", help: "Runs for your contacts at a set date and time, or every day or week." },
  { value: "tag_added", label: "A tag is added", help: "Runs when someone adds a tag to a contact or a chat." },
  { value: "tag_removed", label: "A tag is removed", help: "Runs when someone removes a tag from a contact or a chat." },
  { value: "attribute_changed", label: "A contact detail changes", help: "Runs when a saved detail such as city or order number changes." },
  { value: "status_changed", label: "A chat status changes", help: "Runs when a chat is opened, set to pending, solved or blocked." },
];

export const CONDITIONS: { value: ConditionType; label: string }[] = [
  { value: "keyword", label: "The message contains certain words" },
  { value: "new_chat", label: "It is the customer's first message" },
  { value: "quiet_for", label: "The customer is new or was quiet for a while" },
  { value: "message_type", label: "The kind of message (text, photo, voice note...)" },
  { value: "time_window", label: "The time of day or week" },
  { value: "attribute", label: "A contact detail has a value" },
  { value: "tag", label: "The contact has a tag" },
  { value: "segment", label: "The contact is in a segment" },
  { value: "phone", label: "The phone number" },
  { value: "assignment", label: "Who the chat is assigned to" },
];

export const ACTION_GROUPS: { label: string; items: { value: ActionType; label: string }[] }[] = [
  {
    label: "Reply",
    items: [
      { value: "send_text", label: "Send a text message" },
      { value: "send_template", label: "Send an approved template" },
      { value: "send_material", label: "Send a reply material" },
    ],
  },
  {
    label: "Hand over",
    items: [
      { value: "assign_user", label: "Assign the chat to a person" },
      { value: "assign_team", label: "Assign the chat to a team" },
      { value: "assign_round_robin", label: "Assign to the next available agent" },
      { value: "notify", label: "Notify a team member" },
    ],
  },
  {
    label: "Automate",
    items: [
      { value: "start_chatbot", label: "Start a chatbot" },
      { value: "start_ai_agent", label: "Let the AI agent answer" },
      { value: "start_lead_sequence", label: "Start a follow-up sequence" },
    ],
  },
  {
    label: "Organise",
    items: [
      { value: "add_tag", label: "Add a tag" },
      { value: "remove_tag", label: "Remove a tag" },
      { value: "update_attribute", label: "Update a contact detail" },
      { value: "set_status", label: "Set the chat status" },
    ],
  },
];

export const STATUS_CHOICES = [
  { value: "open", label: "Open" },
  { value: "pending", label: "Pending" },
  { value: "solved", label: "Solved" },
  { value: "blocked", label: "Blocked (stops all automatic replies)" },
] as const;

export const MESSAGE_TYPE_LABEL: Record<string, string> = {
  text: "Text",
  image: "Photo",
  video: "Video",
  audio: "Voice note or audio",
  document: "Document",
  sticker: "Sticker",
  location: "Location",
  contacts: "Contact card",
  button: "Button tap",
  interactive: "List or button choice",
  order: "Order",
};

export const ATTRIBUTE_OP_LABEL: Record<string, string> = {
  equals: "is",
  not_equals: "is not",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  greater_than: "is more than",
  less_than: "is less than",
  exists: "is filled in",
  not_exists: "is empty",
};

export const WAIT_CHOICES = [
  { label: "No waiting", value: 0 },
  { label: "5 minutes", value: 5 },
  { label: "1 hour", value: 60 },
  { label: "6 hours", value: 360 },
  { label: "12 hours", value: 720 },
  { label: "1 day", value: 1440 },
  { label: "7 days", value: 10080 },
];

export function defaultTrigger(type: TriggerType, timezone: string): Trigger {
  switch (type) {
    case "message_received":
    case "contact_created":
      return { type };
    case "no_customer_response":
      return { type, minutes: 60 };
    case "scheduled":
      return { type, repeat: "daily", time: "10:00", days: [0, 1, 2, 3, 4, 5, 6], timezone };
    case "tag_added":
    case "tag_removed":
      return { type, tag: null };
    case "attribute_changed":
      return { type, attribute: "" };
    case "status_changed":
      return { type, to: null };
  }
}

export function defaultCondition(type: ConditionType, timezone: string): Condition {
  switch (type) {
    case "keyword":
      return { type, mode: "contains", keywords: [] };
    case "new_chat":
      return { type, value: true };
    case "quiet_for":
      return { type, minutes: 720 };
    case "time_window":
      return { type, inside: false, timezone, days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };
    case "attribute":
      return { type, name: "", op: "equals", value: "" };
    case "tag":
      return { type, tag: "", has: true };
    case "segment":
      return { type, segmentId: "", member: true };
    case "message_type":
      return { type, types: ["text"] };
    case "phone":
      return { type, op: "starts_with", value: "" };
    case "assignment":
      return { type, state: "unassigned", userId: null };
  }
}

export function defaultAction(type: ActionType): Action {
  switch (type) {
    case "send_text":
      return { type, text: "" };
    case "send_template":
      return { type, templateId: "", variables: [] };
    case "send_material":
      return { type, materialId: "" };
    case "assign_user":
      return { type, userId: "" };
    case "assign_team":
      return { type, teamId: "", pickAgent: true };
    case "assign_round_robin":
    case "start_ai_agent":
      return { type };
    case "start_chatbot":
      return { type, chatbotId: "" };
    case "update_attribute":
      return { type, name: "", value: "", remove: false };
    case "add_tag":
    case "remove_tag":
      return { type, tag: "", scope: "both" };
    case "set_status":
      return { type, status: "solved" };
    case "notify":
      return { type, target: "assigned", userId: null, message: "" };
    case "start_lead_sequence":
      return { type, sequenceId: "" };
  }
}

export function emptyDraftV2(): RuleDraftV2 {
  return { name: "", enabled: true, phoneNumberId: null, cooldownMinutes: 5, stopAfterMatch: false, trigger: { type: "message_received" }, filters: emptyFilters(), actions: [defaultAction("send_text")] };
}

export function draftFromRow(row: RuleRow): RuleDraftV2 {
  const trigger = parseTrigger(row.trigger);
  const filters = parseFilters(row.filters);
  const actions = parseActions(row.actions);
  return {
    name: row.name,
    enabled: row.enabled,
    phoneNumberId: row.phoneNumberId,
    cooldownMinutes: row.cooldownMinutes,
    stopAfterMatch: row.stopAfterMatch,
    trigger: trigger.ok ? trigger.value : { type: "message_received" },
    filters: filters.ok ? filters.value : emptyFilters(),
    actions: actions.ok ? actions.value : [],
  };
}

export type DraftProblems = { name?: string; trigger?: string; filters?: string; actions?: string; combo?: string };

/** Problems keyed by the step they belong to, so each message shows under its own card. */
export function validateDraftV2(d: RuleDraftV2): DraftProblems {
  const out: DraftProblems = {};
  if (!d.name.trim()) out.name = 'Give the rule a name, for example "Welcome message".';
  else if (d.name.trim().length > 80) out.name = "The name can be up to 80 characters.";
  const trigger = parseTrigger(d.trigger);
  if (!trigger.ok) out.trigger = trigger.error;
  const filters = parseFilters(d.filters);
  if (!filters.ok) out.filters = filters.error;
  const actions = parseActions(d.actions);
  if (!actions.ok) out.actions = actions.error;
  if (trigger.ok && filters.ok && actions.ok) {
    const combo = checkCompatibility(trigger.value, filters.value, actions.value);
    if (combo) out.combo = combo;
  }
  return out;
}

export const hasProblems = (p: DraftProblems) => Object.keys(p).length > 0;

/** Conditions that fit the chosen trigger: word, first-message and message-type checks need an incoming message. */
export function conditionsFor(trigger: Trigger) {
  return trigger.type === "message_received" ? CONDITIONS : CONDITIONS.filter((c) => !MESSAGE_ONLY_CONDITIONS.includes(c.value));
}

export function actionGroupsFor(trigger: Trigger) {
  return ACTION_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => !(i.value === "start_ai_agent" && trigger.type !== "message_received")) })).filter((g) => g.items.length > 0);
}

/** Warnings that do not block saving but explain a likely surprise. */
export function draftWarnings(d: RuleDraftV2): string[] {
  const out: string[] = [];
  const freeform = d.actions.some((a) => a.type === "send_text" || a.type === "send_material");
  if (freeform && (NO_CHAT_TRIGGERS as readonly string[]).includes(d.trigger.type)) out.push("Free-form text only goes out within 24 hours of the customer's last message. Without one, use an approved template.");
  if (freeform && d.trigger.type === "no_customer_response" && d.trigger.minutes >= 1440) out.push("After 24 hours a free-form message cannot be sent. Use an approved template for longer waits.");
  if (d.actions.some((a) => a.type === "send_template") && d.trigger.type === "message_received") out.push("Marketing templates are only sent to contacts who agreed to receive them.");
  return out;
}

export function summaryOf(d: Pick<RuleDraftV2, "trigger" | "filters" | "actions">, names: NameLookup): string {
  return describeV2(d, names);
}

export function ruleSentence(row: RuleRow, names: NameLookup): string | null {
  const trigger = parseTrigger(row.trigger);
  const filters = parseFilters(row.filters);
  const actions = parseActions(row.actions);
  if (!trigger.ok || !actions.ok) return null;
  return describeV2({ trigger: trigger.value, filters: filters.ok ? filters.value : emptyFilters(), actions: actions.value }, names);
}

export type Starter = { id: string; title: string; description: string; build: (timezone: string) => RuleDraftV2 };

const draft = (over: Partial<RuleDraftV2>): RuleDraftV2 => ({ ...emptyDraftV2(), ...over });
const textFilter = (items: Condition[]): Filters => ({ ...emptyFilters(), root: { type: "group", op: "and", items } });

export const STARTERS: Starter[] = [
  {
    id: "welcome",
    title: "Welcome message",
    description: "Greet people the first time they write, and again after they have been quiet for a while.",
    build: () =>
      draft({
        name: "Welcome message",
        cooldownMinutes: 720,
        filters: textFilter([{ type: "quiet_for", minutes: 720 }]),
        actions: [{ type: "send_text", text: "Hi {{first_name|there}}, thanks for messaging us. We will get back to you shortly." }],
      }),
  },
  {
    id: "after-hours",
    title: "Reply when you are closed",
    description: "Tell people when you will be back if they write outside your open hours.",
    build: (timezone) =>
      draft({
        name: "Closed for now",
        cooldownMinutes: 720,
        filters: textFilter([{ type: "time_window", inside: false, timezone, days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" }]),
        actions: [{ type: "send_text", text: "Thanks for your message. We are closed right now and will reply when we open." }],
      }),
  },
  {
    id: "keyword",
    title: "Answer a common question",
    description: "Reply automatically when a message mentions certain words, such as price.",
    build: () =>
      draft({
        name: "Price question",
        cooldownMinutes: 5,
        filters: textFilter([{ type: "keyword", mode: "contains", keywords: ["price", "cost"] }]),
        actions: [{ type: "send_text", text: "Our prices start at ... Tell us what you need and we will send a quote." }],
      }),
  },
  {
    id: "follow-up",
    title: "Follow up when nobody replies",
    description: "Send a gentle nudge when a customer has not answered for an hour.",
    build: () =>
      draft({
        name: "Follow up after 1 hour",
        cooldownMinutes: 1440,
        trigger: { type: "no_customer_response", minutes: 60 },
        actions: [{ type: "send_text", text: "Hi {{first_name|there}}, just checking in. Can we help with anything else?" }],
      }),
  },
  {
    id: "tag-interest",
    title: "Tag interested customers",
    description: "Quietly tag anyone who asks to buy or for a quote, so you can follow up later.",
    build: () =>
      draft({
        name: "Interested customers",
        cooldownMinutes: 1440,
        filters: textFilter([{ type: "keyword", mode: "contains", keywords: ["buy", "order", "quote"] }]),
        actions: [{ type: "add_tag", tag: "interested", scope: "contact" }],
      }),
  },
  {
    id: "route-sales",
    title: "Send sales questions to your team",
    description: "Hand chats that mention buying to the next available agent and let an admin know.",
    build: () =>
      draft({
        name: "Sales questions",
        cooldownMinutes: 60,
        filters: textFilter([{ type: "keyword", mode: "contains", keywords: ["buy", "order", "quote"] }]),
        actions: [{ type: "assign_round_robin" }, { type: "notify", target: "admins", userId: null, message: "A customer is asking to buy." }],
      }),
  },
];

const RTF = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat("en", { numeric: "auto" }) : null;

/** "5 minutes ago", "yesterday", or the date for older things. */
export function relativeTime(iso: string | Date, now = Date.now()): string {
  const t = typeof iso === "string" ? Date.parse(iso) : iso.getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Math.round((t - now) / 1000);
  const abs = Math.abs(diff);
  if (!RTF) return new Date(t).toLocaleString();
  if (abs < 60) return "just now";
  if (abs < 3600) return RTF.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return RTF.format(Math.round(diff / 3600), "hour");
  if (abs < 7 * 86400) return RTF.format(Math.round(diff / 86400), "day");
  return new Date(t).toLocaleDateString();
}

export const OUTCOME_LABEL: Record<string, { label: string; tone: "good" | "neutral" | "bad" }> = {
  ok: { label: "Ran", tone: "good" },
  skipped: { label: "Skipped", tone: "neutral" },
  failed: { label: "Failed", tone: "bad" },
};

export function toBody(d: RuleDraftV2) {
  return {
    version: 2,
    name: d.name.trim(),
    enabled: d.enabled,
    phoneNumberId: d.phoneNumberId,
    cooldownMinutes: d.cooldownMinutes,
    stopAfterMatch: d.stopAfterMatch,
    trigger: d.trigger,
    filters: d.filters,
    actions: d.actions,
  };
}

function pruneGroup(group: Group): Group {
  const items: (Condition | Group)[] = [];
  for (const item of group.items) {
    if (item.type === "group") {
      const inner = pruneGroup(item);
      if (inner.items.length > 0) items.push(inner);
    } else if (!MESSAGE_ONLY_CONDITIONS.includes(item.type)) {
      items.push(item);
    }
  }
  return { ...group, items };
}

/** Changing the trigger drops the parts that cannot work with the new one. Returns what was dropped, in words, so the page can say so. */
export function applyTrigger(draft: RuleDraftV2, trigger: Trigger): { draft: RuleDraftV2; dropped: string[] } {
  const dropped: string[] = [];
  let filters = draft.filters;
  let actions = draft.actions;
  if (trigger.type !== "message_received") {
    const pruned = pruneGroup(draft.filters.root);
    if (JSON.stringify(pruned) !== JSON.stringify(draft.filters.root)) dropped.push("word, first-message and message-type conditions");
    filters = { ...draft.filters, root: pruned };
    const kept = actions.filter((a) => a.type !== "start_ai_agent");
    if (kept.length !== actions.length) dropped.push("the AI agent step");
    actions = kept;
  }
  return { draft: { ...draft, trigger, filters, actions }, dropped };
}
