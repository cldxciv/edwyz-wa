import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeActionsDb } from "./helpers/fake-actions-db";

/**
 * docs/EDDY-SPEC.md 4.5, 8.4, 9.1 `actions-pending` (on the fake database; tests/db/actions-pending.test.ts repeats the
 * claim on Postgres): one run for two concurrent confirms, 404 / 410 / 409, demotion, unknown outcomes, undo windows,
 * spending inverses as cards, revise and refresh with no model call, card limits.
 */
const h = vi.hoisted(() => ({ db: null as unknown as FakeActionsDb }));
vi.mock("@/lib/db", async () => {
  const { createFakeActionsDb } = await import("./helpers/fake-actions-db");
  h.db = createFakeActionsDb();
  return { prisma: h.db.prisma };
});
// Nothing on these paths may reach the model: importing the SDK would fail the file.
vi.mock("@anthropic-ai/sdk", () => {
  throw new Error("The action layer must never load the model SDK.");
});

import { cancelAction, confirmAction, proposeAction, refreshAction, resetInvokeState, reviseAction, undoAction, undoLastAction, RECONCILE_QUEUE } from "@/lib/actions/invoke";
import { clearPrincipalMemo, eddyPrincipal } from "@/lib/actions/principal";
import { registerActions, resetRegistry, type ActionDefinition } from "@/lib/actions/registry";
import { compareMaterial } from "@/lib/actions/invoke";
import { ADMIN, AGENT, OWNER, T1, basePreview, fakeBridge, pauseDef, resumeDef, seedMembers, sendDef, setRole, sortDefs, tagDef, testDeps } from "./helpers/action-fixtures";

const eddy = (actor: { userId: string; tenantId: string; role: "agent" | "admin" | "owner" } = AGENT, conversationId = "cv_eddy", turnId: string | undefined = "turn1") =>
  eddyPrincipal({ actor, emailVerified: true, conversationId, lang: "en", ...(turnId ? { turnId } : {}) });

let clock = new Date("2026-10-28T10:00:00Z");
const deps = (over: Parameters<typeof testDeps>[0] = {}) => testDeps({ clock: () => clock, ...over });

function register(...defs: ActionDefinition[]) {
  resetRegistry();
  registerActions(sortDefs(defs));
}

async function card(def = "send_fixture", args: Record<string, unknown> = { conversationId: "cv1", text: "Your order ships tomorrow." }, principal = eddy(), d = deps()) {
  const out = await proposeAction(principal, def, args, {}, d);
  if (!out.card) throw new Error(`no card: ${JSON.stringify(out.model)}`);
  return out.card;
}

const record = (id: string) => h.db.rows("actionRecord").find((r) => r.id === id)!;

beforeEach(() => {
  h.db.reset();
  seedMembers(h.db);
  resetRegistry();
  resetInvokeState();
  clearPrincipalMemo();
  clock = new Date("2026-10-28T10:00:00Z");
});

describe("confirm", () => {
  it("two concurrent confirms with one nonce run the action exactly once", async () => {
    const def = sendDef();
    register(def);
    const c = await card();
    const input = { principal: eddy(), actionId: c.actionId, nonce: c.nonce, previewHash: c.previewHash };
    const [a, b] = await Promise.all([confirmAction(input, deps()), confirmAction(input, deps())]);
    expect(def.run).toHaveBeenCalledTimes(1);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find((r) => r.status === 409)).toMatchObject({ code: "already_decided" });
    expect(record(c.actionId)).toMatchObject({ status: "done", decidedAt: expect.any(Date) });
    // The idempotency key is the card's id.
    expect((def.run as ReturnType<typeof vi.fn>).mock.calls[0][2]).toMatchObject({ idempotencyKey: c.actionId });
  });

  it("a wrong nonce, user, tenant or previewHash is 404 and runs nothing", async () => {
    const def = sendDef();
    register(def);
    const c = await card();
    const ok = { principal: eddy(), actionId: c.actionId, nonce: c.nonce, previewHash: c.previewHash };
    expect(await confirmAction({ ...ok, nonce: "x".repeat(43) }, deps())).toMatchObject({ status: 404, code: "not_found" });
    expect(await confirmAction({ ...ok, principal: eddy(ADMIN) }, deps())).toMatchObject({ status: 404 });
    expect(await confirmAction({ ...ok, principal: eddy({ ...AGENT, tenantId: "t_other" }) }, deps())).toMatchObject({ status: 404 });
    expect(await confirmAction({ ...ok, previewHash: "0".repeat(64) }, deps())).toMatchObject({ status: 404 });
    expect(await confirmAction({ ...ok, actionId: "ar_missing" }, deps())).toMatchObject({ status: 404 });
    expect(def.run).not.toHaveBeenCalled();
    expect(record(c.actionId).status).toBe("pending");
    expect((await confirmAction(ok, deps())).status).toBe(200);
  });

  it("an expired card is 410 and is marked expired", async () => {
    const def = sendDef();
    register(def);
    const c = await card();
    clock = new Date(clock.getTime() + 15 * 60_000 + 1);
    expect(await confirmAction({ principal: eddy(), actionId: c.actionId, nonce: c.nonce, previewHash: c.previewHash }, deps())).toMatchObject({ status: 410, state: "expired", code: "expired" });
    expect(record(c.actionId).status).toBe("expired");
    expect(def.run).not.toHaveBeenCalled();
  });

  it("a change in the material gives 409 with a new card; the new card confirms", async () => {
    let count = 120;
    const def = resumeDef({ preview: vi.fn(async () => basePreview({ titleKey: "card.resume", material: { targetId: "b1", count } })) });
    register(def);
    const c = await card("resume_fixture", { broadcastId: "b1" }, eddy(ADMIN));
    count = 140;
    const changed = await confirmAction({ principal: eddy(ADMIN), actionId: c.actionId, nonce: c.nonce, previewHash: c.previewHash }, deps());
    expect(changed).toMatchObject({ status: 409, state: "changed", code: "changed" });
    expect(changed.card!.supersedes).toBe(c.actionId);
    expect(changed.card!.preview.material).toEqual({ targetId: "b1", count: 140 });
    expect(record(c.actionId)).toMatchObject({ status: "superseded", supersededById: changed.card!.actionId });
    expect(def.run).not.toHaveBeenCalled();
    const ok = await confirmAction({ principal: eddy(ADMIN), actionId: changed.card!.actionId, nonce: changed.card!.nonce, previewHash: changed.card!.previewHash }, deps());
    expect(ok).toMatchObject({ status: 200, state: "done" });
    expect(def.run).toHaveBeenCalledTimes(1);
  });

  it("a cost more than 0.5% higher is a change; a lower cost proceeds with a note", () => {
    expect(compareMaterial({ costMinor: "10000" }, { costMinor: "10050" })).toEqual({ changed: false, lower: false });
    expect(compareMaterial({ costMinor: "10000" }, { costMinor: "10051" })).toEqual({ changed: true, lower: false });
    expect(compareMaterial({ costMinor: "10000" }, { costMinor: "9000" })).toEqual({ changed: false, lower: true });
    expect(compareMaterial({ costMinor: "0" }, { costMinor: "1" })).toEqual({ changed: true, lower: false });
    expect(compareMaterial({ count: 3 }, { count: 3, "rule:r1": "2026-10-28" })).toEqual({ changed: true, lower: false });
    expect(compareMaterial({ count: 3 }, { count: "3" })).toEqual({ changed: false, lower: false });
  });

  it("a lower cost confirms with the cost_lower note", async () => {
    let cost = "45500";
    register(resumeDef({ preview: vi.fn(async () => basePreview({ material: { targetId: "b1", costMinor: cost } })) }));
    const c = await card("resume_fixture", { broadcastId: "b1" }, eddy(ADMIN));
    cost = "40000";
    expect(await confirmAction({ principal: eddy(ADMIN), actionId: c.actionId, nonce: c.nonce, previewHash: c.previewHash }, deps())).toMatchObject({ status: 200, state: "done", note: "cost_lower" });
  });

  it("a member demoted since the preview is refused with 403", async () => {
    const def = resumeDef();
    register(def);
    const c = await card("resume_fixture", { broadcastId: "b1" }, eddy(ADMIN));
    setRole(h.db, ADMIN.userId, "agent");
    const res = await confirmAction({ principal: eddy(ADMIN), actionId: c.actionId, nonce: c.nonce, previewHash: c.previewHash }, deps());
    expect(res).toMatchObject({ status: 403, code: "role" });
    expect(record(c.actionId)).toMatchObject({ status: "refused", error: "role" });
    expect(def.run).not.toHaveBeenCalled();
  });

  it("a demotion below the conversation's starting role closes that conversation (403 role_changed)", async () => {
    register(sendDef());
    h.db.insert("eddyConversation", { id: "cv_eddy", tenantId: T1, userId: ADMIN.userId, roleAtStart: "admin", status: "active" });
    const c = await card("send_fixture", { conversationId: "cv1", text: "Hi" }, eddy(ADMIN));
    setRole(h.db, ADMIN.userId, "agent");
    const res = await confirmAction({ principal: eddy(ADMIN), actionId: c.actionId, nonce: c.nonce, previewHash: c.previewHash }, deps());
    expect(res).toMatchObject({ status: 403, code: "role_changed" });
    expect(h.db.rows("eddyConversation")[0]).toMatchObject({ status: "closed", closedReason: "role_changed" });
  });

  it("an ambiguous error gives unknown: never retried, and a reconcile job is queued", async () => {
    const def = sendDef({ run: vi.fn(async () => { throw Object.assign(new Error("socket hang up"), { name: "GraphError", status: 503, ambiguous: true }); }) });
    register(def);
    const c = await card();
    const d = deps();
    const res = await confirmAction({ principal: eddy(), actionId: c.actionId, nonce: c.nonce, previewHash: c.previewHash }, d);
    expect(res).toMatchObject({ status: 202, state: "unknown", code: "outcome_unknown" });
    expect(def.run).toHaveBeenCalledTimes(1);
    expect(record(c.actionId).status).toBe("unknown");
    expect(d.enqueue).toHaveBeenCalledWith(RECONCILE_QUEUE, { tenantId: T1, actionRecordId: c.actionId, action: "send_fixture" });
    expect(await confirmAction({ principal: eddy(), actionId: c.actionId, nonce: c.nonce, previewHash: c.previewHash }, d)).toMatchObject({ status: 409, code: "already_decided" });
    expect(def.run).toHaveBeenCalledTimes(1);
    expect(h.db.rows("actionInvocation").filter((r) => r.stage === "execute").map((r) => r.outcome)).toEqual(["started", "unknown"]);
  });

  it("a route refusal (HttpError below 500) is failed with the route's sentence; anything else is internal", async () => {
    const { HttpError } = await import("@/lib/tenancy");
    register(sendDef({ run: vi.fn(async () => { throw new HttpError(422, "This contact has opted out of messages."); }) }));
    const c = await card();
    expect(await confirmAction({ principal: eddy(), actionId: c.actionId, nonce: c.nonce, previewHash: c.previewHash }, deps())).toMatchObject({ status: 422, state: "failed", message: "This contact has opted out of messages." });
    expect(record(c.actionId)).toMatchObject({ status: "failed", error: "This contact has opted out of messages." });
    register(sendDef({ run: vi.fn(async () => { throw new TypeError("boom"); }) }));
    const c2 = await card("send_fixture", { conversationId: "cv2", text: "Hi" }, eddy(AGENT, "cv_eddy", "turn2"));
    expect(await confirmAction({ principal: eddy(), actionId: c2.actionId, nonce: c2.nonce, previewHash: c2.previewHash }, deps())).toMatchObject({ status: 500, code: "internal" });
  });

  it("v2 bulk spending needs the owner or a named approver; the card stays open to hand over", async () => {
    const def = resumeDef({ name: "start_bulk", version: "v2", effects: { writes: true, messagesCustomers: true, spends: "messaging", bulk: true } });
    register(def);
    const d = deps({ phase: () => 2, spendBridge: fakeBridge({ eddyAssistantReady: async () => true, isApprover: async () => false, approverNames: async () => ["Omar"] }) });
    const c = await card("start_bulk", { broadcastId: "b1" }, eddy(ADMIN), d);
    const res = await confirmAction({ principal: eddy(ADMIN), actionId: c.actionId, nonce: c.nonce, previewHash: c.previewHash }, d);
    expect(res).toMatchObject({ status: 409, state: "needs_approver", who: ["Omar"] });
    expect(record(c.actionId).status).toBe("pending");
    expect(def.run).not.toHaveBeenCalled();
    // The owner may confirm a card they prepared; the spend actor is the member, with via_eddy.
    const own = await card("start_bulk", { broadcastId: "b2" }, eddy(OWNER), d);
    expect(await confirmAction({ principal: eddy(OWNER), actionId: own.actionId, nonce: own.nonce, previewHash: own.previewHash }, d)).toMatchObject({ status: 200 });
    expect((def.run as ReturnType<typeof vi.fn>).mock.calls[0][2]).toEqual({ idempotencyKey: own.actionId, spendActor: { type: "user", userId: OWNER.userId, role: "owner", reasonCodes: ["via_eddy"] } });
  });
});

describe("revise, refresh, cancel", () => {
  it("revise accepts only editable fields and replaces the card", async () => {
    const def = sendDef();
    register(def);
    const c = await card();
    expect(await reviseAction({ principal: eddy(), actionId: c.actionId, nonce: c.nonce, edits: { conversationId: "cv9" } }, deps())).toMatchObject({ status: 400, code: "invalid_edit" });
    expect(await reviseAction({ principal: eddy(), actionId: c.actionId, nonce: c.nonce, edits: {} }, deps())).toMatchObject({ status: 400, code: "invalid_edit" });
    expect(await reviseAction({ principal: eddy(), actionId: c.actionId, nonce: "wrong", edits: { text: "x" } }, deps())).toMatchObject({ status: 404 });
    expect(record(c.actionId).status).toBe("pending");
    const revised = await reviseAction({ principal: eddy(), actionId: c.actionId, nonce: c.nonce, edits: { text: "Your order ships on Friday." } }, deps());
    expect(revised).toMatchObject({ status: 200, state: "pending" });
    expect(revised.card!.supersedes).toBe(c.actionId);
    expect(revised.card!.preview.message).toEqual({ kind: "text", body: "Your order ships on Friday." });
    expect(record(c.actionId)).toMatchObject({ status: "superseded", supersededById: revised.card!.actionId });
    expect(record(revised.card!.actionId).args).toEqual({ conversationId: "cv1", text: "Your order ships on Friday." });
    expect(def.run).not.toHaveBeenCalled();
    // The old card can no longer be confirmed; the new one can.
    expect((await confirmAction({ principal: eddy(), actionId: c.actionId, nonce: c.nonce, previewHash: c.previewHash }, deps())).status).toBe(409);
    expect((await confirmAction({ principal: eddy(), actionId: revised.card!.actionId, nonce: revised.card!.nonce, previewHash: revised.card!.previewHash }, deps())).status).toBe(200);
  });

  it("an edit the schema refuses leaves the old card open", async () => {
    register(sendDef());
    const c = await card();
    const res = await reviseAction({ principal: eddy(), actionId: c.actionId, nonce: c.nonce, edits: { text: "x".repeat(1001) } }, deps());
    expect(res).toMatchObject({ status: 400, code: "invalid_args" });
    expect(record(c.actionId)).toMatchObject({ status: "pending", supersededById: null });
  });

  it("refresh re-runs the preview of an expired card with no model call", async () => {
    const def = sendDef();
    register(def);
    const c = await card();
    expect(await refreshAction({ principal: eddy(), actionId: c.actionId }, deps())).toMatchObject({ status: 409, code: "not_expired" });
    clock = new Date(clock.getTime() + 16 * 60_000);
    const fresh = await refreshAction({ principal: eddy(), actionId: c.actionId }, deps());
    expect(fresh).toMatchObject({ status: 200, state: "pending" });
    expect(fresh.card!.supersedes).toBe(c.actionId);
    expect(def.preview).toHaveBeenCalledTimes(2);
    expect(record(c.actionId)).toMatchObject({ status: "expired", supersededById: fresh.card!.actionId });
    expect(await refreshAction({ principal: eddy(), actionId: c.actionId }, deps())).toMatchObject({ status: 409 });
    expect(await refreshAction({ principal: eddy(ADMIN), actionId: fresh.card!.actionId }, deps())).toMatchObject({ status: 404 });
    expect(def.run).not.toHaveBeenCalled();
  });

  it("cancel closes the card; a confirm after it is 409", async () => {
    const def = sendDef();
    register(def);
    const c = await card();
    expect(await cancelAction({ principal: eddy(), actionId: c.actionId, nonce: "nope" }, deps())).toMatchObject({ status: 404 });
    expect(await cancelAction({ principal: eddy(), actionId: c.actionId, nonce: c.nonce }, deps())).toMatchObject({ status: 200, state: "cancelled" });
    expect(record(c.actionId).status).toBe("cancelled");
    expect(await confirmAction({ principal: eddy(), actionId: c.actionId, nonce: c.nonce, previewHash: c.previewHash }, deps())).toMatchObject({ status: 409 });
    expect(def.run).not.toHaveBeenCalled();
  });
});

describe("card limits (4.5)", () => {
  it("at most 3 new cards per turn and 5 pending per member; the same action and target supersedes", async () => {
    register(sendDef());
    const d = deps();
    for (let i = 1; i <= 3; i++) await card("send_fixture", { conversationId: `cv${i}`, text: "Hi" }, eddy(AGENT, "cv_eddy", "turnA"), d);
    const fourth = await proposeAction(eddy(AGENT, "cv_eddy", "turnA"), "send_fixture", { conversationId: "cv4", text: "Hi" }, {}, d);
    expect(fourth.model).toEqual({ status: "refused", code: "turn_budget" });
    await card("send_fixture", { conversationId: "cv4", text: "Hi" }, eddy(AGENT, "cv_eddy", "turnB"), d);
    await card("send_fixture", { conversationId: "cv5", text: "Hi" }, eddy(AGENT, "cv_eddy", "turnB"), d);
    const sixth = await proposeAction(eddy(AGENT, "cv_eddy", "turnB"), "send_fixture", { conversationId: "cv6", text: "Hi" }, {}, d);
    expect(sixth.model).toEqual({ status: "refused", code: "too_many_pending" });
    // A new card for cv5 replaces the pending one instead of counting as a sixth.
    const again = await card("send_fixture", { conversationId: "cv5", text: "Hello again" }, eddy(AGENT, "cv_eddy", "turnC"), d);
    const old = h.db.rows("actionRecord").filter((r) => (r.args as { conversationId: string }).conversationId === "cv5");
    expect(old.map((r) => r.status).sort()).toEqual(["pending", "superseded"]);
    expect(old.find((r) => r.status === "superseded")!.supersededById).toBe(again.actionId);
  });
});

describe("undo", () => {
  async function tagged(principal = eddy()) {
    const out = await proposeAction(principal, "tag_fixture", { conversationId: "cv1", tag: "vip" }, {}, deps());
    expect(out.model).toMatchObject({ status: "done", undoAvailable: true });
    return out.actionId!;
  }

  it("undoes within the window for the member, audited as eddy.undo; a second undo is 409", async () => {
    const def = tagDef();
    register(def);
    const id = await tagged();
    const d = deps();
    const res = await undoAction({ principal: eddy(), actionId: id }, d);
    expect(res).toMatchObject({ status: 200, state: "undone" });
    expect(def.undo!.inverse).toHaveBeenCalledTimes(1);
    expect(record(id)).toMatchObject({ status: "undone", undoneAt: expect.any(Date) });
    expect(d.audit.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "eddy.undo", target: id, meta: expect.objectContaining({ action: "tag_fixture", undoneBy: AGENT.userId }) }));
    expect(await undoAction({ principal: eddy(), actionId: id }, d)).toMatchObject({ status: 409, code: "already_undone" });
    expect(def.undo!.inverse).toHaveBeenCalledTimes(1);
  });

  it("after the window is 410; after someone changed it is 409", async () => {
    const def = tagDef();
    register(def);
    const id = await tagged();
    clock = new Date(clock.getTime() + 15 * 60_000 + 1);
    expect(await undoAction({ principal: eddy(), actionId: id }, deps())).toMatchObject({ status: 410, code: "undo_expired" });
    clock = new Date("2026-10-28T10:00:00Z");
    (def.undo!.stillApplies as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    expect(await undoAction({ principal: eddy(), actionId: id }, deps())).toMatchObject({ status: 409, code: "undo_changed", message: "Someone changed it since, so it was not undone." });
    expect(def.undo!.inverse).not.toHaveBeenCalled();
    expect(record(id).status).toBe("done");
  });

  it("another member cannot undo it; an admin can, as themselves", async () => {
    const def = tagDef();
    register(def);
    h.db.insert("membership", { id: "m_u2", tenantId: T1, userId: "u_agent2", role: "agent", user: { disabledAt: null, emailVerifiedAt: new Date(), name: "Ravi" }, tenant: { deletedAt: null } });
    const id = await tagged();
    expect(await undoAction({ principal: eddy({ userId: "u_agent2", tenantId: T1, role: "agent" }), actionId: id }, deps())).toMatchObject({ status: 404 });
    const d = deps();
    expect(await undoAction({ principal: eddy(ADMIN), actionId: id }, d)).toMatchObject({ status: 200, state: "undone" });
    expect(d.audit.audit).toHaveBeenCalledWith(expect.objectContaining({ userId: ADMIN.userId, action: "eddy.undo" }));
  });

  it("an undo that would start a rule is not done in one tap", async () => {
    const def = tagDef();
    register(def);
    const id = await tagged();
    const rule = { id: "r1", name: "Lost VIP", priority: 0, createdAt: new Date(), updatedAt: new Date(), trigger: { type: "tag_removed", tag: "vip" }, filters: { root: { type: "group", op: "and", items: [] }, options: { allowWhenHumanActive: false } }, actions: [{ type: "send_text", text: "We miss you" }] };
    const { fakeAutomation } = await import("./helpers/action-fixtures");
    const res = await undoAction({ principal: eddy(), actionId: id }, deps({ automation: fakeAutomation([rule]) }));
    expect(res).toMatchObject({ status: 409, code: "triggers_automation" });
    expect(def.undo!.inverse).not.toHaveBeenCalled();
    const paid = { ...rule, actions: [{ type: "send_template", templateId: "tp1", variables: [] }] };
    expect(await undoAction({ principal: eddy(), actionId: id }, deps({ automation: fakeAutomation([paid]) }))).toMatchObject({ status: 409, code: "triggers_paid_rule" });
  });

  it("an inverse that messages customers or spends returns a card for inverseAction instead", async () => {
    const pause = pauseDef();
    const resume = resumeDef();
    register(pause, resume);
    const out = await proposeAction(eddy(ADMIN), "pause_fixture", { broadcastId: "b1" }, {}, deps());
    const res = await undoAction({ principal: eddy(ADMIN), actionId: out.actionId! }, deps());
    expect(res).toMatchObject({ status: 200, state: "pending" });
    expect(res.card).toMatchObject({ action: "resume_fixture", state: "pending" });
    expect(record(res.card!.actionId).args).toEqual({ broadcastId: "b1" });
    expect(pause.undo!.inverse).not.toHaveBeenCalled();
    expect(resume.run).not.toHaveBeenCalled();
    expect(record(out.actionId!).status).toBe("done");
  });

  it("an inverse card is offered only while the change still stands", async () => {
    const pause = pauseDef();
    register(pause, resumeDef());
    const out = await proposeAction(eddy(ADMIN), "pause_fixture", { broadcastId: "b1" }, {}, deps());
    (pause.undo!.stillApplies as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const res = await undoAction({ principal: eddy(ADMIN), actionId: out.actionId! }, deps());
    expect(res).toMatchObject({ status: 409, code: "undo_changed", message: "Someone changed it since, so it was not undone." });
    expect(res.card).toBeUndefined();
    expect(h.db.rows("actionRecord").filter((r) => r.action === "resume_fixture")).toEqual([]);
  });

  it("the undo runs the action's gates with the fresh role: a member demoted since cannot undo", async () => {
    const pause = pauseDef();
    register(pause, resumeDef());
    const out = await proposeAction(eddy(ADMIN), "pause_fixture", { broadcastId: "b1" }, {}, deps());
    setRole(h.db, ADMIN.userId, "agent");
    const res = await undoAction({ principal: eddy(ADMIN), actionId: out.actionId! }, deps());
    expect(res).toMatchObject({ status: 403, state: "refused", code: "role", requiredRole: "admin" });
    expect(h.db.rows("actionInvocation").at(-1)).toMatchObject({ stage: "undo", outcome: "refused", code: "role", actionRecordId: out.actionId });
    expect(pause.undo!.stillApplies).not.toHaveBeenCalled();
  });

  it("a background job never undoes, even its own lowering", async () => {
    const pause = pauseDef();
    register(pause, resumeDef());
    const { systemPrincipal } = await import("@/lib/actions/principal");
    const job = systemPrincipal("actions.reconcile", T1);
    const out = await proposeAction(job, "pause_fixture", { broadcastId: "b1" }, {}, deps());
    expect(out.model).toMatchObject({ status: "done", undoAvailable: true });
    expect(await undoAction({ principal: job, actionId: out.actionId! }, deps())).toMatchObject({ status: 403, code: "role" });
    expect(pause.undo!.stillApplies).not.toHaveBeenCalled();
  });

  it("the definition's undo guard runs as G9 and its sentence is kept", async () => {
    const { HttpError } = await import("@/lib/tenancy");
    const def = tagDef();
    const guard = vi.fn(async () => {
      throw new HttpError(403, "This conversation is assigned to someone else.");
    });
    register(tagDef({ undo: { ...def.undo!, authorize: guard } }));
    const id = await tagged();
    const spec = (await import("@/lib/actions/registry")).actionByName("tag_fixture")!.undo!;
    const res = await undoAction({ principal: eddy(), actionId: id }, deps());
    expect(res).toMatchObject({ status: 403, state: "refused", code: "forbidden", message: "This conversation is assigned to someone else." });
    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ p: expect.objectContaining({ actor: expect.objectContaining({ userId: AGENT.userId }) }) }), { kind: "tags", target: "cv1", before: [], after: ["vip"] });
    expect(spec.inverse).not.toHaveBeenCalled();
    expect(record(id)).toMatchObject({ status: "done", undoneAt: null });
  });

  it("undo_last_action finds the member's own newest undoable action in this conversation", async () => {
    register(tagDef());
    expect(await undoLastAction(eddy(), deps())).toMatchObject({ status: 404, code: "nothing_to_undo" });
    const id = await tagged();
    expect(await undoLastAction(eddy(), deps())).toMatchObject({ status: 200, actionId: id });
    expect(await undoLastAction(eddy(AGENT, "cv_other"), deps())).toMatchObject({ status: 404 });
  });
});
