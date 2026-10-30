import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionList } from "@/components/automation/ActionEditor";
import { UsageMeter } from "@/components/automation/AutomationSettings";
import { GroupEditor } from "@/components/automation/ConditionEditor";
import {
  ACTION_GROUPS,
  CONDITIONS,
  EMPTY_OPTIONS,
  STARTERS,
  TRIGGERS,
  actionGroupsFor,
  applyTrigger,
  conditionsFor,
  defaultAction,
  defaultCondition,
  defaultTrigger,
  draftFromRow,
  draftWarnings,
  emptyDraftV2,
  hasProblems,
  namesFrom,
  relativeTime,
  ruleSentence,
  toBody,
  validateDraftV2,
  type Options,
  type RuleRow,
} from "@/components/automation/rulesV2";
import { ACTION_TYPES, CONDITION_TYPES, TRIGGER_TYPES, parseDefinition } from "@/lib/automation/v2/model";
import { NAV_ITEMS } from "@/components/app/nav";

const OPTIONS: Options = {
  ...EMPTY_OPTIONS,
  templates: [{ id: "tp1", name: "Promo", language: "en", category: "UTILITY", variables: 2 }],
  members: [{ userId: "u1", name: "Asha" }],
  materials: [{ id: "m1", name: "Price list", kind: "document" }],
  segments: [{ id: "s1", name: "VIPs" }],
};

describe("the builder offers everything the engine supports", () => {
  it("lists every trigger, condition and action type exactly once", () => {
    expect(TRIGGERS.map((t) => t.value).sort()).toEqual([...TRIGGER_TYPES].sort());
    expect(CONDITIONS.map((c) => c.value).sort()).toEqual([...CONDITION_TYPES].sort());
    expect(ACTION_GROUPS.flatMap((g) => g.items.map((i) => i.value)).sort()).toEqual([...ACTION_TYPES].sort());
  });

  it("every default is accepted by the validators", () => {
    for (const type of TRIGGER_TYPES) {
      const trigger = defaultTrigger(type, "Asia/Kolkata");
      const draft = { ...emptyDraftV2(), trigger, name: "x" };
      const problems = validateDraftV2({ ...draft, actions: [defaultAction("add_tag")].map((a) => (a.type === "add_tag" ? { ...a, tag: "t" } : a)) });
      // a trigger that needs a value from the person (attribute name) is allowed to be incomplete by default
      if (type !== "attribute_changed") expect(problems.trigger, type).toBeUndefined();
    }
    for (const type of CONDITION_TYPES) expect(defaultCondition(type, "UTC").type).toBe(type);
    for (const type of ACTION_TYPES) expect(defaultAction(type).type).toBe(type);
  });

  it("hides the conditions and steps that cannot work with the chosen start", () => {
    const message = defaultTrigger("message_received", "UTC");
    const tag = defaultTrigger("tag_added", "UTC");
    expect(conditionsFor(message).map((c) => c.value)).toContain("keyword");
    expect(conditionsFor(tag).map((c) => c.value)).not.toContain("keyword");
    expect(conditionsFor(tag).map((c) => c.value)).not.toContain("new_chat");
    expect(actionGroupsFor(message).flatMap((g) => g.items.map((i) => i.value))).toContain("start_ai_agent");
    expect(actionGroupsFor(tag).flatMap((g) => g.items.map((i) => i.value))).not.toContain("start_ai_agent");
  });
});

describe("recommended rules", () => {
  it.each(STARTERS.map((s) => [s.id, s] as const))("%s is a valid rule as shipped", (_id, starter) => {
    const draft = starter.build("Asia/Kolkata");
    expect(hasProblems(validateDraftV2(draft))).toBe(false);
    expect(parseDefinition(draft)).toMatchObject({ ok: true });
    expect(toBody(draft)).toMatchObject({ version: 2, name: draft.name });
  });
  it("has plain titles and descriptions", () => {
    for (const s of STARTERS) {
      expect(s.title.length).toBeGreaterThan(5);
      expect(s.description).toMatch(/\.$/);
      expect(s.title + s.description).not.toMatch(/payload|webhook|trigger|token/i);
    }
  });
});

describe("draft validation", () => {
  it("reports each problem under its own step", () => {
    const blank = { ...emptyDraftV2(), actions: [] };
    expect(validateDraftV2(blank)).toMatchObject({ name: expect.stringMatching(/name/), actions: expect.stringMatching(/at least one/) });
    const bad = { ...emptyDraftV2(), name: "n", trigger: defaultTrigger("attribute_changed", "UTC"), actions: [defaultAction("send_text")] };
    const problems = validateDraftV2(bad);
    expect(problems.trigger).toMatch(/name of the detail/);
    expect(problems.actions).toMatch(/message/);
    expect(validateDraftV2({ ...emptyDraftV2(), name: "x".repeat(81) }).name).toMatch(/80/);
  });

  it("explains likely surprises without blocking", () => {
    const scheduled = { ...emptyDraftV2(), trigger: defaultTrigger("scheduled", "UTC") };
    expect(draftWarnings(scheduled).join(" ")).toMatch(/24 hours/);
    const waiting = { ...emptyDraftV2(), trigger: { type: "no_customer_response" as const, minutes: 2880 } };
    expect(draftWarnings(waiting).join(" ")).toMatch(/approved template/);
    expect(draftWarnings({ ...emptyDraftV2(), actions: [defaultAction("add_tag")] })).toEqual([]);
  });

  it("changing the start removes parts that no longer fit and says so", () => {
    const draft = {
      ...emptyDraftV2(),
      filters: { options: { allowWhenHumanActive: false }, root: { type: "group" as const, op: "and" as const, items: [{ type: "keyword" as const, mode: "contains" as const, keywords: ["a"] }, { type: "tag" as const, tag: "vip", has: true }] } },
      actions: [defaultAction("start_ai_agent"), { type: "add_tag" as const, tag: "x", scope: "both" as const }],
    };
    const result = applyTrigger(draft, defaultTrigger("tag_added", "UTC"));
    expect(result.draft.filters.root.items).toEqual([{ type: "tag", tag: "vip", has: true }]);
    expect(result.draft.actions.map((a) => a.type)).toEqual(["add_tag"]);
    expect(result.dropped.join(" ")).toMatch(/conditions/);
    expect(result.dropped.join(" ")).toMatch(/AI agent/);
    expect(applyTrigger(draft, { type: "message_received" }).dropped).toEqual([]);
  });
});

describe("list helpers", () => {
  const row = {
    id: "r1",
    version: 2,
    name: "Price",
    enabled: true,
    priority: 10,
    phoneNumberId: null,
    cooldownMinutes: 5,
    stopAfterMatch: false,
    type: "keyword",
    keywords: [],
    matchMode: "contains",
    replyText: "",
    schedule: null,
    trigger: { type: "message_received" },
    filters: { root: { type: "group", op: "and", items: [{ type: "keyword", mode: "contains", keywords: ["price"] }] }, options: { allowWhenHumanActive: false } },
    actions: [{ type: "send_template", templateId: "tp1", variables: ["{{name}}", "x"] }],
    lastRun: null,
    runs30d: 0,
  } as unknown as RuleRow;

  it("writes a sentence with names, and survives a rule it cannot read", () => {
    expect(ruleSentence(row, namesFrom(OPTIONS))).toBe('When a customer sends a message and the message contains "price", send the template "Promo".');
    expect(ruleSentence({ ...row, trigger: { type: "wat" } }, namesFrom(OPTIONS))).toBeNull();
    expect(draftFromRow({ ...row, actions: null })).toMatchObject({ name: "Price", actions: [] });
  });

  it("describes times in words", () => {
    const now = Date.parse("2026-10-27T10:00:00Z");
    expect(relativeTime("2026-10-27T09:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-10-27T09:15:00Z", now)).toBe("45 minutes ago");
    expect(relativeTime("2026-10-26T10:00:00Z", now)).toBe("yesterday");
    expect(relativeTime("not a date", now)).toBe("");
  });

  it("the new page is reachable from the menu", () => {
    expect(NAV_ITEMS.some((i) => i.href === "/app/automation/materials" && i.minRole === "agent")).toBe(true);
  });
});

describe("rendering", () => {
  const ctx = { trigger: { type: "message_received" } as const, options: OPTIONS, timezone: "UTC" };

  it("shows the condition editor with an empty and a filled group", () => {
    const empty = renderToStaticMarkup(createElement(GroupEditor, { group: { type: "group", op: "and", items: [] }, depth: 1, ctx, onChange: () => undefined }));
    expect(empty).toContain("the rule runs every time it starts");
    expect(empty).toContain("Add a condition");
    const filled = renderToStaticMarkup(
      createElement(GroupEditor, {
        group: {
          type: "group",
          op: "or",
          items: [defaultCondition("keyword", "UTC"), defaultCondition("time_window", "UTC"), defaultCondition("attribute", "UTC"), defaultCondition("segment", "UTC"), { type: "group", op: "or", items: [defaultCondition("assignment", "UTC")] }],
        },
        depth: 1,
        ctx,
        onChange: () => undefined,
      }),
    );
    expect(filled).toContain("any one of these is true");
    expect(filled).toContain("VIPs");
    expect(filled).toContain("Remove group");
  });

  it("shows a step list with the right fields for each step", () => {
    const html = renderToStaticMarkup(
      createElement(ActionList, {
        actions: [{ type: "send_template", templateId: "tp1", variables: ["", ""] }, defaultAction("send_material"), defaultAction("notify"), defaultAction("add_tag"), defaultAction("start_ai_agent")],
        trigger: { type: "message_received" },
        options: OPTIONS,
        onMaterialCreated: () => undefined,
        onChange: () => undefined,
      }),
    );
    expect(html).toContain("Value for {{1}}");
    expect(html).toContain("Value for {{2}}");
    expect(html).toContain("Price list");
    expect(html).toContain("Add another step");
    expect(html).toContain("Move step 2 earlier");
  });

  it("the usage meter says what is left and warns near the limit", () => {
    const resetsOn = "2026-11-01T00:00:00.000Z";
    expect(renderToStaticMarkup(createElement(UsageMeter, { usage: { used: 12, limit: null, percent: null, resetsOn } }))).toContain("no limit");
    const warn = renderToStaticMarkup(createElement(UsageMeter, { usage: { used: 85, limit: 100, percent: 85, resetsOn } }));
    expect(warn).toContain("85% of this month");
    const over = renderToStaticMarkup(createElement(UsageMeter, { usage: { used: 100, limit: 100, percent: 100, resetsOn } }));
    expect(over).toContain("paused for this month");
  });
});
