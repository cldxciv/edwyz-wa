import { isWithinOpenHours, matchesKeywords, normalizeText } from "../match";
import type { Condition, Filters, Group } from "./model";

/** Everything a condition may look at, loaded before evaluation so the check itself is pure. */
export type RuleContext = {
  now: Date;
  text: string;
  messageType: string;
  /** True when this is the customer's first message in the chat. */
  newChat: boolean;
  /** Minutes since the customer's previous message in this chat, or null for the first one. */
  silentMinutes: number | null;
  phone: string;
  contactTags: string[];
  chatTags: string[];
  attributes: Record<string, unknown>;
  assignedToId: string | null;
  /** Ids of the segments the contact belongs to, for the segments this rule mentions. */
  segments: ReadonlySet<string>;
};

const digits = (value: string) => value.replace(/\D/g, "");

export function attributeText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function attributeMatches(c: Extract<Condition, { type: "attribute" }>, attributes: Record<string, unknown>): boolean {
  const key = Object.keys(attributes).find((k) => k.toLowerCase() === c.name.toLowerCase());
  const actual = key === undefined ? "" : attributeText(attributes[key]);
  if (c.op === "exists") return actual !== "";
  if (c.op === "not_exists") return actual === "";
  const a = normalizeText(actual);
  const b = normalizeText(c.value);
  switch (c.op) {
    case "equals":
      return a === b;
    case "not_equals":
      return a !== b;
    case "contains":
      return a.includes(b);
    case "not_contains":
      return !a.includes(b);
    case "starts_with":
      return a.startsWith(b);
    case "greater_than":
    case "less_than": {
      const x = Number(actual);
      const y = Number(c.value);
      if (actual === "" || !Number.isFinite(x) || !Number.isFinite(y)) return false;
      return c.op === "greater_than" ? x > y : x < y;
    }
  }
}

export function conditionMatches(c: Condition, ctx: RuleContext): boolean {
  switch (c.type) {
    case "keyword":
      return matchesKeywords(ctx.text, c.keywords, c.mode);
    case "new_chat":
      return ctx.newChat === c.value;
    case "quiet_for":
      return ctx.silentMinutes === null || ctx.silentMinutes >= c.minutes;
    case "time_window": {
      const inside = isWithinOpenHours({ timezone: c.timezone, days: c.days, start: c.start, end: c.end }, ctx.now);
      return c.inside ? inside : !inside;
    }
    case "attribute":
      return attributeMatches(c, ctx.attributes);
    case "tag": {
      const wanted = c.tag.toLowerCase();
      const has = [...ctx.contactTags, ...ctx.chatTags].some((t) => t.toLowerCase() === wanted);
      return c.has ? has : !has;
    }
    case "segment":
      return c.member ? ctx.segments.has(c.segmentId) : !ctx.segments.has(c.segmentId);
    case "message_type":
      return c.types.includes(ctx.messageType);
    case "phone": {
      const have = digits(ctx.phone);
      const want = digits(c.value);
      if (!want) return false;
      return c.op === "equals" ? have === want : c.op === "starts_with" ? have.startsWith(want) : have.includes(want);
    }
    case "assignment":
      if (c.state === "assigned") return ctx.assignedToId !== null;
      if (c.state === "unassigned") return ctx.assignedToId === null;
      return ctx.assignedToId === c.userId;
  }
}

export function groupMatches(group: Group, ctx: RuleContext): boolean {
  if (group.items.length === 0) return true;
  const test = (item: Condition | Group) => (item.type === "group" ? groupMatches(item, ctx) : conditionMatches(item, ctx));
  return group.op === "and" ? group.items.every(test) : group.items.some(test);
}

export const filtersMatch = (filters: Filters, ctx: RuleContext) => groupMatches(filters.root, ctx);

/** Ids of every segment a filter tree mentions, so the engine loads membership only for those. */
export function segmentIds(group: Group): string[] {
  const out = new Set<string>();
  const walk = (g: Group) => {
    for (const item of g.items) {
      if (item.type === "group") walk(item);
      else if (item.type === "segment") out.add(item.segmentId);
    }
  };
  walk(group);
  return [...out];
}
