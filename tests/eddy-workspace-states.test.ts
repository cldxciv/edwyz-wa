import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeActionsDb } from "./helpers/fake-actions-db";

/**
 * docs/EDDY-SPEC.md 6.14 and EDDY-05 acceptance 13: the demo workspace, no WhatsApp number, an expired or revoked token, and
 * a locked workspace. Each refusal (demo, not_connected, reconnect, workspace_locked) comes before any service call (spies)
 * and before any card, with its next step; reads keep working, local writes work in the demo workspace, and lowering
 * (pause) still works in a locked one.
 */
const h = vi.hoisted(() => ({
  db: null as unknown as FakeActionsDb,
  sendText: vi.fn(async () => ({ id: "msg1", status: "queued" })),
  submitTemplate: vi.fn(async () => ({ id: "t1", status: "pending" })),
  deleteTemplate: vi.fn(async () => undefined),
  createTemplate: vi.fn(async () => ({ id: "t_new", name: "x", status: "draft", updatedAt: new Date() })),
  listTemplates: vi.fn(async () => [{ id: "t1", name: "offer", status: "draft", category: "MARKETING", language: "en", rejectionReason: null, updatedAt: new Date() }]),
  updateContact: vi.fn(async () => ({})),
  pauseBroadcast: vi.fn(async () => ({ id: "b1", status: "paused" })),
  graphFetch: vi.fn(async () => {
    throw new Error("Meta must not be called");
  }),
}));

vi.mock("@/lib/db", async () => {
  const { createFakeActionsDb } = await import("./helpers/fake-actions-db");
  h.db = createFakeActionsDb();
  return { prisma: h.db.prisma };
});
vi.mock("@/lib/graph", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/graph")>()), graphFetch: h.graphFetch }));
vi.mock("@/lib/inbox/service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/inbox/service")>()), sendText: h.sendText }));
vi.mock("@/lib/inbox/settings", () => ({ signatureForUser: vi.fn(async () => undefined) }));
vi.mock("@/lib/templates/service", () => ({ submitTemplate: h.submitTemplate, deleteTemplate: h.deleteTemplate, createTemplate: h.createTemplate, listTemplates: h.listTemplates }));
vi.mock("@/lib/contacts/service", () => ({ updateContact: h.updateContact }));
vi.mock("@/lib/broadcasts/service", () => ({ pauseBroadcast: h.pauseBroadcast }));
vi.mock("@/lib/setup", () => ({ getSetup: vi.fn(async () => ({ steps: [], summary: { percent: 40, done: 2, total: 5, nextStepId: "connect" } })) }));
vi.mock("@/lib/onboarding/token-health", () => ({ getWhatsAppTokenHealth: vi.fn(async () => ({ state: "none", expiresAt: null, daysLeft: null })) }));

import { confirmAction, proposeAction, resetInvokeState } from "@/lib/actions/invoke";
import { clearPrincipalMemo, eddyPrincipal } from "@/lib/actions/principal";
import { HttpError } from "@/lib/tenancy";
import { ADMIN, AGENT, T1, fakeBridge, fakeWorkspace, seedMembers, testDeps } from "./helpers/action-fixtures";

const recent = new Date(Date.now() - 60 * 60_000);

// The definitions load their services on first use; load them once up front so no single test pays for it under a busy
// parallel run, and give each test room on a slow machine.
vi.setConfig({ testTimeout: 30_000 });
beforeAll(async () => {
  await Promise.all([import("@/lib/teams/visibility"), import("@/lib/inbox/status"), import("@/lib/automation/v2/emit"), import("@/lib/billing/limits"), import("@/lib/auth/audit"), import("@/lib/actions/canonical")]);
}, 120_000);
const eddy = (actor: { userId: string; tenantId: string; role: "agent" | "admin" | "owner" } = AGENT) =>
  eddyPrincipal({ actor, emailVerified: true, conversationId: "cv_eddy", lang: "en", turnId: `turn_${Math.random()}` });

const SPIES = () => [h.sendText, h.submitTemplate, h.deleteTemplate, h.createTemplate, h.updateContact, h.graphFetch];

beforeEach(() => {
  h.db.reset();
  seedMembers(h.db);
  h.db.insert("contact", { id: "k1", tenantId: T1, name: "Ramesh", phone: "+919876543210", tags: [], attributes: {}, optIn: true, optedOutAt: null, ownerUserId: null, leadStage: null, createdAt: new Date() });
  h.db.insert("conversation", { id: "cv1", tenantId: T1, phoneNumberId: "pn1", contactId: "k1", status: "open", tags: [], assignedToId: AGENT.userId, teamId: null, lastInboundAt: recent, lastMessageAt: recent });
  h.db.insert("phoneNumber", { id: "pn1", tenantId: T1, wabaRefId: "w1", displayPhone: "+91 80000 00000", createdAt: new Date(0) });
  h.db.insert("template", { id: "t1", tenantId: T1, wabaRefId: "w1", name: "offer", language: "en", category: "MARKETING", status: "draft", components: [{ type: "BODY", text: "Hi" }], rejectionReason: null, createdAt: new Date(), updatedAt: new Date() });
  h.db.insert("broadcast", { id: "b1", tenantId: T1, name: "Diwali", status: "sending", templateId: "t1", phoneNumberId: "pn1", createdAt: new Date() });
  resetInvokeState();
  clearPrincipalMemo();
  for (const spy of SPIES()) spy.mockClear();
  h.pauseBroadcast.mockClear();
});

const META_CALLS: [string, Record<string, unknown>, "agent" | "admin"][] = [
  ["send_text_reply", { conversationId: "cv1", text: "Hello" }, "agent"],
  ["submit_template", { templateId: "t1" }, "admin"],
  ["delete_template", { templateId: "t1" }, "admin"],
  ["connect_whatsapp", {}, "admin"],
  ["connect_facebook", {}, "admin"],
];

const noServiceCalls = () => {
  for (const spy of SPIES()) expect(spy).not.toHaveBeenCalled();
  expect(h.db.rows("actionRecord")).toEqual([]);
};

describe("demo workspace (6.14)", () => {
  it("every callsMeta tool is refused with demo before any work, even with no number connected", async () => {
    const deps = testDeps({ spendBridge: fakeBridge({ isDemoWorkspace: vi.fn(async () => true) }), workspace: fakeWorkspace({ whatsAppState: vi.fn(async () => "none" as const) }) });
    for (const [name, args, role] of META_CALLS) {
      const out = await proposeAction(eddy(role === "admin" ? ADMIN : AGENT), name, args, {}, deps);
      expect(out.model, name).toEqual({ status: "refused", code: "demo" });
      expect(out.refused?.message, name).toBe("This is a demo workspace, so nothing is sent to Meta or to customers.");
      expect(out.card).toBeUndefined();
    }
    noServiceCalls();
  });

  it("local writes still work with Undo, and the status says it is sample data", async () => {
    const deps = testDeps({ spendBridge: fakeBridge({ isDemoWorkspace: vi.fn(async () => true) }) });
    const tagged = await proposeAction(eddy(), "tag_contacts", { contactIds: ["k1"], add: ["hot"] }, {}, deps);
    expect(tagged.model).toMatchObject({ status: "done", undoAvailable: true });
    expect(h.updateContact).toHaveBeenCalledTimes(1);
    h.db.insert("waba", { id: "w_demo", tenantId: T1, wabaId: `demo-waba-${T1}`, createdAt: new Date() });
    const status = await proposeAction(eddy(), "get_workspace_status", {}, {}, deps);
    expect(status.model).toMatchObject({ status: "done", result: { demo: true, dataNote: "Sample data", ai: { available: false }, spending: { available: false } } });
  });
});

describe("no WhatsApp number, and an expired token (6.14)", () => {
  it("admins get not_connected with the connect step; team members get the admins' names", async () => {
    const deps = testDeps({ workspace: fakeWorkspace({ whatsAppState: vi.fn(async () => "none" as const) }) });
    const admin = await proposeAction(eddy(ADMIN), "submit_template", { templateId: "t1" }, {}, deps);
    expect(admin.model).toEqual({ status: "refused", code: "not_connected" });
    expect(admin.refused?.message).toMatch(/Connect it in Settings/);
    const agent = await proposeAction(eddy(AGENT), "send_text_reply", { conversationId: "cv1", text: "Hi" }, {}, deps);
    expect(agent.model).toEqual({ status: "refused", code: "not_connected", who: [{ $untrusted: "teammate_note", text: "Priya" }, { $untrusted: "teammate_note", text: "Omar" }] });
    expect(agent.refused?.message).toMatch(/Ask an admin to connect it/);
    noServiceCalls();
    // Reading still works without a number.
    expect((await proposeAction(eddy(), "list_templates", {}, {}, deps)).model.status).toBe("done");
  });

  it("an expired or revoked token gives reconnect, never a queued send that fails later", async () => {
    const deps = testDeps({ workspace: fakeWorkspace({ whatsAppState: vi.fn(async () => "reconnect" as const) }) });
    expect((await proposeAction(eddy(), "send_text_reply", { conversationId: "cv1", text: "Hi" }, {}, deps)).model).toEqual({ status: "refused", code: "reconnect" });
    expect((await proposeAction(eddy(ADMIN), "delete_template", { templateId: "t1" }, {}, deps)).model).toEqual({ status: "refused", code: "reconnect" });
    noServiceCalls();
  });

  it("a token that expires between the preview and the tap refuses the tap, with nothing sent", async () => {
    let state: "connected" | "reconnect" = "connected";
    const deps = testDeps({ workspace: fakeWorkspace({ whatsAppState: vi.fn(async () => state) }) });
    const out = await proposeAction(eddy(), "send_text_reply", { conversationId: "cv1", text: "Hi" }, {}, deps);
    expect(out.model.status).toBe("preview_shown");
    state = "reconnect";
    const res = await confirmAction({ principal: eddy(), actionId: out.card!.actionId, nonce: out.card!.nonce, previewHash: out.card!.previewHash }, deps);
    expect(res).toMatchObject({ status: 409, state: "reconnect", code: "reconnect" });
    expect(h.sendText).not.toHaveBeenCalled();
  });
});

describe("locked workspace (6.14, 4.3 G7)", () => {
  const locked = () =>
    testDeps({
      workspace: fakeWorkspace({
        assertCanWrite: vi.fn(async () => {
          throw new HttpError(402, "Your plan has ended, so changes are paused. Renew it in Billing to carry on.");
        }),
      }),
    });

  it("writes and cards are refused with workspace_locked before any service call", async () => {
    const deps = locked();
    for (const [name, args, actor] of [
      ["send_text_reply", { conversationId: "cv1", text: "Hi" }, AGENT],
      ["tag_contacts", { contactIds: ["k1"], add: ["hot"] }, AGENT],
      ["create_template_draft", { name: "x", language: "en", category: "UTILITY", body: "Your order shipped." }, ADMIN],
      ["submit_template", { templateId: "t1" }, ADMIN],
    ] as const) {
      const out = await proposeAction(eddy(actor), name, args, {}, deps);
      expect(out.model, name).toMatchObject({ status: "refused", code: "workspace_locked" });
    }
    noServiceCalls();
  });

  it("reads keep working, and pausing a broadcast (a lowering) still works", async () => {
    const deps = locked();
    expect((await proposeAction(eddy(), "list_templates", {}, {}, deps)).model.status).toBe("done");
    const paused = await proposeAction(eddy(ADMIN), "pause_broadcast", { broadcastId: "b1" }, {}, deps);
    expect(paused.model).toMatchObject({ status: "done" });
    expect(h.pauseBroadcast).toHaveBeenCalledTimes(1);
  });
});
