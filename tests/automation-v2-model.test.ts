import { describe, expect, it } from "vitest";
import { describeRule } from "@/lib/automation/v2/describe";
import { filtersMatch, segmentIds, type RuleContext } from "@/lib/automation/v2/evaluate";
import { checkCompatibility, emptyFilters, parseActions, parseDefinition, parseFilters, parseTrigger, type Filters } from "@/lib/automation/v2/model";
import { contactInSegment } from "@/lib/automation/v2/segments";
import { renderText, unknownPlaceholders } from "@/lib/automation/v2/variables";
import { convertDefinition } from "@/lib/automation/v2/service";
import { dueRunKey } from "@/lib/automation/v2/timed";
import { diffTags } from "@/lib/automation/v2/emit";

const ctx = (over: Partial<RuleContext> = {}): RuleContext => ({
  now: new Date("2026-10-26T20:00:00Z"),
  text: "What is the price?",
  messageType: "text",
  newChat: false,
  silentMinutes: 0,
  phone: "+919876543210",
  contactTags: [],
  chatTags: [],
  attributes: {},
  assignedToId: null,
  segments: new Set(),
  ...over,
});

const filters = (items: Filters["root"]["items"], op: "and" | "or" = "and"): Filters => ({ ...emptyFilters(), root: { type: "group", op, items } });

describe("trigger validation", () => {
  it("accepts every trigger type with its parameters", () => {
    expect(parseTrigger({ type: "message_received" })).toEqual({ ok: true, value: { type: "message_received" } });
    expect(parseTrigger({ type: "no_customer_response", minutes: 90 })).toMatchObject({ ok: true });
    expect(parseTrigger({ type: "tag_added", tag: "" })).toEqual({ ok: true, value: { type: "tag_added", tag: null } });
    expect(parseTrigger({ type: "status_changed", to: "solved" })).toMatchObject({ ok: true });
    expect(parseTrigger({ type: "attribute_changed", attribute: "city" })).toMatchObject({ ok: true });
    expect(parseTrigger({ type: "scheduled", repeat: "weekly", time: "09:30", days: [1, 3, 3], timezone: "Asia/Kolkata" })).toEqual({
      ok: true,
      value: { type: "scheduled", repeat: "weekly", time: "09:30", days: [1, 3], timezone: "Asia/Kolkata" },
    });
  });

  it("rejects bad input with a plain message", () => {
    expect(parseTrigger({ type: "nope" })).toMatchObject({ ok: false });
    expect(parseTrigger({ type: "no_customer_response", minutes: 0 })).toMatchObject({ ok: false });
    expect(parseTrigger({ type: "no_customer_response", minutes: 60 * 24 * 31 })).toMatchObject({ ok: false });
    expect(parseTrigger({ type: "scheduled", repeat: "once", time: "09:00", timezone: "UTC" })).toMatchObject({ ok: false });
    expect(parseTrigger({ type: "scheduled", repeat: "daily", time: "25:00", timezone: "UTC" })).toMatchObject({ ok: false });
    expect(parseTrigger({ type: "scheduled", repeat: "daily", time: "09:00", timezone: "Mars/Base" })).toMatchObject({ ok: false });
    expect(parseTrigger({ type: "status_changed", to: "weird" })).toMatchObject({ ok: false });
    expect(parseTrigger({ type: "attribute_changed", attribute: "" })).toMatchObject({ ok: false });
  });
});

describe("filters", () => {
  it("defaults to no conditions and accepts nested groups up to three levels", () => {
    expect(parseFilters(null)).toMatchObject({ ok: true, value: { root: { items: [] } } });
    const deep = (n: number): unknown => ({ type: "group", op: "or", items: n === 0 ? [{ type: "new_chat", value: true }] : [deep(n - 1)] });
    expect(parseFilters({ root: { type: "group", op: "and", items: [deep(1)] } })).toMatchObject({ ok: true });
    expect(parseFilters({ root: { type: "group", op: "and", items: [deep(3)] } })).toMatchObject({ ok: false });
  });

  it("validates each condition type", () => {
    const bad = (c: unknown) => parseFilters({ root: { type: "group", op: "and", items: [c] } }).ok;
    expect(bad({ type: "keyword", mode: "contains", keywords: [] })).toBe(false);
    expect(bad({ type: "keyword", mode: "exact", keywords: ["price"] })).toBe(true);
    expect(bad({ type: "time_window", inside: false, timezone: "UTC", days: [], start: "09:00", end: "17:00" })).toBe(false);
    expect(bad({ type: "attribute", name: "city", op: "equals", value: "" })).toBe(false);
    expect(bad({ type: "attribute", name: "city", op: "exists" })).toBe(true);
    expect(bad({ type: "message_type", types: ["hologram"] })).toBe(false);
    expect(bad({ type: "assignment", state: "user" })).toBe(false);
    expect(bad({ type: "phone", op: "starts_with", value: "abc" })).toBe(false);
    expect(bad({ type: "segment", segmentId: "" })).toBe(false);
  });

  it("evaluates keyword, message type, new chat and phone conditions", () => {
    expect(filtersMatch(filters([{ type: "keyword", mode: "contains", keywords: ["price"] }]), ctx())).toBe(true);
    expect(filtersMatch(filters([{ type: "keyword", mode: "exact", keywords: ["price"] }]), ctx())).toBe(false);
    expect(filtersMatch(filters([{ type: "message_type", types: ["image", "audio"] }]), ctx({ messageType: "audio" }))).toBe(true);
    expect(filtersMatch(filters([{ type: "message_type", types: ["image"] }]), ctx())).toBe(false);
    expect(filtersMatch(filters([{ type: "new_chat", value: true }]), ctx({ newChat: true }))).toBe(true);
    expect(filtersMatch(filters([{ type: "new_chat", value: true }]), ctx())).toBe(false);
    expect(filtersMatch(filters([{ type: "phone", op: "starts_with", value: "+91" }]), ctx())).toBe(true);
    expect(filtersMatch(filters([{ type: "phone", op: "starts_with", value: "+44" }]), ctx())).toBe(false);
  });

  it("evaluates quiet_for as new chat or long silence", () => {
    const f = filters([{ type: "quiet_for", minutes: 720 }]);
    expect(filtersMatch(f, ctx({ silentMinutes: null }))).toBe(true);
    expect(filtersMatch(f, ctx({ silentMinutes: 719 }))).toBe(false);
    expect(filtersMatch(f, ctx({ silentMinutes: 720 }))).toBe(true);
  });

  it("evaluates time windows in the timezone of the rule", () => {
    const closed = filters([{ type: "time_window", inside: false, timezone: "UTC", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }]);
    expect(filtersMatch(closed, ctx({ now: new Date("2026-10-26T20:00:00Z") }))).toBe(true);
    expect(filtersMatch(closed, ctx({ now: new Date("2026-10-26T10:00:00Z") }))).toBe(false);
    const kolkata = filters([{ type: "time_window", inside: true, timezone: "Asia/Kolkata", days: [2], start: "01:00", end: "03:00" }]);
    expect(filtersMatch(kolkata, ctx({ now: new Date("2026-10-26T20:00:00Z") }))).toBe(true);
  });

  it("evaluates contact details, tags and assignment", () => {
    const attrs = { City: " Shimla ", orders: 7 };
    expect(filtersMatch(filters([{ type: "attribute", name: "city", op: "equals", value: "shimla" }]), ctx({ attributes: attrs }))).toBe(true);
    expect(filtersMatch(filters([{ type: "attribute", name: "orders", op: "greater_than", value: "5" }]), ctx({ attributes: attrs }))).toBe(true);
    expect(filtersMatch(filters([{ type: "attribute", name: "orders", op: "less_than", value: "5" }]), ctx({ attributes: attrs }))).toBe(false);
    expect(filtersMatch(filters([{ type: "attribute", name: "missing", op: "not_exists", value: "" }]), ctx({ attributes: attrs }))).toBe(true);
    expect(filtersMatch(filters([{ type: "tag", tag: "VIP", has: true }]), ctx({ contactTags: ["vip"] }))).toBe(true);
    expect(filtersMatch(filters([{ type: "tag", tag: "vip", has: false }]), ctx({ chatTags: ["VIP"] }))).toBe(false);
    expect(filtersMatch(filters([{ type: "assignment", state: "unassigned", userId: null }]), ctx())).toBe(true);
    expect(filtersMatch(filters([{ type: "assignment", state: "user", userId: "u1" }]), ctx({ assignedToId: "u1" }))).toBe(true);
    expect(filtersMatch(filters([{ type: "assignment", state: "assigned", userId: null }]), ctx())).toBe(false);
  });

  it("combines conditions with AND, OR and nested groups", () => {
    const price = { type: "keyword" as const, mode: "contains" as const, keywords: ["price"] };
    const refund = { type: "keyword" as const, mode: "contains" as const, keywords: ["refund"] };
    const vip = { type: "tag" as const, tag: "vip", has: true };
    expect(filtersMatch(filters([price, refund], "and"), ctx())).toBe(false);
    expect(filtersMatch(filters([price, refund], "or"), ctx())).toBe(true);
    const nested = filters([vip, { type: "group", op: "or", items: [price, refund] }]);
    expect(filtersMatch(nested, ctx())).toBe(false);
    expect(filtersMatch(nested, ctx({ contactTags: ["vip"] }))).toBe(true);
    expect(filtersMatch(emptyFilters(), ctx())).toBe(true);
  });

  it("evaluates segment membership from the preloaded set and lists the segments a filter mentions", () => {
    const f = filters([{ type: "segment", segmentId: "s1", member: true }, { type: "group", op: "or", items: [{ type: "segment", segmentId: "s2", member: false }] }]);
    expect(segmentIds(f.root).sort()).toEqual(["s1", "s2"]);
    expect(filtersMatch(f, ctx({ segments: new Set(["s1"]) }))).toBe(true);
    expect(filtersMatch(f, ctx({ segments: new Set(["s1", "s2"]) }))).toBe(false);
  });
});

describe("segments", () => {
  const contact = {
    name: "Asha",
    phone: "+919876543210",
    tags: ["vip"],
    attributes: { city: "Shimla", spend: 900 },
    optInSource: "website",
    optInAt: new Date("2026-09-01"),
    createdAt: new Date("2026-08-01"),
    leadStage: "qualified",
    ownerUserId: null,
    lastInboundAt: new Date("2026-10-25"),
  };
  const now = new Date("2026-10-27T10:00:00Z");
  it("reads the filter format the segments service saves", () => {
    expect(contactInSegment({ all: [{ field: "tag", op: "has", value: "vip" }] }, contact, now)).toBe(true);
    expect(contactInSegment({ all: [{ field: "tag", op: "not_has", value: "vip" }] }, contact, now)).toBe(false);
    expect(contactInSegment({ all: [{ field: "attr:city", op: "contains", value: "shim" }, { field: "attr:spend", op: "greater_than", value: "500" }] }, contact, now)).toBe(true);
    expect(contactInSegment({ any: [{ field: "attr:city", op: "is", value: "Delhi" }, { field: "country", op: "is", value: "IN" }] }, contact, now)).toBe(true);
    expect(contactInSegment({ all: [{ field: "leadStage", op: "is", value: "qualified" }, { field: "lastInbound", op: "within_days", value: "7" }, { field: "createdAt", op: "before", value: "2026-09-01" }] }, contact, now)).toBe(true);
    expect(contactInSegment({ all: [{ field: "lastInbound", op: "older_than_days", value: "1" }] }, contact, now)).toBe(true);
    expect(contactInSegment({ all: [{ field: "attr:city", op: "is", value: "Delhi" }] }, contact, now)).toBe(false);
  });
  it("never matches a segment it cannot read", () => {
    expect(contactInSegment({}, contact)).toBe(false);
    expect(contactInSegment(null, contact)).toBe(false);
    expect(contactInSegment({ all: [{ field: "tag", op: "weird", value: "vip" }] }, contact)).toBe(false);
    expect(contactInSegment({ all: [{ field: "tag", op: "eq", value: "vip" }] }, contact)).toBe(false);
  });
});

describe("actions validation", () => {
  it("needs at least one action and caps the list", () => {
    expect(parseActions([])).toMatchObject({ ok: false });
    expect(parseActions(Array.from({ length: 11 }, () => ({ type: "assign_round_robin" })))).toMatchObject({ ok: false });
  });
  it("validates action parameters", () => {
    expect(parseActions([{ type: "send_text", text: "  " }])).toMatchObject({ ok: false });
    expect(parseActions([{ type: "send_text", text: "x".repeat(1025) }])).toMatchObject({ ok: false });
    expect(parseActions([{ type: "send_template", templateId: "", variables: [] }])).toMatchObject({ ok: false });
    expect(parseActions([{ type: "update_attribute", name: "9bad", value: "x" }])).toMatchObject({ ok: false });
    expect(parseActions([{ type: "update_attribute", name: "city", remove: true }])).toMatchObject({ ok: true });
    expect(parseActions([{ type: "notify", target: "user" }])).toMatchObject({ ok: false });
    expect(parseActions([{ type: "set_status", status: "archived" }])).toMatchObject({ ok: false });
    expect(parseActions([{ type: "add_tag", tag: "vip" }])).toMatchObject({ ok: true, value: [{ type: "add_tag", tag: "vip", scope: "both" }] });
    expect(parseActions([{ type: "teleport" }])).toMatchObject({ ok: false });
  });
  it("refuses conditions and actions that cannot work with the trigger", () => {
    const keyword = { root: { type: "group", op: "and", items: [{ type: "keyword", mode: "contains", keywords: ["a"] }] } };
    expect(parseDefinition({ trigger: { type: "tag_added", tag: null }, filters: keyword, actions: [{ type: "assign_round_robin" }] })).toMatchObject({ ok: false });
    expect(parseDefinition({ trigger: { type: "message_received" }, filters: keyword, actions: [{ type: "start_ai_agent" }] })).toMatchObject({ ok: true });
    expect(parseDefinition({ trigger: { type: "contact_created" }, filters: null, actions: [{ type: "start_ai_agent" }] })).toMatchObject({ ok: false });
    expect(checkCompatibility({ type: "message_received" }, emptyFilters(), [])).toBeNull();
  });
});

describe("plain-language summary", () => {
  it("reads as one sentence with names filled in", () => {
    const sentence = describeRule(
      {
        trigger: { type: "message_received" },
        filters: filters([{ type: "keyword", mode: "contains", keywords: ["price", "cost"] }, { type: "tag", tag: "vip", has: false }]),
        actions: [{ type: "send_template", templateId: "t1", variables: [] }, { type: "add_tag", tag: "asked-price", scope: "both" }],
      },
      { template: { t1: "Price list" } },
    );
    expect(sentence).toBe('When a customer sends a message and the message contains "price" or "cost" and the contact does not have the tag "vip", send the template "Price list" and add the tag "asked-price".');
  });
  it("describes other triggers", () => {
    expect(describeRule({ trigger: { type: "no_customer_response", minutes: 90 }, filters: emptyFilters(), actions: [{ type: "start_ai_agent" }] })).toContain("has not replied for 90 minutes");
    expect(describeRule({ trigger: { type: "scheduled", repeat: "daily", time: "10:00", days: [], timezone: "UTC" }, filters: emptyFilters(), actions: [{ type: "set_status", status: "solved" }] })).toContain("10:00 every day");
  });
});

describe("placeholders", () => {
  const values = { name: "Asha Rao", phone: "+919876543210", attributes: { City: "Shimla" } };
  it("fills name, first name, phone and contact details", () => {
    expect(renderText("Hi {{first_name}} from {{attribute.city}}, we have {{phone}}", values)).toBe("Hi Asha from Shimla, we have +919876543210");
  });
  it("uses fallbacks and never leaves braces behind", () => {
    expect(renderText("Hi {{name}}!", { ...values, name: null })).toBe("Hi there!");
    expect(renderText("In {{attribute.town|your area}}", values)).toBe("In your area");
    expect(renderText("[{{attribute.town}}] {{unknown}}", values)).toBe("[] ");
  });
  it("lists placeholders it does not know", () => {
    expect(unknownPlaceholders("{{name}} {{order_id}} {{attribute.x}}")).toEqual(["order_id"]);
  });
});

describe("converting classic rules", () => {
  const base = { keywords: [] as string[], matchMode: "contains", replyText: "Hello", schedule: null as unknown, cooldownMinutes: 720 };
  it("keyword rules become a keyword condition and a text step", () => {
    const def = convertDefinition({ ...base, type: "keyword", keywords: ["price"], matchMode: "exact", cooldownMinutes: 5 });
    expect(parseDefinition(def)).toMatchObject({ ok: true });
    expect(def.filters.root.items).toEqual([{ type: "keyword", mode: "exact", keywords: ["price"] }]);
    expect(def.actions).toEqual([{ type: "send_text", text: "Hello" }]);
    // Like the classic reply, the converted rule stays quiet while a person is handling the chat.
    expect(def.filters.options).toEqual({ allowWhenHumanActive: false });
  });
  it("welcome rules keep their silence rule and away rules keep their open hours", () => {
    expect(convertDefinition({ ...base, type: "welcome" }).filters.root.items).toEqual([{ type: "quiet_for", minutes: 720 }]);
    const away = convertDefinition({ ...base, type: "away", schedule: { timezone: "Asia/Kolkata", days: [1, 2], start: "09:00", end: "18:00" } });
    expect(away.filters.root.items).toEqual([{ type: "time_window", inside: false, timezone: "Asia/Kolkata", days: [1, 2], start: "09:00", end: "18:00" }]);
    expect(parseDefinition(away)).toMatchObject({ ok: true });
  });
});

describe("schedules", () => {
  const daily = { type: "scheduled" as const, repeat: "daily" as const, time: "10:00", days: [], timezone: "UTC" };
  it("a daily run is due once the time has passed, keyed by the local date", () => {
    expect(dueRunKey(daily, new Date("2026-10-27T09:59:00Z"))).toBeNull();
    expect(dueRunKey(daily, new Date("2026-10-27T10:00:00Z"))).toBe("day:2026-10-27");
    expect(dueRunKey(daily, new Date("2026-10-27T23:00:00Z"))).toBe("day:2026-10-27");
  });
  it("a weekly run only fires on its days and a one-off run fires on its date or the next day", () => {
    const weekly = { ...daily, repeat: "weekly" as const, days: [2] };
    expect(dueRunKey(weekly, new Date("2026-10-26T12:00:00Z"))).toBeNull();
    expect(dueRunKey(weekly, new Date("2026-10-27T12:00:00Z"))).toBe("day:2026-10-27");
    const once = { ...daily, repeat: "once" as const, date: "2026-10-27" };
    expect(dueRunKey(once, new Date("2026-10-27T11:00:00Z"))).toBe("once:2026-10-27");
    expect(dueRunKey(once, new Date("2026-10-28T01:00:00Z"))).toBe("once:2026-10-27");
    expect(dueRunKey(once, new Date("2026-10-29T11:00:00Z"))).toBeNull();
    expect(dueRunKey(once, new Date("2026-10-26T11:00:00Z"))).toBeNull();
  });
});

describe("tag changes", () => {
  it("finds added and removed tags without caring about case", () => {
    expect(diffTags(["VIP", "a"], ["vip", "b"])).toEqual({ added: ["b"], removed: ["a"] });
    expect(diffTags([], [])).toEqual({ added: [], removed: [] });
  });
});
