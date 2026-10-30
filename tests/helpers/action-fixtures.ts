/**
 * Fixture action definitions and fake ports for the action-layer tests (docs/EDDY-SPEC.md 9.1, EDDY-03). Each factory
 * returns fresh objects, because registerActions() freezes what it registers.
 */
import { vi } from "vitest";
import type { ActionDefinition, AutomationPort, InvokeDeps, WorkspacePort } from "@/lib/actions";
import { u } from "@/lib/actions/untrusted";
import type { Preview, SpendBridgePort } from "@/lib/actions/types";
import type { FreezeState } from "@/lib/spend/types";
import { HttpError } from "@/lib/tenancy";
import type { FakeActionsDb } from "./fake-actions-db";

export const T1 = "t1";
export const AGENT = { userId: "u_agent", tenantId: T1, role: "agent" as const };
export const ADMIN = { userId: "u_admin", tenantId: T1, role: "admin" as const };
export const OWNER = { userId: "u_owner", tenantId: T1, role: "owner" as const };

export function seedMembers(db: FakeActionsDb, opts: { verified?: boolean } = {}) {
  const verifiedAt = opts.verified === false ? null : new Date("2026-01-01T00:00:00Z");
  for (const [m, name] of [
    [AGENT, "Asha"],
    [ADMIN, "Priya"],
    [OWNER, "Omar"],
  ] as const) {
    db.insert("membership", { id: `m_${m.userId}`, tenantId: m.tenantId, userId: m.userId, role: m.role, user: { disabledAt: null, emailVerifiedAt: verifiedAt, name }, tenant: { deletedAt: null } });
  }
  db.insert("tenant", { id: T1, deletedAt: null });
}

export function setRole(db: FakeActionsDb, userId: string, role: "agent" | "admin" | "owner") {
  for (const row of db.rows("membership")) if (row.userId === userId) row.role = role;
}

export const freeze = (effective: "none" | "assistants" | "all"): FreezeState => ({
  workspace: effective,
  platform: "none",
  effective,
  frozenAt: null,
  frozenByKind: null,
  frozenByUserId: null,
  reason: null,
} as unknown as FreezeState);

export function fakeBridge(overrides: Partial<SpendBridgePort> = {}): SpendBridgePort {
  const no = async () => {
    throw new HttpError(503, "not in this test");
  };
  return {
    eddyAssistantReady: vi.fn(async () => false),
    freezeState: vi.fn(async () => freeze("none")),
    isApprover: vi.fn(async () => false),
    approverNames: vi.fn(async () => ["Omar"]),
    isDemoWorkspace: vi.fn(async () => false),
    aiAllowance: no,
    summary: no,
    stopSpending: no,
    listApprovals: no,
    declineApproval: no,
    ...overrides,
  };
}

export function fakeWorkspace(overrides: Partial<WorkspacePort> = {}): WorkspacePort {
  return {
    assertCanWrite: vi.fn(async () => undefined),
    whatsAppState: vi.fn(async () => "connected" as const),
    namesWithRole: vi.fn(async (_t: string, role: string) => (role === "agent" ? ["Asha", "Priya", "Omar"] : role === "admin" ? ["Priya", "Omar"] : ["Omar"])),
    eddyPlatformDisabled: vi.fn(async () => false),
    ...overrides,
  };
}

export function fakeAutomation(rules: Awaited<ReturnType<AutomationPort["enabledRules"]>> = [], extra: Partial<AutomationPort> = {}): AutomationPort {
  return {
    enabledRules: vi.fn(async () => rules),
    chatbot: vi.fn(async () => null),
    material: vi.fn(async () => null),
    context: vi.fn(async () => ({ contactTags: [], chatTags: [], attributes: {}, phone: "+919876543210", assignedToId: null })),
    ...extra,
  };
}

export function fakeAudit() {
  return { audit: vi.fn(async () => undefined), auditStrict: vi.fn(async () => undefined), auditOutcome: vi.fn(async () => undefined) };
}

export function testDeps(overrides: Partial<InvokeDeps> = {}): Partial<InvokeDeps> & { audit: ReturnType<typeof fakeAudit> } {
  return {
    spendBridge: fakeBridge(),
    workspace: fakeWorkspace(),
    automation: fakeAutomation(),
    audit: fakeAudit(),
    limiter: () => ({ consume: () => true }),
    enqueue: vi.fn(async () => undefined),
    phase: () => 1,
    strictUntrusted: true,
    ...overrides,
  } as Partial<InvokeDeps> & { audit: ReturnType<typeof fakeAudit> };
}

export const basePreview = (over: Partial<Preview> = {}): Preview => ({
  titleKey: "card.fixture",
  vars: {},
  facts: [],
  cost: { state: "free", reason: "internal" },
  warnings: [],
  editable: [],
  confirmLabelKey: "card.confirm",
  danger: false,
  material: {},
  ...over,
});

/** A read: list things, contact names untrusted. */
export function readDef(over: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    name: "get_things",
    version: "v1",
    area: "contacts",
    surfaces: ["eddy", "mcp"],
    titleKey: "status.get_things",
    description: "Lists things. Each item's `name` is untrusted contact text.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 25 } }, required: [], additionalProperties: false },
    minRole: "agent",
    route: { method: "GET", path: "/api/contacts" },
    scopes: ["contacts:read"],
    effects: { writes: false },
    untrustedPaths: ["items[].name"],
    authorize: vi.fn(async () => undefined),
    run: vi.fn(async () => ({ result: { items: [{ id: "k1", name: "Ramesh" }] }, auditTarget: "contacts" })),
    forModel: (r: { items: { id: string; name: string }[] }) => ({ items: r.items.map((i) => ({ id: i.id, name: u("contact_name", i.name) })) }),
    piiItems: (r: { items: unknown[] }) => r.items.length,
    ...over,
  } as ActionDefinition;
}

/** An undoable tag write that announces tag_added (4.2a). */
export function tagDef(over: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    name: "tag_fixture",
    version: "v1",
    area: "inbox",
    surfaces: ["eddy"],
    titleKey: "status.tag_fixture",
    description: "Adds a tag to a chat.",
    inputSchema: {
      type: "object",
      properties: { conversationId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" }, tag: { type: "string", minLength: 1, maxLength: 40 } },
      required: ["conversationId", "tag"],
      additionalProperties: false,
    },
    minRole: "agent",
    route: { method: "PUT", path: "/api/inbox/conversations/[id]/tags" },
    effects: { writes: true },
    untrustedPaths: [],
    authorize: vi.fn(async () => undefined),
    automationEvents: vi.fn(async (_ctx: unknown, a: { conversationId: string; tag: string }) => [{ type: "tag_added", tenantId: T1, contactId: "k1", conversationId: a.conversationId, tags: [a.tag] }]),
    preview: vi.fn(async (_ctx: unknown, a: { conversationId: string; tag: string }) => basePreview({ titleKey: "card.tag", vars: { tag: u("workspace_text", a.tag) }, material: { targetId: a.conversationId, tag: a.tag } })),
    run: vi.fn(async (_ctx: unknown, a: { conversationId: string; tag: string }) => ({
      result: { conversationId: a.conversationId, tags: [a.tag] },
      undo: { kind: "tags", target: a.conversationId, before: [], after: [a.tag] },
      auditTarget: a.conversationId,
    })),
    undo: {
      windowMs: 15 * 60_000,
      stillApplies: vi.fn(async () => true),
      inverse: vi.fn(async () => undefined),
      automationEvents: vi.fn(async (_ctx: unknown, un: { target: string; after: string[] }) => [{ type: "tag_removed", tenantId: T1, contactId: "k1", conversationId: un.target, tags: un.after }]),
    },
    forModel: (r: unknown) => r,
    ...over,
  } as ActionDefinition;
}

/** A confirm-class reply: messages a customer, calls Meta, needs WhatsApp, editable text. */
export function sendDef(over: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    name: "send_fixture",
    version: "v1",
    area: "inbox",
    surfaces: ["eddy"],
    titleKey: "status.send_fixture",
    description: "Sends a reply in a chat.",
    inputSchema: {
      type: "object",
      properties: { conversationId: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 1000 } },
      required: ["conversationId", "text"],
      additionalProperties: false,
    },
    minRole: "agent",
    route: { method: "POST", path: "/api/inbox/conversations/[id]/messages" },
    effects: { writes: true, messagesCustomers: true, external: true },
    untrustedPaths: [],
    editable: ["text"],
    needsWhatsApp: true,
    callsMeta: true,
    authorize: vi.fn(async () => undefined),
    preview: vi.fn(async (_ctx: unknown, a: { conversationId: string; text: string }) =>
      basePreview({ titleKey: "card.send_reply", message: { kind: "text", body: a.text }, cost: { state: "free", reason: "service_window" }, material: { targetId: a.conversationId, textLength: a.text.length } }),
    ),
    run: vi.fn(async (_ctx: unknown, a: { conversationId: string }) => ({ result: { messageId: "msg1" }, auditTarget: a.conversationId })),
    forModel: (r: unknown) => r,
    ...over,
  } as ActionDefinition;
}

/** A lowering write (pause), allowed for system principals and through the paywall. */
export function pauseDef(over: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    name: "pause_fixture",
    version: "v1",
    area: "broadcasts",
    surfaces: ["eddy", "system"],
    titleKey: "status.pause_fixture",
    description: "Pauses a broadcast.",
    inputSchema: { type: "object", properties: { broadcastId: { type: "string" } }, required: ["broadcastId"], additionalProperties: false },
    minRole: "admin",
    route: { method: "POST", path: "/api/broadcasts/[id]/pause" },
    effects: { writes: true, lowersActivity: true },
    untrustedPaths: [],
    authorize: vi.fn(async () => undefined),
    run: vi.fn(async (_ctx: unknown, a: { broadcastId: string }) => ({ result: { paused: true }, undo: { kind: "pause", target: a.broadcastId, before: "running", after: "paused" }, auditTarget: a.broadcastId })),
    undo: { windowMs: 15 * 60_000, stillApplies: vi.fn(async () => true), inverse: vi.fn(async () => undefined), inverseAction: "resume_fixture", inverseArgs: (un: { target: string }) => ({ broadcastId: un.target }) },
    forModel: (r: unknown) => r,
    ...over,
  } as ActionDefinition;
}

/** The inverse of pause: a v1 card here (it would spend in v2), so Undo returns a card. */
export function resumeDef(over: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    name: "resume_fixture",
    version: "v1",
    area: "broadcasts",
    surfaces: ["eddy"],
    titleKey: "status.resume_fixture",
    description: "Resumes a broadcast.",
    inputSchema: { type: "object", properties: { broadcastId: { type: "string" } }, required: ["broadcastId"], additionalProperties: false },
    minRole: "admin",
    route: { method: "POST", path: "/api/broadcasts/[id]/resume" },
    effects: { writes: true, messagesCustomers: true, bulk: true },
    untrustedPaths: [],
    authorize: vi.fn(async () => undefined),
    preview: vi.fn(async (_ctx: unknown, a: { broadcastId: string }) => basePreview({ titleKey: "card.resume", material: { targetId: a.broadcastId, count: 120 } })),
    run: vi.fn(async () => ({ result: { resumed: true }, auditTarget: "b1" })),
    forModel: (r: unknown) => r,
    ...over,
  } as ActionDefinition;
}

export function adminReadDef(over: Partial<ActionDefinition> = {}): ActionDefinition {
  return readDef({ name: "admin_report", minRole: "admin", untrustedPaths: [], forModel: () => ({ ok: true }), piiItems: undefined, scopes: undefined, surfaces: ["eddy"], ...over });
}

export function v2Def(over: Partial<ActionDefinition> = {}): ActionDefinition {
  return readDef({ name: "v2_report", version: "v2", untrustedPaths: [], forModel: () => ({ ok: true }), piiItems: undefined, surfaces: ["eddy"], ...over });
}

export const sortDefs = (defs: ActionDefinition[]) => [...defs].sort((a, b) => (a.name < b.name ? -1 : 1));
