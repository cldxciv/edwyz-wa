import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeActionsDb } from "./helpers/fake-actions-db";

/**
 * docs/EDDY-SPEC.md 4.2, 4.2a, 4.3, 4.4, 4.9 and EDDY-03 acceptance 1, 2, 3, 5, 7 (and the B14 rule, acceptance 7 of the
 * package): the gates in order, each refusal, the registry load rules, cards that never run, audits and invocation rows,
 * automation-starting tag writes, and the model toolsets.
 */
const h = vi.hoisted(() => ({ db: null as unknown as FakeActionsDb }));
vi.mock("@/lib/db", async () => {
  const { createFakeActionsDb } = await import("./helpers/fake-actions-db");
  h.db = createFakeActionsDb();
  return { prisma: h.db.prisma };
});

import { previewHash } from "@/lib/actions/canonical";
import { checkAutomation, concretePath, confirmAction, PREVIEW_NOTE, PRISMA_AUTOMATION, proposeAction, resetInvokeState, spendRefusalCode, UNWIRED_SPEND_BRIDGE } from "@/lib/actions/invoke";
import { toolsetHash, toolsetVersion, toolsFor, TOOLSET_VERSION, roleClassOf, EAGER_INPUT_TOOLS } from "@/lib/actions/model-tools";
import { clearPrincipalMemo, eddyPrincipal, keyPrincipal, systemPrincipal } from "@/lib/actions/principal";
import { definitionProblem, RegistryLoadError, registerActions, resetRegistry, ACTIONS, actionByName, type ActionDefinition } from "@/lib/actions/registry";
import { subjectIdsIn } from "@/lib/actions/subjects";
import { ADMIN, AGENT, OWNER, T1, adminReadDef, basePreview, fakeAudit, fakeAutomation, fakeBridge, fakeWorkspace, pauseDef, readDef, resumeDef, seedMembers, sendDef, sortDefs, tagDef, testDeps, v2Def, freeze } from "./helpers/action-fixtures";
import { HttpError } from "@/lib/tenancy";

const ROOT = path.resolve(__dirname, "..");

const eddy = (actor: { userId: string; tenantId: string; role: "agent" | "admin" | "owner" } = AGENT, extra: { turnId?: string; emailVerified?: boolean } = {}) =>
  eddyPrincipal({ actor, emailVerified: extra.emailVerified ?? true, conversationId: "cv_eddy", lang: "en", turnId: extra.turnId ?? "turn1" });

function register(...defs: ActionDefinition[]) {
  resetRegistry();
  registerActions(sortDefs(defs));
}

beforeEach(() => {
  h.db.reset();
  seedMembers(h.db);
  resetRegistry();
  resetInvokeState();
  clearPrincipalMemo();
  delete process.env.EMAIL_VERIFICATION_REQUIRED;
});

afterEach(() => {
  delete process.env.EMAIL_VERIFICATION_REQUIRED;
});

describe("the gates run in order (4.3)", () => {
  it("G1 to G20 on a v2 spending card: propose, then confirm", async () => {
    const trace: string[] = [];
    const t = (label: string) => trace.push(label);
    const def: ActionDefinition = {
      ...sendDef(),
      name: "ordered_spend",
      version: "v2",
      risk: "confirm",
      route: { method: "POST", path: "/api/broadcasts/[id]/start" },
      inputSchema: { type: "object", properties: { broadcastId: { type: "string" }, text: { type: "string" } }, required: ["broadcastId", "text"], additionalProperties: false },
      effects: async () => {
        t("G10");
        return { writes: true, messagesCustomers: true, spends: "messaging", bulk: true };
      },
      normalize: async (_c, raw) => {
        t("G8");
        return raw;
      },
      authorize: async () => {
        t("G9");
      },
      automationEvents: async () => {
        t("G10-events");
        return [{ type: "tag_added", tenantId: T1, contactId: "k1", tags: ["x"] }];
      },
      preview: async () => {
        t("G14");
        return { titleKey: "card.start", vars: {}, facts: [], cost: { state: "estimate", minor: "45500", currency: "INR", formatted: "₹455", partial: false, worstCase: true }, warnings: [], editable: [], confirmLabelKey: "card.confirm", danger: false, material: { targetId: "b1", costMinor: "45500" } };
      },
      run: async () => {
        t("G18");
        return { result: { started: true }, auditTarget: "b1" };
      },
      forModel: (r) => {
        t("G20");
        return r;
      },
      piiItems: () => {
        t("G20-pii");
        return 0;
      },
    } as ActionDefinition;
    register(def);
    const membership = h.db.prisma.membership as { findUnique: (...a: unknown[]) => Promise<unknown> };
    const findUnique = membership.findUnique;
    membership.findUnique = async (...a: unknown[]) => {
      t("G4");
      return findUnique(...a);
    };
    const records = h.db.prisma.actionRecord as { updateMany: (...a: unknown[]) => Promise<{ count: number }> };
    const updateMany = records.updateMany;
    records.updateMany = async (...a: unknown[]) => {
      const where = (a[0] as { where: { status?: unknown } }).where;
      if (where.status === "pending" && trace.at(-1) !== "G15") t("G15");
      return updateMany(...a);
    };
    const invocations = h.db.prisma.actionInvocation as { create: (...a: unknown[]) => Promise<unknown> };
    const createInvocation = invocations.create;
    invocations.create = async (...a: unknown[]) => {
      if ((a[0] as { data: { outcome: string } }).data.outcome === "started") t("G17-started");
      return createInvocation(...a);
    };
    const deps = testDeps({
      phase: () => 2,
      spendBridge: fakeBridge({
        eddyAssistantReady: async () => (t("G2"), true),
        isDemoWorkspace: async () => (t("G8a"), false),
        freezeState: async () => (t("freeze"), freeze("none")),
        isApprover: async () => (t("G16"), true),
      }),
      workspace: fakeWorkspace({ assertCanWrite: async () => void t("G7"), whatsAppState: async () => (t("G8a-wa"), "connected" as const) }),
      automation: fakeAutomation([], { enabledRules: async () => (t("G10-rules"), []) }),
      limiter: () => ({ consume: () => (t("G13"), true) }),
      audit: { audit: vi.fn(async () => void t("audit")), auditStrict: vi.fn(async () => void t("G17")), auditOutcome: vi.fn(async () => void t("G19")) },
    });

    const proposed = await proposeAction(eddy(ADMIN), "ordered_spend", { broadcastId: "b1", text: "Diwali offer" }, {}, deps);
    expect(proposed.model.status).toBe("preview_shown");
    expect(trace).toEqual(["G2", "G4", "G7", "G8", "G8a", "G8a-wa", "G9", "G10", "G10-events", "G10-rules", "freeze", "G13", "G13", "G14"]);

    trace.length = 0;
    const card = proposed.card!;
    const confirmed = await confirmAction({ principal: eddy(ADMIN), actionId: card.actionId, nonce: card.nonce, previewHash: card.previewHash }, deps);
    expect(confirmed).toMatchObject({ status: 200, state: "done" });
    expect(trace).toEqual([
      "G15",
      "G2", "G4", "G7", "G8", "G8a", "G8a-wa", "G9", "G10", "G10-events", "G10-rules", "freeze", "G13", "G13", "G14",
      "freeze", "G16", "G17", "G17-started", "G18", "G19", "G20", "G20-pii",
    ]);
  });
});

describe("refusals of EDDY-03 acceptance 1", () => {
  it("unknown name", async () => {
    register(readDef());
    const out = await proposeAction(eddy(), "drop_database", {}, {}, testDeps());
    expect(out.model).toEqual({ status: "refused", code: "unknown_action" });
    expect(h.db.rows("actionInvocation")).toEqual([expect.objectContaining({ stage: "refuse", outcome: "refused", code: "unknown_action", action: "drop_database", argsRedacted: {} })]);
  });

  it("invalid arguments come back as an is_error result with the validator's sentence, and nothing runs", async () => {
    const def = tagDef();
    register(def);
    const out = await proposeAction(eddy(), "tag_fixture", { conversationId: "cv1" }, {}, testDeps());
    expect(out.isError).toBe(true);
    expect(out.model).toEqual({ status: "failed", code: "invalid_args", detail: { $untrusted: "external_text", text: "arguments.tag is required." } });
    const extra = await proposeAction(eddy(), "tag_fixture", { conversationId: "cv1", tag: "vip", sneaky: true }, {}, testDeps());
    expect(extra.model).toMatchObject({ code: "invalid_args" });
    expect(def.run).not.toHaveBeenCalled();
  });

  it("the wrong surface is an unknown action", async () => {
    register(tagDef());
    const key = keyPrincipal({ via: "mcp", keyId: "k1", actor: AGENT, scopes: ["conversations:write"] });
    h.db.insert("apiKey", { id: "k1", tenantId: T1, revokedAt: null });
    const out = await proposeAction(key, "tag_fixture", { conversationId: "cv1", tag: "vip" }, {}, testDeps());
    expect(out.model).toEqual({ status: "refused", code: "unknown_action" });
  });

  it("a role below minRole names who can, as untrusted teammate names", async () => {
    const def = adminReadDef();
    register(def);
    const out = await proposeAction(eddy(AGENT), "admin_report", {}, {}, testDeps());
    expect(out.model).toEqual({ status: "refused", code: "role", requiredRole: "admin", who: [{ $untrusted: "teammate_note", text: "Priya" }, { $untrusted: "teammate_note", text: "Omar" }] });
    expect(out.refused).toMatchObject({ code: "role", who: ["Priya", "Omar"], status: 403 });
    expect(def.run).not.toHaveBeenCalled();
    expect((await proposeAction(eddy(ADMIN), "admin_report", {}, {}, testDeps())).model.status).toBe("done");
  });

  it("a key without the scope is refused; with it the call runs", async () => {
    register(readDef());
    h.db.insert("apiKey", { id: "k1", tenantId: T1, revokedAt: null });
    const without = keyPrincipal({ via: "mcp", keyId: "k1", actor: AGENT, scopes: ["templates:read"] });
    expect((await proposeAction(without, "get_things", {}, {}, testDeps())).model).toEqual({ status: "refused", code: "scope" });
    const withScope = keyPrincipal({ via: "mcp", keyId: "k1", actor: AGENT, scopes: ["contacts:write"] });
    expect((await proposeAction(withScope, "get_things", {}, {}, testDeps())).model.status).toBe("done");
  });

  it("an unverified email is refused on a write and allowed on a read", async () => {
    process.env.EMAIL_VERIFICATION_REQUIRED = "true";
    h.db.reset();
    seedMembers(h.db, { verified: false });
    register(readDef(), tagDef());
    const write = await proposeAction(eddy(AGENT, { emailVerified: false }), "tag_fixture", { conversationId: "cv1", tag: "vip" }, {}, testDeps());
    expect(write.model).toEqual({ status: "refused", code: "email_unverified" });
    const read = await proposeAction(eddy(AGENT, { emailVerified: false }), "get_things", {}, {}, testDeps());
    expect(read.model.status).toBe("done");
  });

  it("the paywall applies to writes only, and lowering skips it", async () => {
    register(readDef(), tagDef(), pauseDef(), resumeDef());
    const locked = () => testDeps({ workspace: fakeWorkspace({ assertCanWrite: async () => { throw new HttpError(402, "Your subscription is inactive."); } }) });
    const write = await proposeAction(eddy(), "tag_fixture", { conversationId: "cv1", tag: "vip" }, {}, locked());
    expect(write.model).toEqual({ status: "refused", code: "workspace_locked" });
    expect(write.status).toBe(402);
    expect((await proposeAction(eddy(), "get_things", {}, {}, locked())).model.status).toBe("done");
    expect((await proposeAction(eddy(ADMIN), "pause_fixture", { broadcastId: "b1" }, {}, locked())).model.status).toBe("done");
  });

  it("a v2 action while v2 is off, or while Phase 0 is not ready", async () => {
    register(v2Def());
    expect((await proposeAction(eddy(), "v2_report", {}, {}, testDeps({ phase: () => 1 }))).model).toEqual({ status: "refused", code: "not_yet" });
    expect((await proposeAction(eddy(), "v2_report", {}, {}, testDeps({ phase: () => 2 }))).model).toEqual({ status: "refused", code: "not_yet" });
    const ready = testDeps({ phase: () => 2, spendBridge: fakeBridge({ eddyAssistantReady: async () => true }) });
    expect((await proposeAction(eddy(), "v2_report", {}, {}, ready)).model.status).toBe("done");
  });

  it("a system principal may only lower activity", async () => {
    register(pauseDef(), resumeDef(), { ...tagDef(), surfaces: ["eddy", "system"] } as ActionDefinition);
    const job = systemPrincipal("actions.reconcile", T1);
    const tag = await proposeAction(job, "tag_fixture", { conversationId: "cv1", tag: "vip" }, {}, testDeps());
    expect(tag.model).toEqual({ status: "refused", code: "role", requiredRole: "agent" });
    const pause = await proposeAction(job, "pause_fixture", { broadcastId: "b1" }, {}, testDeps());
    expect(pause.model).toMatchObject({ status: "done", undoAvailable: true });
  });

  it("G8a: the demo workspace refuses calls to Meta; no number refuses with the admins' names; an expired token asks to reconnect", async () => {
    register(sendDef());
    const args = { conversationId: "cv1", text: "Hello" };
    const demo = await proposeAction(eddy(), "send_fixture", args, {}, testDeps({ spendBridge: fakeBridge({ isDemoWorkspace: async () => true }) }));
    expect(demo.model).toEqual({ status: "refused", code: "demo" });
    const none = await proposeAction(eddy(AGENT), "send_fixture", args, {}, testDeps({ workspace: fakeWorkspace({ whatsAppState: async () => "none" }) }));
    expect(none.model).toMatchObject({ code: "not_connected", who: [{ text: "Priya" }, { text: "Omar" }] });
    const adminNone = await proposeAction(eddy(ADMIN), "send_fixture", args, {}, testDeps({ workspace: fakeWorkspace({ whatsAppState: async () => "none" }) }));
    expect(adminNone.model).toEqual({ status: "refused", code: "not_connected" });
    const expired = await proposeAction(eddy(), "send_fixture", args, {}, testDeps({ workspace: fakeWorkspace({ whatsAppState: async () => "reconnect" }) }));
    expect(expired.model).toEqual({ status: "refused", code: "reconnect" });
  });

  it("G9: the route's own guard sentence reaches the model as data", async () => {
    register(tagDef({ authorize: vi.fn(async () => { throw new HttpError(403, "This conversation is assigned to someone else."); }) }));
    const out = await proposeAction(eddy(), "tag_fixture", { conversationId: "cv1", tag: "vip" }, {}, testDeps());
    expect(out.model).toEqual({ status: "failed", code: "forbidden", detail: { $untrusted: "external_text", text: "This conversation is assigned to someone else." } });
  });

  it("G19: a Phase 0 refusal keeps its own sentence and maps to the spend codes, never to workspace_locked", async () => {
    const phase0 = (code: string, status: number, message: string) => Object.assign(new HttpError(status, message), { code });
    const cases: [HttpError, string, string][] = [
      [phase0("spend.ai_quota", 402, "Today's AI limit is used up."), "spend_blocked", "spend_refused"],
      [phase0("spend.daily_cap", 409, "This would go over today's limit."), "spend_blocked", "spend_refused"],
      [phase0("spend.frozen", 409, "Spending is stopped in this workspace."), "spend_frozen", "spend_frozen"],
      [phase0("spend.demo", 409, "This is a demo workspace."), "demo", "demo"],
    ];
    for (const [error, code, state] of cases) {
      register(sendDef({ run: vi.fn(async () => { throw error; }) }));
      const deps = testDeps();
      const out = await proposeAction(eddy(AGENT, { turnId: `t_${code}_${state}_${error.status}` }), "send_fixture", { conversationId: `cv_${error.status}`, text: "Hi" }, {}, deps);
      const res = await confirmAction({ principal: eddy(), actionId: out.card!.actionId, nonce: out.card!.nonce, previewHash: out.card!.previewHash }, deps);
      expect(res, error.message).toMatchObject({ status: error.status, state, code, message: error.message });
      expect(h.db.rows("actionInvocation").at(-1)).toMatchObject({ stage: "execute", outcome: "failed", code });
      h.db.reset();
      seedMembers(h.db);
    }
    expect(spendRefusalCode(new HttpError(409, "Busy."))).toBeNull();
    expect(spendRefusalCode({ code: "spend.platform_frozen" })).toBe("spend_frozen");
    expect(spendRefusalCode({ code: "spend_bypass" })).toBeNull();
  });

  it("G12: anything that spends is refused under a freeze or without the spend bridge; the ops kill switch stops new work", async () => {
    const spend = readDef({ name: "ai_ideas", effects: { writes: false, spends: "ai" }, preview: vi.fn(async () => basePreview({ cost: { state: "unknown", reason: "not_computable" } })), untrustedPaths: [], forModel: () => ({}), piiItems: undefined, scopes: undefined });
    register(spend, readDef());
    expect((await proposeAction(eddy(), "ai_ideas", {}, {}, testDeps({ spendBridge: fakeBridge({ freezeState: async () => freeze("assistants") }) }))).model).toEqual({ status: "refused", code: "spend_frozen" });
    expect((await proposeAction(eddy(), "ai_ideas", {}, {}, testDeps({ spendBridge: UNWIRED_SPEND_BRIDGE }))).model).toEqual({ status: "refused", code: "spend_not_set_up" });
    expect((await proposeAction(eddy(), "get_things", {}, {}, testDeps({ workspace: fakeWorkspace({ eddyPlatformDisabled: async () => true }) }))).model).toEqual({ status: "refused", code: "kill_switch" });
  });

  it("G13: the per-action and shared write limits", async () => {
    register(readDef());
    const hits = new Map<string, number>();
    const limiter = (name: string, perMinute: number) => ({ consume: (key: string) => { const k = `${name}|${key}`; hits.set(k, (hits.get(k) ?? 0) + 1); return (hits.get(k) ?? 0) <= perMinute; } });
    const deps = testDeps({ limiter });
    for (let i = 0; i < 30; i++) expect((await proposeAction(eddy(), "get_things", {}, { turnId: `turn_${i}` }, deps)).model.status).toBe("done");
    expect((await proposeAction(eddy(), "get_things", {}, { turnId: "turn_x" }, deps)).model).toEqual({ status: "refused", code: "rate_limited" });
  });
});

describe("the default limiter (G13)", () => {
  it("counts each action per principal under the shared eddy-actions limiter", async () => {
    register(readDef(), adminReadDef({ surfaces: ["eddy"], minRole: "agent", name: "admin_report" }));
    const deps = testDeps({ limiter: undefined });
    for (let i = 0; i < 30; i++) expect((await proposeAction(eddy(), "get_things", {}, { turnId: `turn_${i}` }, deps)).model.status).toBe("done");
    expect((await proposeAction(eddy(), "get_things", {}, { turnId: "turn_x" }, deps)).model).toEqual({ status: "refused", code: "rate_limited" });
    // Another action, and another member, have their own windows.
    expect((await proposeAction(eddy(), "admin_report", {}, { turnId: "turn_y" }, deps)).model.status).toBe("done");
    expect((await proposeAction(eddy(ADMIN), "get_things", {}, { turnId: "turn_z" }, deps)).model.status).toBe("done");
  });
});

describe("registry load rules (4.2)", () => {
  const base = () => tagDef();
  const expectRefused = (def: ActionDefinition, pattern: RegExp) => {
    resetRegistry();
    expect(() => registerActions([def])).toThrow(RegistryLoadError);
    expect(definitionProblem(def)).toMatch(pattern);
  };

  it("refuses a static risk below what the effects derive", () => expectRefused(sendDef({ risk: "undoable" }), /below/));
  it("refuses an undoable action without undo", () => expectRefused(tagDef({ undo: undefined }), /declares no undo/));
  it("refuses a confirm-class action without preview", () => expectRefused(sendDef({ preview: undefined }), /preview/));
  it("refuses dynamic effects or automation-starting writes without preview", () => {
    expectRefused(tagDef({ preview: undefined }), /preview/);
    expectRefused(tagDef({ automationEvents: undefined, preview: undefined, effects: async () => ({ writes: true }) }), /preview/);
  });
  it("refuses a returnsSecret action on the eddy surface", () => expectRefused(readDef({ effects: { writes: false, returnsSecret: true }, preview: vi.fn() }), /secret/));
  it("refuses a v1 action that spends from messaging or ads", () => {
    expectRefused(sendDef({ effects: { writes: true, spends: "messaging" } }), /v2 only/);
    expectRefused(sendDef({ effects: { writes: true, spends: "ads" } }), /v2 only/);
    expectRefused(sendDef({ spendIntent: vi.fn() } as Partial<ActionDefinition>), /spendIntent/);
  });
  it("refuses duplicated, unsorted or invalid names", () => {
    resetRegistry();
    expect(() => registerActions([readDef(), readDef()])).toThrow(/twice/);
    resetRegistry();
    expect(() => registerActions([tagDef(), readDef()])).toThrow(/sorted/);
    resetRegistry();
    registerActions([readDef()]);
    expect(() => registerActions([readDef()])).toThrow(/twice/);
    expectRefused(readDef({ name: "Get-Things" }), /tool name/);
  });
  it("refuses schemas strict tool use cannot take, unknown editable fields, an undo on the undo action and odd undo windows", () => {
    expectRefused(readDef({ inputSchema: { type: "object", properties: {}, required: [] } }), /additionalProperties/);
    expectRefused(readDef({ inputSchema: { type: "object", properties: { a: { type: "object", properties: {}, additionalProperties: false } }, required: [], additionalProperties: false } }), /required/);
    expectRefused(sendDef({ editable: ["nope"] as never }), /editable/);
    expectRefused({ ...base(), isUndo: true } as ActionDefinition, /undo action/);
    expectRefused(tagDef({ undo: { ...tagDef().undo!, windowMs: 16 * 60_000 } }), /undo window/);
  });
  it("refuses an inverseAction that cannot show a card, or that gives no arguments for it", () => {
    resetRegistry();
    const pause = pauseDef({ undo: { ...pauseDef().undo!, inverseAction: "get_things" } });
    expect(() => registerActions(sortDefs([pause, readDef()]))).toThrow(/undoes through get_things/);
    expectRefused(pauseDef({ undo: { ...pauseDef().undo!, inverseArgs: undefined } }), /no inverseArgs/);
  });
  it("refuses undo hooks that are not functions", () => {
    expectRefused(tagDef({ undo: { ...tagDef().undo!, authorize: "yes" as never } }), /undo\.authorize/);
    expectRefused(tagDef({ undo: { ...tagDef().undo!, automationEvents: {} as never } }), /undo\.automationEvents/);
  });

  it("loads a valid set frozen and sorted, and finds definitions by name", () => {
    register(tagDef(), readDef(), sendDef());
    expect(ACTIONS.map((d) => d.name)).toEqual(["get_things", "send_fixture", "tag_fixture"]);
    expect(Object.isFrozen(ACTIONS)).toBe(true);
    expect(Object.isFrozen(actionByName("get_things"))).toBe(true);
    expect(Object.isFrozen(actionByName("get_things")!.inputSchema.properties)).toBe(true);
    expect(actionByName("missing")).toBeUndefined();
  });
});

describe("cards (G14)", () => {
  it("a confirm-class call never invokes run, returns preview_shown with no nonce in the model payload, and a deterministic previewHash", async () => {
    const def = sendDef();
    register(def);
    const args = { text: "Your order ships tomorrow.", conversationId: "cv1" };
    const out = await proposeAction(eddy(), "send_fixture", args, {}, testDeps());
    expect(def.run).not.toHaveBeenCalled();
    expect(out.model).toEqual({ status: "preview_shown", actionId: out.card!.actionId, note: PREVIEW_NOTE });
    expect(out.card!.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(out.model)).not.toContain(out.card!.nonce);
    expect(out.card!.previewHash).toBe(previewHash(out.card!.preview));
    const record = h.db.rows("actionRecord")[0];
    expect(record).toMatchObject({ status: "pending", risk: "confirm", previewHash: out.card!.previewHash });
    expect(record.nonceHash).not.toBe(out.card!.nonce);
    expect(JSON.stringify(record)).not.toContain(out.card!.nonce);
    expect((record.expiresAt as Date).getTime() - (record.createdAt as Date).getTime()).toBeGreaterThan(14 * 60_000);

    // Same arguments in another order (and in another conversation's card) give the same preview hash.
    const again = await proposeAction(eddy(AGENT, { turnId: "turn2" }), "send_fixture", { conversationId: "cv1", text: "Your order ships tomorrow." }, {}, testDeps());
    expect(again.card!.previewHash).toBe(out.card!.previewHash);
    expect(again.card!.nonce).not.toBe(out.card!.nonce);
    expect(def.run).not.toHaveBeenCalled();
  });
});

describe("who a call is about, for contact erasure (7.6)", () => {
  it("subjectIdsIn finds contact and chat ids at any depth, and ids under contact(s) / conversation(s) keys", () => {
    expect(
      subjectIdsIn(
        { conversationId: "cv1", text: "hi" },
        { conversation: { id: "cv2", contact: { id: "k2", name: "Priya" } }, items: [{ id: "x", contact: { id: "k3" } }], contactIds: ["k4", "bad id"] },
        { chats: [{ id: "cv3" }], contacts: [{ id: "k5" }], nested: { deeper: { contactId: "k6" } } },
        null,
        "text",
      ),
    ).toEqual({ contactIds: ["k2", "k3", "k4", "k5", "k6"], conversationIds: ["cv1", "cv2", "cv3"] });
  });

  it("a read's outcome names the contacts its result showed, so Eddy can tag the stored tool_result", async () => {
    register(readDef());
    const out = await proposeAction(eddy(), "get_things", {}, {}, testDeps());
    expect(out.model.status).toBe("done");
    // get_things is a contacts list: its items are contacts.
    expect(out.subjects).toEqual({ contactIds: ["k1"], conversationIds: [] });
  });

  it("a reply card names only the chat, yet its record is tagged with that chat's contact", async () => {
    register(sendDef());
    h.db.insert("conversation", { id: "cv1", tenantId: T1, contactId: "k_priya" });
    const out = await proposeAction(eddy(), "send_fixture", { conversationId: "cv1", text: "Your order ships tomorrow." }, {}, testDeps());
    expect(out.model.status).toBe("preview_shown");
    expect(out.subjects).toEqual({ contactIds: ["k_priya"], conversationIds: ["cv1"] });
    expect(h.db.rows("actionRecord")[0].contactIds).toEqual(["k_priya"]);
  });

  it("an undoable write's record is tagged with the contact its result names", async () => {
    register(tagDef({ run: vi.fn(async (_ctx: unknown, a: { conversationId: string; tag: string }) => ({ result: { conversationId: a.conversationId, contact: { id: "k_ravi" }, tags: [a.tag] }, undo: { kind: "tags", target: a.conversationId, before: [], after: [a.tag] }, auditTarget: a.conversationId })) }));
    const out = await proposeAction(eddy(), "tag_fixture", { conversationId: "cv1", tag: "vip" }, {}, testDeps());
    expect(out.model.status).toBe("done");
    expect(out.subjects).toEqual({ contactIds: ["k_ravi"], conversationIds: ["cv1"] });
    expect(h.db.rows("actionRecord").at(-1)!.contactIds).toEqual(["k_ravi"]);
  });
});

describe("audit and ActionInvocation (G17)", () => {
  it("an undoable write calls audit and writes started + ok with one opId; a read writes one read row", async () => {
    register(readDef(), tagDef());
    const deps = testDeps();
    const out = await proposeAction(eddy(), "tag_fixture", { conversationId: "cv1", tag: "vip" }, {}, deps);
    expect(out.model).toMatchObject({ status: "done", undoAvailable: true });
    expect(deps.audit.audit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: T1, userId: AGENT.userId, action: "eddy.tag_fixture", target: "cv1", meta: expect.objectContaining({ via: "eddy", principalId: "eddy:u_agent:cv_eddy", turnId: "turn1", actionId: out.actionId }) }));
    expect(deps.audit.auditStrict).not.toHaveBeenCalled();
    const rows = h.db.rows("actionInvocation");
    expect(rows.map((r) => [r.stage, r.outcome])).toEqual([["execute", "started"], ["execute", "ok"]]);
    expect(rows[0].opId).toBe(rows[1].opId);
    expect(rows[1].argsRedacted).toEqual({ conversationId: "cv1", tag: { len: 3 } });
    expect(h.db.rows("actionRecord")[0]).toMatchObject({ status: "done", risk: "undoable", undoUntil: expect.any(Date) });

    await proposeAction(eddy(), "get_things", {}, {}, deps);
    expect(h.db.rows("actionInvocation").slice(2).map((r) => [r.stage, r.outcome, r.piiItems])).toEqual([["read", "ok", 1]]);
  });

  it("a write that messages customers runs auditStrict before run, and nothing runs when that insert fails", async () => {
    const def = sendDef();
    register(def);
    const deps = testDeps();
    const out = await proposeAction(eddy(), "send_fixture", { conversationId: "cv1", text: "Hi" }, {}, deps);
    const confirmed = await confirmAction({ principal: eddy(), actionId: out.card!.actionId, nonce: out.card!.nonce, previewHash: out.card!.previewHash }, deps);
    expect(confirmed.state).toBe("done");
    expect(deps.audit.auditStrict).toHaveBeenCalledWith(expect.objectContaining({ action: "eddy.send_fixture", meta: expect.objectContaining({ stage: "requested", confirmedBy: AGENT.userId }) }));
    expect(deps.audit.auditOutcome).toHaveBeenCalledWith(expect.objectContaining({ action: "eddy.send_fixture", meta: expect.objectContaining({ stage: "done" }) }));

    const failing = testDeps({ audit: { ...fakeAudit(), auditStrict: vi.fn(async () => { throw new HttpError(500, "The audit log could not be written, so nothing was changed. Try again."); }) } });
    const second = await proposeAction(eddy(AGENT, { turnId: "t2" }), "send_fixture", { conversationId: "cv2", text: "Hi" }, {}, failing);
    const res = await confirmAction({ principal: eddy(), actionId: second.card!.actionId, nonce: second.card!.nonce, previewHash: second.card!.previewHash }, failing);
    expect(res).toMatchObject({ status: 500, state: "failed", code: "internal" });
    expect(def.run).toHaveBeenCalledTimes(1);
  });

  it("every refusal writes a refuse row", async () => {
    register(adminReadDef());
    await proposeAction(eddy(AGENT), "admin_report", {}, {}, testDeps());
    expect(h.db.rows("actionInvocation")).toEqual([expect.objectContaining({ stage: "refuse", outcome: "refused", code: "role", action: "admin_report", principalId: "eddy:u_agent:cv_eddy" })]);
  });
});

describe("writes that start automations (4.2a)", () => {
  const rule = (actions: unknown[], trigger: unknown = { type: "tag_added", tag: "vip" }, filters: unknown = undefined) => ({
    id: `r${h.db.rows("automationRule").length + 1}`,
    tenantId: T1,
    name: "VIP offer",
    enabled: true,
    version: 2,
    priority: 0,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-20T00:00:00Z"),
    trigger,
    filters: filters ?? { root: { type: "group", op: "and", items: [] }, options: { allowWhenHumanActive: false } },
    actions,
  });
  const deps = () => testDeps({ automation: PRISMA_AUTOMATION });
  beforeEach(() => {
    h.db.insert("contact", { id: "k1", tenantId: T1, tags: [], attributes: {}, phone: "+919876543210" });
    h.db.insert("conversation", { id: "cv1", tenantId: T1, tags: [], assignedToId: null });
  });

  it("no matching rule: runs at once with Undo", async () => {
    register(tagDef());
    h.db.insert("automationRule", rule([{ type: "send_text", text: "Thanks!" }], { type: "tag_added", tag: "other" }));
    expect((await proposeAction(eddy(), "tag_fixture", { conversationId: "cv1", tag: "vip" }, {}, deps())).model).toMatchObject({ status: "done", undoAvailable: true });
  });

  it("a rule that sends free text turns the write into a card with triggers_automation", async () => {
    const def = tagDef();
    register(def);
    h.db.insert("automationRule", rule([{ type: "send_text", text: "Thanks for being VIP!" }]));
    const out = await proposeAction(eddy(), "tag_fixture", { conversationId: "cv1", tag: "vip" }, {}, deps());
    expect(out.model.status).toBe("preview_shown");
    expect(def.run).not.toHaveBeenCalled();
    expect(out.card!.preview.warnings).toContain("triggers_automation");
    expect(out.card!.preview.facts).toContainEqual({ labelKey: "card.fact.automation.text", value: { $untrusted: "workspace_text", text: "VIP offer" } });
    expect(out.card!.preview.material).toMatchObject({ targetId: "cv1", "rule:r1": "2026-10-20T00:00:00.000Z" });
  });

  it("a rule that sends a template, starts the AI agent, a lead sequence, or a bot that sends templates or uses AI is refused in v1", async () => {
    register(tagDef());
    const cases: unknown[][] = [
      [{ type: "send_template", templateId: "tp1", variables: [] }],
      [{ type: "start_lead_sequence", sequenceId: "s1" }],
      [{ type: "start_chatbot", chatbotId: "bot_tpl" }],
      [{ type: "start_chatbot", chatbotId: "bot_ai" }],
      [{ type: "send_material", materialId: "mat_tpl" }],
    ];
    h.db.insert("chatbot", { id: "bot_tpl", tenantId: T1, flow: { nodes: [{ id: "n1", type: "send_template" }] }, publishedFlow: null });
    h.db.insert("chatbot", { id: "bot_ai", tenantId: T1, flow: { nodes: [{ id: "n1", type: "send_text" }], settings: { escalation: { enabled: true, useAi: true } } }, publishedFlow: null });
    h.db.insert("replyMaterial", { id: "mat_tpl", tenantId: T1, kind: "template" });
    for (const actions of cases) {
      h.db.tables.automationRule = [];
      h.db.insert("automationRule", rule(actions));
      const out = await proposeAction(eddy(), "tag_fixture", { conversationId: "cv1", tag: "vip" }, { turnId: `turn_${JSON.stringify(actions)}` }, deps());
      expect(out.model, JSON.stringify(actions)).toEqual({ status: "refused", code: "triggers_paid_rule" });
    }
    // The AI agent can only start from a message, so a tag rule cannot use it; a bot that only sends text is a free card.
    h.db.tables.automationRule = [];
    h.db.insert("chatbot", { id: "bot_text", tenantId: T1, flow: { nodes: [{ id: "n1", type: "send_text" }] }, publishedFlow: null });
    h.db.insert("automationRule", rule([{ type: "start_chatbot", chatbotId: "bot_text" }]));
    expect((await proposeAction(eddy(), "tag_fixture", { conversationId: "cv1", tag: "vip" }, { turnId: "turn_bot_text" }, deps())).model.status).toBe("preview_shown");
  });

  it("filters are honoured: a failing condition is no match, a segment condition counts as a match", async () => {
    register(tagDef());
    const tagIs = (tag: string, has: boolean) => ({ root: { type: "group", op: "and", items: [{ type: "tag", tag, has }] }, options: { allowWhenHumanActive: false } });
    h.db.insert("automationRule", rule([{ type: "send_template", templateId: "tp1", variables: [] }], { type: "tag_added", tag: "vip" }, tagIs("blocked-customer", true)));
    expect((await proposeAction(eddy(), "tag_fixture", { conversationId: "cv1", tag: "vip" }, {}, deps())).model.status).toBe("done");
    h.db.tables.automationRule = [];
    h.db.insert("automationRule", rule([{ type: "send_template", templateId: "tp1", variables: [] }], { type: "tag_added", tag: "vip" }, tagIs("vip", true)));
    expect((await proposeAction(eddy(), "tag_fixture", { conversationId: "cv1", tag: "vip" }, { turnId: "t3" }, deps())).model).toEqual({ status: "refused", code: "triggers_paid_rule" });
    h.db.tables.automationRule = [];
    h.db.insert("automationRule", rule([{ type: "send_text", text: "x" }], { type: "tag_added", tag: null }, { root: { type: "group", op: "and", items: [{ type: "segment", segmentId: "sg1", member: true }] }, options: { allowWhenHumanActive: false } }));
    expect((await proposeAction(eddy(), "tag_fixture", { conversationId: "cv1", tag: "vip" }, { turnId: "t4" }, deps())).model.status).toBe("preview_shown");
  });

  it("checkAutomation sends nothing and only reads enabled v2 rules", async () => {
    const port = fakeAutomation([]);
    const out = await checkAutomation(T1, [{ type: "tag_added", tenantId: T1, contactId: "k1", tags: ["vip"] }], port);
    expect(out).toEqual({ matches: [], spends: "none" });
    expect(await checkAutomation(T1, [], port)).toEqual({ matches: [], spends: "none" });
    expect(port.enabledRules).toHaveBeenCalledTimes(1);
    expect(h.db.rows("job")).toEqual([]);
  });
});

describe("principals (G4)", () => {
  it("re-reads the membership: a disabled user, a deleted workspace or a removed member is refused", async () => {
    register(readDef());
    const member = h.db.rows("membership").find((r) => r.userId === AGENT.userId)!;
    (member.user as { disabledAt: Date | null }).disabledAt = new Date();
    expect((await proposeAction(eddy(), "get_things", {}, {}, testDeps())).model).toEqual({ status: "refused", code: "role_changed" });
    (member.user as { disabledAt: Date | null }).disabledAt = null;
    (member.tenant as { deletedAt: Date | null }).deletedAt = new Date();
    clearPrincipalMemo();
    expect((await proposeAction(eddy(), "get_things", {}, { turnId: "t_del" }, testDeps())).model).toEqual({ status: "refused", code: "role_changed" });
    h.db.tables.membership = h.db.rows("membership").filter((r) => r.userId !== AGENT.userId);
    expect((await proposeAction(eddy(), "get_things", {}, { turnId: "t_gone" }, testDeps())).model).toEqual({ status: "refused", code: "role_changed" });
  });

  it("reads reuse a refresh for 5 seconds within a turn; writes always read fresh", async () => {
    register(readDef(), tagDef());
    const membership = h.db.prisma.membership as { findUnique: (...a: unknown[]) => Promise<unknown> };
    const spy = vi.spyOn(membership, "findUnique");
    const at = new Date("2026-10-28T10:00:00Z");
    const deps = testDeps({ clock: () => at });
    await proposeAction(eddy(), "get_things", {}, {}, deps);
    await proposeAction(eddy(), "get_things", {}, {}, deps);
    expect(spy).toHaveBeenCalledTimes(1);
    await proposeAction(eddy(), "tag_fixture", { conversationId: "cv1", tag: "vip" }, {}, deps);
    await proposeAction(eddy(), "tag_fixture", { conversationId: "cv1", tag: "new" }, {}, deps);
    expect(spy).toHaveBeenCalledTimes(3);
    await proposeAction(eddy(), "get_things", {}, {}, testDeps({ clock: () => new Date(at.getTime() + 5_000) }));
    expect(spy).toHaveBeenCalledTimes(4);
    spy.mockRestore();
  });

  it("checks that the session is still live, and that an API key is not revoked", async () => {
    register(readDef(), tagDef());
    const withSession = eddyPrincipal({ actor: AGENT, emailVerified: true, conversationId: "cv_eddy", lang: "en", sessionRef: "sid_1" });
    expect((await proposeAction(withSession, "tag_fixture", { conversationId: "cv1", tag: "vip" }, {}, testDeps())).model).toEqual({ status: "refused", code: "signed_out" });
    h.db.insert("session", { id: "s1", userId: AGENT.userId, refreshTokenHash: "sid_1", revokedAt: null, expiresAt: new Date(Date.now() + 3_600_000) });
    expect((await proposeAction(withSession, "tag_fixture", { conversationId: "cv1", tag: "vip" }, {}, testDeps())).model.status).toBe("done");
    h.db.insert("apiKey", { id: "k_rev", tenantId: T1, revokedAt: new Date() });
    const key = keyPrincipal({ via: "mcp", keyId: "k_rev", actor: AGENT, scopes: ["contacts:read"] });
    expect((await proposeAction(key, "get_things", {}, {}, testDeps())).model).toEqual({ status: "refused", code: "signed_out" });
  });

  it("uses the fresh role, not the one the caller carried", async () => {
    register(adminReadDef());
    expect((await proposeAction(eddy(ADMIN), "admin_report", {}, {}, testDeps())).model.status).toBe("done");
    const { setRole } = await import("./helpers/action-fixtures");
    setRole(h.db, ADMIN.userId, "agent");
    expect((await proposeAction(eddy(ADMIN), "admin_report", {}, { turnId: "t_new" }, testDeps())).model).toMatchObject({ status: "refused", code: "role" });
  });
});

describe("projection (G20)", () => {
  it("the per-turn PII budget is 200 records: a read past it is refused, a write past it reports done without the records", async () => {
    let n = 150;
    register(readDef({ piiItems: () => n }), tagDef({ piiItems: () => 100 }));
    const deps = testDeps();
    expect((await proposeAction(eddy(), "get_things", {}, { turnId: "tp" }, deps)).model.status).toBe("done");
    n = 60;
    expect((await proposeAction(eddy(), "get_things", {}, { turnId: "tp" }, deps)).model).toEqual({ status: "refused", code: "pii_budget" });
    n = 50;
    expect((await proposeAction(eddy(), "get_things", {}, { turnId: "tp" }, deps)).model.status).toBe("done");
    const write = await proposeAction(eddy(), "tag_fixture", { conversationId: "cv1", tag: "vip" }, { turnId: "tp" }, deps);
    expect(write.model).toEqual({ status: "done", result: { omitted: "pii_budget", note: expect.any(String) }, undoAvailable: true });
    expect((await proposeAction(eddy(), "get_things", {}, { turnId: "another" }, deps)).model.status).toBe("done");
  });

  it("customer text in the result reaches the model only as UntrustedText; a definition that forgets the wrapper fails in tests, after its write is recorded", async () => {
    register(readDef());
    const out = await proposeAction(eddy(), "get_things", {}, {}, testDeps());
    expect(out.model).toEqual({ status: "done", result: { items: [{ id: "k1", name: { $untrusted: "contact_name", text: "Ramesh" } }] }, undoAvailable: false });

    register(tagDef({ untrustedPaths: ["tags"] }));
    await expect(proposeAction(eddy(), "tag_fixture", { conversationId: "cv1", tag: "vip" }, {}, testDeps())).rejects.toThrow(/UntrustedText/);
    expect(h.db.rows("actionRecord")).toEqual([expect.objectContaining({ action: "tag_fixture", status: "done" })]);
    const relaxed = await proposeAction(eddy(), "tag_fixture", { conversationId: "cv2", tag: "vip" }, { turnId: "t_prod" }, testDeps({ strictUntrusted: false }));
    expect(relaxed.model).toMatchObject({ status: "done", result: { tags: [{ $untrusted: "external_text", text: "vip" }] } });
  });
});

describe("helpers", () => {
  it("concretePath fills the route's ids from the arguments, as getActor would see the request", () => {
    expect(concretePath(tagDef(), { conversationId: "cv1", tag: "vip" })).toBe("/api/inbox/conversations/cv1/tags");
    expect(concretePath(pauseDef(), { broadcastId: "b9" })).toBe("/api/broadcasts/b9/pause");
    expect(concretePath(tagDef(), {})).toBe("/api/inbox/conversations/_/tags");
    expect(concretePath(readDef({ route: "virtual" }), {})).toBe("/api/actions/virtual/get_things");
  });

  it("roleClassOf: owners and admins share the admin set", () => {
    expect([roleClassOf("agent"), roleClassOf("admin"), roleClassOf("owner")]).toEqual(["agent", "admin", "admin"]);
    expect(OWNER.role).toBe("owner");
  });
});

describe("model toolsets (4.9)", () => {
  const named = (name: string, over: Partial<ActionDefinition> = {}) => readDef({ name, untrustedPaths: [], forModel: () => ({}), piiItems: undefined, ...over });
  const fixtureSet = () =>
    sortDefs([
      named("add_internal_note"),
      named("create_template_draft", { minRole: "admin" }),
      named("draft_reply"),
      named("send_text_reply"),
      named("list_team"),
      named("delete_template", { minRole: "admin" }),
      named("owner_only", { minRole: "owner" }),
      named("future_tool", { version: "v2" }),
      named("mcp_only", { surfaces: ["mcp"] }),
      named("search_contacts", {
        inputSchema: {
          type: "object",
          properties: { q: { type: "string", description: "Name or last digits.", minLength: 1, maxLength: 60 }, limit: { type: "integer", minimum: 1, maximum: 25 }, tags: { type: "array", maxItems: 10, items: { type: "string", pattern: "^[a-z]+$" } } },
          required: ["q"],
          additionalProperties: false,
        },
      }),
    ]);

  it("is sorted, strict, role-filtered, and moves unsupported constraints into descriptions", () => {
    const agent = toolsFor("agent", "eddy", { phase: 1, defs: fixtureSet() });
    expect(agent.map((t) => t.name)).toEqual(["add_internal_note", "draft_reply", "list_team", "search_contacts", "send_text_reply"]);
    const admin = toolsFor("admin", "eddy", { phase: 1, defs: fixtureSet() });
    expect(admin.map((t) => t.name)).toEqual(["add_internal_note", "create_template_draft", "delete_template", "draft_reply", "list_team", "search_contacts", "send_text_reply"]);
    expect(toolsFor("admin", "eddy", { phase: 2, defs: fixtureSet() }).map((t) => t.name)).toContain("future_tool");
    for (const tool of admin) expect(tool.strict).toBe(true);
    const search = admin.find((t) => t.name === "search_contacts")!;
    expect(search.input_schema).toEqual({
      type: "object",
      properties: {
        q: { type: "string", description: "Name or last digits. (1 to 60 characters)" },
        limit: { type: "integer", description: "(1 to 25)" },
        tags: { type: "array", description: "(at most 10 items)", items: { type: "string", description: "(must match ^[a-z]+$)" } },
      },
      required: ["q"],
      additionalProperties: false,
    });
    expect(JSON.stringify(admin)).not.toMatch(/"(minLength|maxLength|minimum|maximum|maxItems|pattern)"/);
  });

  it("sets eager_input_streaming only on the four long-text tools", () => {
    const admin = toolsFor("admin", "eddy", { phase: 1, defs: fixtureSet() });
    expect(admin.filter((t) => t.eager_input_streaming).map((t) => t.name)).toEqual(["add_internal_note", "create_template_draft", "draft_reply", "send_text_reply"]);
    expect([...EAGER_INPUT_TOOLS].sort()).toEqual(["add_internal_note", "create_template_draft", "draft_reply", "send_text_reply"]);
  });

  it("is byte-identical for every tenant and call (hash snapshot), and TOOLSET_VERSION follows the registry", () => {
    resetRegistry();
    registerActions(fixtureSet());
    const first = JSON.stringify(toolsFor("agent", "eddy", { phase: 1 }));
    // Two members of different workspaces get the same bytes: nothing tenant-specific goes in.
    clearPrincipalMemo();
    const second = JSON.stringify(toolsFor("agent", "eddy", { phase: 1 }));
    expect(second).toBe(first);
    expect(toolsFor("agent", "eddy", { phase: 1 })).toBe(toolsFor("agent", "eddy", { phase: 1 }));
    expect(Object.isFrozen(toolsFor("agent", "eddy", { phase: 1 })[0].input_schema)).toBe(true);
    expect(toolsetHash(toolsFor("agent", "eddy", { phase: 1 }))).toBe(toolsetHash(toolsFor("agent", "eddy", { phase: 1, defs: fixtureSet() })));
    expect(toolsetHash(toolsFor("agent", "eddy", { phase: 1, defs: fixtureSet() }))).toBe("dcfc1393332e4b919aab3ccb6b8d141991cec96bd4f35c5ebb9dadc668c03a3e");

    const before = toolsetVersion({ phase: 1 });
    expect(TOOLSET_VERSION).toBe(before);
    expect(before).toMatch(/^ts_[0-9a-f]{24}$/);
    const changed = fixtureSet().map((d) => (d.name === "list_team" ? { ...d, description: "Lists the team, with roles." } : d));
    expect(toolsetVersion({ phase: 1, defs: changed })).not.toBe(before);
    resetRegistry();
    registerActions(changed);
    expect(TOOLSET_VERSION).not.toBe(before);
  });
});

describe("bypass rule B14 (Phase 0 4.12, Eddy E8)", () => {
  it("no file in src/lib/actions except invoke.ts names origin 'human' or builds a user SpendActor", () => {
    const dir = path.join(ROOT, "src/lib/actions");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(8);
    const origin = /origin:\s*['"]human['"]/;
    const userActor = /\{\s*type:\s*['"]user['"]/;
    for (const file of files) {
      const rel = path.relative(ROOT, file).replace(/\\/g, "/");
      if (rel === "src/lib/actions/invoke.ts") continue;
      const text = readFileSync(file, "utf8");
      expect(origin.test(text), rel).toBe(false);
      expect(userActor.test(text), rel).toBe(false);
    }
    const invoke = readFileSync(path.join(dir, "invoke.ts"), "utf8");
    expect(invoke.match(/\{\s*type:\s*"user"/g)?.length).toBe(1);
    expect(invoke).toContain('reasonCodes: ["via_eddy"]');
    expect(invoke).not.toMatch(/from "@\/lib\/spend\//);
  });

  it("only invoke.ts calls a definition's run()", () => {
    const dir = path.join(ROOT, "src/lib/actions");
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts") || name === "invoke.ts") continue;
      expect(/\bdef\.run\(|\.run\(\s*\{\s*p\b/.test(readFileSync(path.join(dir, name), "utf8")), name).toBe(false);
    }
  });
});
