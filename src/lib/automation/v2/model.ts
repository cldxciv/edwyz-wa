/*
 * Rules v2 data model. Pure (no database, no server-only imports) so the rule builder in the browser and the engine on the
 * server read and validate rules with the same code. A v2 rule is an AutomationRule row with version = 2; the JSON columns hold:
 *   trigger -> Trigger, filters -> Filters, actions -> Action[].
 */

export const TRIGGER_TYPES = ["message_received", "contact_created", "no_customer_response", "scheduled", "tag_added", "tag_removed", "attribute_changed", "status_changed"] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export type Trigger =
  | { type: "message_received" }
  | { type: "contact_created" }
  | { type: "no_customer_response"; minutes: number }
  | { type: "scheduled"; repeat: "once" | "daily" | "weekly"; date?: string; time: string; days: number[]; timezone: string }
  | { type: "tag_added"; tag: string | null }
  | { type: "tag_removed"; tag: string | null }
  | { type: "attribute_changed"; attribute: string }
  | { type: "status_changed"; to: string | null };

export const CONDITION_TYPES = ["keyword", "new_chat", "quiet_for", "time_window", "attribute", "tag", "segment", "message_type", "phone", "assignment"] as const;
export type ConditionType = (typeof CONDITION_TYPES)[number];

export const ATTRIBUTE_OPS = ["equals", "not_equals", "contains", "not_contains", "starts_with", "greater_than", "less_than", "exists", "not_exists"] as const;
export type AttributeOp = (typeof ATTRIBUTE_OPS)[number];
export const PHONE_OPS = ["equals", "starts_with", "contains"] as const;
export const MESSAGE_TYPES = ["text", "image", "video", "audio", "document", "sticker", "location", "contacts", "button", "interactive", "order"] as const;

export type Condition =
  | { type: "keyword"; mode: "contains" | "exact"; keywords: string[] }
  | { type: "new_chat"; value: boolean }
  | { type: "quiet_for"; minutes: number }
  | { type: "time_window"; inside: boolean; timezone: string; days: number[]; start: string; end: string }
  | { type: "attribute"; name: string; op: AttributeOp; value: string }
  | { type: "tag"; tag: string; has: boolean }
  | { type: "segment"; segmentId: string; member: boolean }
  | { type: "message_type"; types: string[] }
  | { type: "phone"; op: (typeof PHONE_OPS)[number]; value: string }
  | { type: "assignment"; state: "assigned" | "unassigned" | "user"; userId: string | null };

export type Group = { type: "group"; op: "and" | "or"; items: (Condition | Group)[] };
export type FilterOptions = { allowWhenHumanActive: boolean };
export type Filters = { root: Group; options: FilterOptions };

export const ACTION_TYPES = [
  "send_text",
  "send_template",
  "send_material",
  "assign_user",
  "assign_team",
  "assign_round_robin",
  "start_chatbot",
  "start_ai_agent",
  "update_attribute",
  "add_tag",
  "remove_tag",
  "set_status",
  "notify",
  "start_lead_sequence",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export type TagScope = "contact" | "chat" | "both";
export const RULE_STATUSES = ["open", "pending", "solved", "blocked"] as const;

export type Action =
  | { type: "send_text"; text: string }
  /**
   * headerVariable fills a heading's {{1}}, headerMediaUrl is the https link of a picture, video or document heading, buttonVariable
   * fills the {{1}} of a link button's web address. Each may use contact placeholders; each is left out when the template has no such gap.
   */
  | { type: "send_template"; templateId: string; variables: string[]; headerVariable?: string; headerMediaUrl?: string; buttonVariable?: string }
  | { type: "send_material"; materialId: string }
  | { type: "assign_user"; userId: string }
  | { type: "assign_team"; teamId: string; pickAgent: boolean }
  | { type: "assign_round_robin" }
  | { type: "start_chatbot"; chatbotId: string }
  | { type: "start_ai_agent" }
  | { type: "update_attribute"; name: string; value: string; remove: boolean }
  | { type: "add_tag"; tag: string; scope: TagScope }
  | { type: "remove_tag"; tag: string; scope: TagScope }
  | { type: "set_status"; status: (typeof RULE_STATUSES)[number] }
  | { type: "notify"; target: "assigned" | "admins" | "user"; userId: string | null; message: string }
  | { type: "start_lead_sequence"; sequenceId: string };

export const LIMITS = {
  text: 1024,
  keywords: 30,
  keywordLength: 60,
  actions: 10,
  conditions: 20,
  depth: 3,
  name: 80,
  tag: 40,
  attribute: 40,
  attributeValue: 200,
  variables: 20,
  variableLength: 200,
  mediaUrl: 1000,
  note: 300,
  noResponseMinutes: 60 * 24 * 30,
  cooldownMinutes: 60 * 24 * 30,
  rules: 50,
} as const;

export const SCHEDULE_KINDS = ["once", "daily", "weekly"] as const;

/** Conditions that only make sense when the rule starts from an incoming message. */
export const MESSAGE_ONLY_CONDITIONS: readonly ConditionType[] = ["keyword", "new_chat", "quiet_for", "message_type"];
/** Triggers that have no chat, so reply actions have nothing to answer. */
export const NO_CHAT_TRIGGERS: readonly TriggerType[] = ["scheduled", "contact_created"];

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const good = <T>(value: T): Result<T> => ({ ok: true, value });

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max + 1) : "");
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const ATTRIBUTE_NAME = /^[A-Za-z][A-Za-z0-9_ -]{0,39}$/;

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function readDays(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return null;
  return [...new Set(value as number[])].sort();
}

export function parseTrigger(raw: unknown): Result<Trigger> {
  if (!isRecord(raw) || typeof raw.type !== "string" || !(TRIGGER_TYPES as readonly string[]).includes(raw.type)) return fail("Choose what starts this rule.");
  switch (raw.type as TriggerType) {
    case "message_received":
      return good({ type: "message_received" });
    case "contact_created":
      return good({ type: "contact_created" });
    case "no_customer_response": {
      const minutes = raw.minutes;
      if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > LIMITS.noResponseMinutes) return fail("Waiting time must be between 1 minute and 30 days.");
      return good({ type: "no_customer_response", minutes });
    }
    case "scheduled": {
      const repeat = raw.repeat;
      if (repeat !== "once" && repeat !== "daily" && repeat !== "weekly") return fail("Choose how often the schedule runs.");
      if (typeof raw.time !== "string" || !TIME.test(raw.time)) return fail("Pick a time of day.");
      if (typeof raw.timezone !== "string" || !isValidTimezone(raw.timezone)) return fail("Pick a valid timezone.");
      if (repeat === "once") {
        if (typeof raw.date !== "string" || !DATE.test(raw.date)) return fail("Pick the date it should run.");
        return good({ type: "scheduled", repeat, date: raw.date, time: raw.time, days: [], timezone: raw.timezone });
      }
      const days = repeat === "weekly" ? readDays(raw.days) : [0, 1, 2, 3, 4, 5, 6];
      if (!days) return fail("Choose at least one day of the week.");
      return good({ type: "scheduled", repeat, time: raw.time, days, timezone: raw.timezone });
    }
    case "tag_added":
    case "tag_removed": {
      const tag = raw.tag === null || raw.tag === undefined || raw.tag === "" ? null : text(raw.tag, LIMITS.tag);
      if (tag !== null && (!tag || tag.length > LIMITS.tag)) return fail(`Tags can be up to ${LIMITS.tag} characters.`);
      return good({ type: raw.type as "tag_added" | "tag_removed", tag });
    }
    case "attribute_changed": {
      const attribute = text(raw.attribute, LIMITS.attribute);
      if (!ATTRIBUTE_NAME.test(attribute)) return fail("Enter the name of the detail that changes, for example city.");
      return good({ type: "attribute_changed", attribute });
    }
    case "status_changed": {
      const to = raw.to === null || raw.to === undefined || raw.to === "" ? null : raw.to;
      if (to !== null && !(RULE_STATUSES as readonly unknown[]).includes(to)) return fail("Choose a chat status.");
      return good({ type: "status_changed", to: to as string | null });
    }
  }
}

export function parseCondition(raw: unknown): Result<Condition> {
  if (!isRecord(raw) || typeof raw.type !== "string") return fail("A condition is not valid.");
  switch (raw.type) {
    case "keyword": {
      const list = raw.keywords;
      if (!Array.isArray(list) || list.length === 0 || list.length > LIMITS.keywords) return fail(`Add between 1 and ${LIMITS.keywords} keywords.`);
      const keywords = [...new Set(list.map((k) => text(k, LIMITS.keywordLength)))];
      if (keywords.some((k) => !k || k.length > LIMITS.keywordLength)) return fail(`Keywords can be up to ${LIMITS.keywordLength} characters.`);
      return good({ type: "keyword", mode: raw.mode === "exact" ? "exact" : "contains", keywords });
    }
    case "new_chat":
      return good({ type: "new_chat", value: raw.value !== false });
    case "quiet_for": {
      const minutes = raw.minutes;
      if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > LIMITS.noResponseMinutes) return fail("Quiet time must be between 1 minute and 30 days.");
      return good({ type: "quiet_for", minutes });
    }
    case "time_window": {
      const days = readDays(raw.days);
      if (!days) return fail("Choose at least one day for the time window.");
      if (typeof raw.start !== "string" || typeof raw.end !== "string" || !TIME.test(raw.start) || !TIME.test(raw.end)) return fail("Set the start and end time of the window.");
      if (typeof raw.timezone !== "string" || !isValidTimezone(raw.timezone)) return fail("Pick a valid timezone for the time window.");
      return good({ type: "time_window", inside: raw.inside !== false, timezone: raw.timezone, days, start: raw.start, end: raw.end });
    }
    case "attribute": {
      const name = text(raw.name, LIMITS.attribute);
      if (!ATTRIBUTE_NAME.test(name)) return fail("Enter the name of the contact detail to check.");
      if (!(ATTRIBUTE_OPS as readonly unknown[]).includes(raw.op)) return fail("Choose how to compare the contact detail.");
      const op = raw.op as AttributeOp;
      const value = typeof raw.value === "string" ? raw.value.trim() : "";
      if (op !== "exists" && op !== "not_exists" && (!value || value.length > LIMITS.attributeValue)) return fail("Enter the value to compare with.");
      return good({ type: "attribute", name, op, value: op === "exists" || op === "not_exists" ? "" : value });
    }
    case "tag": {
      const tag = text(raw.tag, LIMITS.tag);
      if (!tag || tag.length > LIMITS.tag) return fail("Enter a tag to check.");
      return good({ type: "tag", tag, has: raw.has !== false });
    }
    case "segment":
      if (typeof raw.segmentId !== "string" || !raw.segmentId || raw.segmentId.length > 64) return fail("Choose a segment.");
      return good({ type: "segment", segmentId: raw.segmentId, member: raw.member !== false });
    case "message_type": {
      const types = raw.types;
      if (!Array.isArray(types) || types.length === 0 || types.some((t) => !(MESSAGE_TYPES as readonly unknown[]).includes(t))) return fail("Choose at least one message type.");
      return good({ type: "message_type", types: [...new Set(types as string[])] });
    }
    case "phone": {
      if (!(PHONE_OPS as readonly unknown[]).includes(raw.op)) return fail("Choose how to compare the phone number.");
      const value = typeof raw.value === "string" ? raw.value.replace(/[^\d+]/g, "") : "";
      if (value.replace(/\D/g, "").length < 1 || value.length > 20) return fail("Enter digits for the phone number check, for example +91.");
      return good({ type: "phone", op: raw.op as (typeof PHONE_OPS)[number], value });
    }
    case "assignment": {
      if (raw.state !== "assigned" && raw.state !== "unassigned" && raw.state !== "user") return fail("Choose who the chat should be assigned to.");
      const userId = raw.state === "user" ? (typeof raw.userId === "string" && raw.userId ? raw.userId : null) : null;
      if (raw.state === "user" && !userId) return fail("Choose the team member.");
      return good({ type: "assignment", state: raw.state, userId });
    }
    default:
      return fail("A condition is not valid.");
  }
}

function parseGroup(raw: unknown, depth: number, counter: { n: number }): Result<Group> {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return fail("A condition group is not valid.");
  if (depth > LIMITS.depth) return fail("Condition groups can be nested up to three levels.");
  const items: (Condition | Group)[] = [];
  for (const item of raw.items) {
    if (isRecord(item) && item.type === "group") {
      const group = parseGroup(item, depth + 1, counter);
      if (!group.ok) return group;
      items.push(group.value);
    } else {
      if (++counter.n > LIMITS.conditions) return fail(`A rule can have up to ${LIMITS.conditions} conditions.`);
      const condition = parseCondition(item);
      if (!condition.ok) return condition;
      items.push(condition.value);
    }
  }
  return good({ type: "group", op: raw.op === "or" ? "or" : "and", items });
}

export const emptyFilters = (): Filters => ({ root: { type: "group", op: "and", items: [] }, options: { allowWhenHumanActive: false } });

export function parseFilters(raw: unknown): Result<Filters> {
  if (raw === null || raw === undefined) return good(emptyFilters());
  if (!isRecord(raw)) return fail("The conditions are not valid.");
  const root = parseGroup(raw.root ?? { type: "group", op: "and", items: [] }, 1, { n: 0 });
  if (!root.ok) return root;
  const options = isRecord(raw.options) ? raw.options : {};
  return good({ root: root.value, options: { allowWhenHumanActive: options.allowWhenHumanActive === true } });
}

const idOf = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 64 ? v : null);
const SCOPES: readonly string[] = ["contact", "chat", "both"];
/** A heading picture, video or file: a secure link (placeholders may fill parts of it), or one placeholder such as {{attribute.photo}}. */
export const MEDIA_LINK = /^(https:\/\/\S+|\{\{\s*[A-Za-z_][\w. -]{0,60}\s*(\|[^{}]{0,80})?\}\})$/i;

/** An optional template value: undefined when empty, null when it is not valid text of at most max characters. */
function optionalValue(v: unknown, max: number): string | undefined | null {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return undefined;
  return t.length > max ? null : t;
}

export function parseAction(raw: unknown): Result<Action> {
  if (!isRecord(raw) || typeof raw.type !== "string" || !(ACTION_TYPES as readonly string[]).includes(raw.type)) return fail("An action is not valid.");
  switch (raw.type as ActionType) {
    case "send_text": {
      const body = typeof raw.text === "string" ? raw.text.trim() : "";
      if (!body) return fail("Write the message to send.");
      if (body.length > LIMITS.text) return fail(`Messages can be up to ${LIMITS.text} characters.`);
      return good({ type: "send_text", text: body });
    }
    case "send_template": {
      const templateId = idOf(raw.templateId);
      if (!templateId) return fail("Choose a template to send.");
      const vars = raw.variables === undefined ? [] : raw.variables;
      if (!Array.isArray(vars) || vars.length > LIMITS.variables || vars.some((v) => typeof v !== "string" || v.length > LIMITS.variableLength)) return fail("Template values are not valid.");
      const headerVariable = optionalValue(raw.headerVariable, LIMITS.variableLength);
      if (headerVariable === null) return fail(`The heading value can be up to ${LIMITS.variableLength} characters.`);
      const headerMediaUrl = optionalValue(raw.headerMediaUrl, LIMITS.mediaUrl);
      if (headerMediaUrl === null || (headerMediaUrl !== undefined && !MEDIA_LINK.test(headerMediaUrl))) return fail("The link to the picture, video or file must start with https://.");
      const buttonVariable = optionalValue(raw.buttonVariable, LIMITS.variableLength);
      if (buttonVariable === null) return fail(`The button link value can be up to ${LIMITS.variableLength} characters.`);
      return good({
        type: "send_template",
        templateId,
        variables: (vars as string[]).map((v) => v.trim()),
        ...(headerVariable ? { headerVariable } : {}),
        ...(headerMediaUrl ? { headerMediaUrl } : {}),
        ...(buttonVariable ? { buttonVariable } : {}),
      });
    }
    case "send_material": {
      const materialId = idOf(raw.materialId);
      return materialId ? good({ type: "send_material", materialId }) : fail("Choose a reply material to send.");
    }
    case "assign_user": {
      const userId = idOf(raw.userId);
      return userId ? good({ type: "assign_user", userId }) : fail("Choose the team member to assign.");
    }
    case "assign_team": {
      const teamId = idOf(raw.teamId);
      return teamId ? good({ type: "assign_team", teamId, pickAgent: raw.pickAgent !== false }) : fail("Choose the team to assign.");
    }
    case "assign_round_robin":
      return good({ type: "assign_round_robin" });
    case "start_chatbot": {
      const chatbotId = idOf(raw.chatbotId);
      return chatbotId ? good({ type: "start_chatbot", chatbotId }) : fail("Choose the chatbot to start.");
    }
    case "start_ai_agent":
      return good({ type: "start_ai_agent" });
    case "update_attribute": {
      const name = text(raw.name, LIMITS.attribute);
      if (!ATTRIBUTE_NAME.test(name)) return fail("Enter the name of the contact detail to update, for example city.");
      const remove = raw.remove === true;
      const value = typeof raw.value === "string" ? raw.value.trim() : "";
      if (!remove && (!value || value.length > LIMITS.attributeValue)) return fail("Enter the new value for the contact detail.");
      return good({ type: "update_attribute", name, value: remove ? "" : value, remove });
    }
    case "add_tag":
    case "remove_tag": {
      const tag = text(raw.tag, LIMITS.tag);
      if (!tag || tag.length > LIMITS.tag) return fail(`Enter a tag of up to ${LIMITS.tag} characters.`);
      const scope = typeof raw.scope === "string" && SCOPES.includes(raw.scope) ? (raw.scope as TagScope) : "both";
      return good({ type: raw.type as "add_tag" | "remove_tag", tag, scope });
    }
    case "set_status":
      return (RULE_STATUSES as readonly unknown[]).includes(raw.status) ? good({ type: "set_status", status: raw.status as (typeof RULE_STATUSES)[number] }) : fail("Choose a chat status.");
    case "notify": {
      const target = raw.target;
      if (target !== "assigned" && target !== "admins" && target !== "user") return fail("Choose who to notify.");
      const userId = target === "user" ? idOf(raw.userId) : null;
      if (target === "user" && !userId) return fail("Choose the team member to notify.");
      const message = typeof raw.message === "string" ? raw.message.trim() : "";
      if (message.length > LIMITS.note) return fail(`The note can be up to ${LIMITS.note} characters.`);
      return good({ type: "notify", target, userId, message });
    }
    case "start_lead_sequence": {
      const sequenceId = idOf(raw.sequenceId);
      return sequenceId ? good({ type: "start_lead_sequence", sequenceId }) : fail("Choose the follow-up sequence to start.");
    }
  }
}

export function parseActions(raw: unknown): Result<Action[]> {
  if (!Array.isArray(raw) || raw.length === 0) return fail("Add at least one thing for the rule to do.");
  if (raw.length > LIMITS.actions) return fail(`A rule can do up to ${LIMITS.actions} things.`);
  const out: Action[] = [];
  for (const item of raw) {
    const action = parseAction(item);
    if (!action.ok) return action;
    out.push(action.value);
  }
  return good(out);
}

/** Every condition in a group tree, depth first. */
export function flattenConditions(group: Group): Condition[] {
  return group.items.flatMap((item) => (item.type === "group" ? flattenConditions(item) : [item]));
}

/** Cross-field checks: conditions and actions that cannot work with the chosen trigger. */
export function checkCompatibility(trigger: Trigger, filters: Filters, actions: Action[]): string | null {
  if (trigger.type !== "message_received") {
    const bad = flattenConditions(filters.root).find((c) => MESSAGE_ONLY_CONDITIONS.includes(c.type));
    if (bad) return "Keyword, new chat and message type checks only work when the rule starts from a new message.";
  }
  if (trigger.type !== "message_received" && actions.some((a) => a.type === "start_ai_agent")) return "The AI agent can only be started when a customer message arrives.";
  return null;
}

export type RuleDefinition = { trigger: Trigger; filters: Filters; actions: Action[] };

export function parseDefinition(raw: { trigger: unknown; filters: unknown; actions: unknown }): Result<RuleDefinition> {
  const trigger = parseTrigger(raw.trigger);
  if (!trigger.ok) return trigger;
  const filters = parseFilters(raw.filters);
  if (!filters.ok) return filters;
  const actions = parseActions(raw.actions);
  if (!actions.ok) return actions;
  const problem = checkCompatibility(trigger.value, filters.value, actions.value);
  return problem ? fail(problem) : good({ trigger: trigger.value, filters: filters.value, actions: actions.value });
}

/** Running order of rules: lower priority number first, older first on a tie. */
export const byPriority = <T extends { priority: number; createdAt: Date }>(a: T, b: T) => a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime();
