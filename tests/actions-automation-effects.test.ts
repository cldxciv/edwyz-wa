import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeActionsDb } from "./helpers/fake-actions-db";

/**
 * docs/EDDY-SPEC.md 4.2a and 4.8 test 8 (EDDY-05 acceptance 12), through the real v1 definitions and executor:
 * - an enabled `tag_added: vip` rule that sends free text turns tag_contacts {add:['vip']} into a card with
 *   triggers_automation; one that sends a template is refused in v1 with triggers_paid_rule;
 * - with no matching rule the tag is added at once, with Undo;
 * - an Undo that would fire a `tag_removed` rule is not done in one tap (the member undoes it on the page);
 * - a start_chatbot step whose bot has AI escalation on counts as AI spend;
 * - enabling a matching rule between preview and confirm gives 409 changed with a new card;
 * - status, attribute, new-contact and chat-tag writes are checked the same way;
 * - the classifier knows every trigger and step type the engine has (12.2 risk 19).
 */
const h = vi.hoisted(() => ({ db: null as unknown as FakeActionsDb }));
vi.mock("@/lib/db", async () => {
  const { createFakeActionsDb } = await import("./helpers/fake-actions-db");
  h.db = createFakeActionsDb();
  return { prisma: h.db.prisma };
});
// The contacts service as the route uses it, over the in-memory rows (its read-back uses findFirstOrThrow).
vi.mock("@/lib/contacts/service", () => ({
  updateContact: vi.fn(async (actor: { tenantId: string }, id: string, patch: { tags?: string[]; attributes?: Record<string, unknown>; name?: string }) => {
    const row = h.db.rows("contact").find((c) => c.id === id && c.tenantId === actor.tenantId)!;
    Object.assign(row, patch);
    return row;
  }),
  createContact: vi.fn(async () => ({ id: "k_new", phone: "+919000000000" })),
}));

import { confirmAction, proposeAction, resetInvokeState, undoAction, type AutomationRuleRow } from "@/lib/actions/invoke";
import { clearPrincipalMemo, eddyPrincipal } from "@/lib/actions/principal";
import { EVENT_TYPES } from "@/lib/automation/v2/emit";
import { ACTION_TYPES, TRIGGER_TYPES } from "@/lib/automation/v2/model";
import { AGENT, T1, fakeAutomation, seedMembers, testDeps } from "./helpers/action-fixtures";

const eddy = () => eddyPrincipal({ actor: AGENT, emailVerified: true, conversationId: "cv_eddy", lang: "en", turnId: `turn_${Math.random()}` });
const recent = new Date(Date.now() - 60_000);

// The definitions load their services on first use; load them once up front so no single test pays for it under a busy
// parallel run, and give each test room on a slow machine.
vi.setConfig({ testTimeout: 30_000 });
beforeAll(async () => {
  await Promise.all([import("@/lib/inbox/status"), import("@/lib/inbox/actor-ops"), import("@/lib/teams/visibility"), import("@/lib/automation/v2/emit"), import("@/lib/actions/canonical")]);
}, 120_000);

let rules: AutomationRuleRow[] = [];
const rule = (id: string, trigger: Record<string, unknown>, actions: Record<string, unknown>[], updatedAt = new Date(1000)): AutomationRuleRow => ({
  id,
  name: `Rule ${id}`,
  priority: 1,
  createdAt: new Date(0),
  updatedAt,
  trigger,
  filters: { root: { type: "group", op: "and", items: [] }, options: { allowWhenHumanActive: true } },
  actions,
});
const TEXT = [{ type: "send_text", text: "Thanks for being a VIP" }];
const TEMPLATE = [{ type: "send_template", templateId: "t1", variables: [] }];

const port = () =>
  fakeAutomation([], {
    enabledRules: vi.fn(async () => rules),
    chatbot: vi.fn(async (_t: string, id: string) => (id === "bot_ai" ? { flow: { nodes: [{ id: "n1", type: "send_text" }], settings: { escalation: { enabled: true, useAi: true } } }, publishedFlow: null } : { flow: { nodes: [{ id: "n1", type: "send_text" }] }, publishedFlow: null })),
    context: vi.fn(async (_t: string, event: { contactId?: string }) => {
      const c = h.db.rows("contact").find((x) => x.id === event.contactId);
      return { contactTags: (c?.tags as string[]) ?? [], chatTags: [], attributes: (c?.attributes as Record<string, unknown>) ?? {}, phone: "+919876543210", assignedToId: null };
    }),
  });
const deps = () => testDeps({ automation: port() });
const tagsOf = (id: string) => h.db.rows("contact").find((c) => c.id === id)!.tags as string[];

beforeEach(() => {
  h.db.reset();
  seedMembers(h.db);
  rules = [];
  h.db.insert("contact", { id: "k1", tenantId: T1, name: "Ramesh", phone: "+919876543210", tags: [], attributes: { city: "Pune" }, optIn: true, optedOutAt: null, ownerUserId: null, leadStage: null, createdAt: new Date() });
  h.db.insert("conversation", { id: "cv1", tenantId: T1, phoneNumberId: "pn1", contactId: "k1", status: "open", tags: [], assignedToId: AGENT.userId, teamId: null, lastInboundAt: recent, lastMessageAt: recent });
  resetInvokeState();
  clearPrincipalMemo();
});

describe("writes that start automations (4.2a, 4.8 test 8)", () => {
  it("a free-text rule on tag_added vip turns the tag into a card with triggers_automation and the rule as a fact", async () => {
    rules = [rule("r_vip", { type: "tag_added", tag: "vip" }, TEXT)];
    const out = await proposeAction(eddy(), "tag_contacts", { contactIds: ["k1"], add: ["vip"] }, {}, deps());
    expect(out.model.status).toBe("preview_shown");
    expect(out.card!.preview.warnings).toContain("triggers_automation");
    expect(out.card!.preview.facts).toEqual(expect.arrayContaining([{ labelKey: "card.fact.automation.text", value: { $untrusted: "workspace_text", text: "Rule r_vip" } }]));
    expect(out.card!.preview.material).toMatchObject({ "rule:r_vip": new Date(1000).toISOString() });
    expect(tagsOf("k1")).toEqual([]);
  });

  it("a rule that sends a template is refused in v1 with triggers_paid_rule, and nothing changes", async () => {
    rules = [rule("r_tpl", { type: "tag_added", tag: "vip" }, TEMPLATE)];
    const out = await proposeAction(eddy(), "tag_contacts", { contactIds: ["k1"], add: ["vip"] }, {}, deps());
    expect(out.model).toEqual({ status: "refused", code: "triggers_paid_rule" });
    expect(tagsOf("k1")).toEqual([]);
  });

  it("with no matching rule the tag is added at once, with Undo", async () => {
    rules = [rule("r_other", { type: "tag_added", tag: "gold" }, TEXT)];
    const out = await proposeAction(eddy(), "tag_contacts", { contactIds: ["k1"], add: ["vip"] }, {}, deps());
    expect(out.model).toMatchObject({ status: "done", undoAvailable: true });
    expect(tagsOf("k1")).toEqual(["vip"]);
    const undone = await undoAction({ principal: eddy(), actionId: out.actionId! }, deps());
    expect(undone).toMatchObject({ status: 200, state: "undone" });
    expect(tagsOf("k1")).toEqual([]);
  });

  it("an Undo that would fire a tag_removed rule is not done in one tap", async () => {
    const out = await proposeAction(eddy(), "tag_contacts", { contactIds: ["k1"], add: ["vip"] }, {}, deps());
    expect(out.model.status).toBe("done");
    rules = [rule("r_removed", { type: "tag_removed", tag: "vip" }, TEXT)];
    const undone = await undoAction({ principal: eddy(), actionId: out.actionId! }, deps());
    expect(undone).toMatchObject({ status: 409, code: "triggers_automation" });
    expect(tagsOf("k1")).toEqual(["vip"]);
    rules = [rule("r_removed_paid", { type: "tag_removed", tag: "vip" }, TEMPLATE)];
    expect(await undoAction({ principal: eddy(), actionId: out.actionId! }, deps())).toMatchObject({ status: 409, code: "triggers_paid_rule" });
  });

  it("a start_chatbot step whose bot has AI escalation on counts as AI spend (refused in v1)", async () => {
    rules = [rule("r_bot", { type: "tag_added", tag: "vip" }, [{ type: "start_chatbot", chatbotId: "bot_ai" }])];
    expect((await proposeAction(eddy(), "tag_contacts", { contactIds: ["k1"], add: ["vip"] }, {}, deps())).model).toEqual({ status: "refused", code: "triggers_paid_rule" });
    rules = [rule("r_bot_plain", { type: "tag_added", tag: "vip" }, [{ type: "start_chatbot", chatbotId: "bot_plain" }])];
    const plain = await proposeAction(eddy(), "tag_contacts", { contactIds: ["k1"], add: ["vip"] }, {}, deps());
    expect(plain.model.status).toBe("preview_shown");
    expect(plain.card!.preview.facts).toEqual(expect.arrayContaining([expect.objectContaining({ labelKey: "card.fact.automation.chatbot" })]));
  });

  it("enabling a matching rule between preview and confirm gives 409 changed with a new card", async () => {
    rules = [rule("r_a", { type: "tag_added", tag: "vip" }, TEXT)];
    const d = deps();
    const out = await proposeAction(eddy(), "tag_contacts", { contactIds: ["k1"], add: ["vip"] }, {}, d);
    expect(out.model.status).toBe("preview_shown");
    rules = [...rules, rule("r_b", { type: "tag_added", tag: null }, TEXT, new Date(2000))];
    const res = await confirmAction({ principal: eddy(), actionId: out.card!.actionId, nonce: out.card!.nonce, previewHash: out.card!.previewHash }, d);
    expect(res).toMatchObject({ status: 409, state: "changed", code: "changed" });
    expect(res.card?.preview.material).toMatchObject({ "rule:r_b": new Date(2000).toISOString() });
    expect(tagsOf("k1")).toEqual([]);
    // The new card, confirmed, applies the tag.
    const again = await confirmAction({ principal: eddy(), actionId: res.card!.actionId, nonce: res.card!.nonce, previewHash: res.card!.previewHash }, d);
    expect(again).toMatchObject({ status: 200, state: "done" });
    expect(tagsOf("k1")).toEqual(["vip"]);
  });
});

describe("the other writes that announce events (4.2a)", () => {
  it("status, attribute, new contact and chat tags each become a card when a free-text rule matches", async () => {
    rules = [
      rule("r_status", { type: "status_changed", to: "solved" }, TEXT),
      rule("r_attr", { type: "attribute_changed", attribute: "city" }, TEXT),
      rule("r_new", { type: "contact_created" }, TEXT),
      rule("r_chat", { type: "tag_added", tag: "urgent" }, TEXT),
    ];
    const cases: [string, Record<string, unknown>][] = [
      ["set_conversation_status", { conversationId: "cv1", status: "solved" }],
      ["update_contact", { contactId: "k1", setAttributes: [{ key: "city", value: "Mumbai" }] }],
      ["create_contact", { phone: "+919000000000", name: "New lead" }],
      ["tag_conversations", { conversationIds: ["cv1"], add: ["urgent"] }],
    ];
    for (const [name, args] of cases) {
      const out = await proposeAction(eddy(), name, args, {}, deps());
      expect(out.model.status, name).toBe("preview_shown");
      expect(out.card!.preview.warnings, name).toContain("triggers_automation");
    }
    // With no rules the same writes run at once.
    rules = [];
    expect((await proposeAction(eddy(), "update_contact", { contactId: "k1", setAttributes: [{ key: "city", value: "Mumbai" }] }, {}, deps())).model).toMatchObject({ status: "done", undoAvailable: true });
    expect(h.db.rows("contact").find((c) => c.id === "k1")!.attributes).toEqual({ city: "Mumbai" });
  });
});

describe("the classifier keeps up with the engine (12.2 risk 19)", () => {
  /** Every step type, by what it means for Eddy's check: messages a customer, spends, or neither. */
  const STEP_CLASSES: Record<string, "free_text" | "paid_or_ai" | "transitive" | "no_message"> = {
    send_text: "free_text",
    send_template: "paid_or_ai",
    send_material: "transitive",
    start_chatbot: "transitive",
    start_ai_agent: "paid_or_ai",
    start_lead_sequence: "paid_or_ai",
    assign_user: "no_message",
    assign_team: "no_message",
    assign_round_robin: "no_message",
    update_attribute: "no_message",
    add_tag: "no_message",
    remove_tag: "no_message",
    set_status: "no_message",
    notify: "no_message",
  };
  const TRIGGERS = ["message_received", "contact_created", "no_customer_response", "scheduled", "tag_added", "tag_removed", "attribute_changed", "status_changed"];

  it("knows every step type and trigger type; a new one fails here until it is classified", () => {
    expect([...ACTION_TYPES].sort()).toEqual(Object.keys(STEP_CLASSES).sort());
    expect([...TRIGGER_TYPES].sort()).toEqual([...TRIGGERS].sort());
  });

  it("the events Eddy's writes can emit are exactly the engine's event types", () => {
    expect([...EVENT_TYPES].sort()).toEqual(["attribute_changed", "contact_created", "status_changed", "tag_added", "tag_removed"]);
  });

  it("a step that messages nobody does not make a card", async () => {
    rules = [rule("r_quiet", { type: "tag_added", tag: "vip" }, [{ type: "add_tag", tag: "seen", scope: "contact" }, { type: "notify", target: "admins", userId: null, message: "VIP" }])];
    expect((await proposeAction(eddy(), "tag_contacts", { contactIds: ["k1"], add: ["vip"] }, {}, deps())).model).toMatchObject({ status: "done" });
  });
});
