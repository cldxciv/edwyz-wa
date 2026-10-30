import { audit } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { queueEmail } from "@/lib/email";
import { workspaceDeletionCancelledTemplate, workspaceDeletionRequestedTemplate, workspaceDeletionTeamTemplate } from "@/lib/email/templates";
import { HttpError, type Actor, requireRole } from "@/lib/tenancy";
import { emailOwners, readState } from "./state";

/** The privacy policy promises deletion on request within this many days. */
export const DELETION_PROMISE_DAYS = 30;

/** The key contains the workspace id, so workspace erasure removes it together with the rest of the workspace's settings. */
export const deletionKey = (tenantId: string) => `workspace-deletion:${tenantId}`;

export type DeletionRequest = {
  status: "requested";
  requestedAt: string;
  requestedByUserId: string;
  deleteBy: string;
  /**
   * The owner's choice for Meta's spending limit per ad account (docs/SPEND-CONTROLS-SPEC.md 5.8, 4.17), default keep. It is
   * applied before the Meta revoke and before erasure (erase-workspace.ts runs the offboarding first).
   */
  metaLimit?: Record<string, "keep" | "restore" | "remove">;
};

/**
 * The accounts the close dialog asks about (every ad account where Edwyz manages Meta's limit) and their three choices,
 * "Keep the current limit on Meta" first and selected by default.
 */
export async function closeWorkspaceMetaLimits(tenantId: string) {
  const { offboardChoicesFor } = await import("@/lib/spend/metacap/offboard");
  return offboardChoicesFor(tenantId);
}

export async function getDeletionRequest(tenantId: string): Promise<DeletionRequest | null> {
  const state = await readState<DeletionRequest>(deletionKey(tenantId));
  return state?.status === "requested" ? state : null;
}

const same = (a: string, b: string) => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

function teamAddresses(raw = process.env.PLATFORM_ADMIN_EMAILS): string[] {
  return (raw ?? "")
    .split(/[,;\s]+/)
    .map((v) => v.trim().toLowerCase())
    .filter((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
    .slice(0, 10);
}

async function store(tenantId: string, value: object): Promise<void> {
  await prisma.platformSetting.upsert({ where: { key: deletionKey(tenantId) }, create: { key: deletionKey(tenantId), value }, update: { value } });
}

/**
 * An owner asks for the workspace and its data to be deleted. Nothing is erased here: a person on the platform team does that
 * (admin console, "erase workspace") after checking the request, so a mis-click or a stolen session cannot destroy data.
 * The owner must type the workspace name. The request is recorded, audited, confirmed by email to every owner and flagged to the platform team.
 */
export async function requestWorkspaceDeletion(actor: Actor, confirmName: unknown, now = new Date(), metaLimitChoices?: unknown): Promise<DeletionRequest> {
  requireRole(actor, "owner");
  const tenant = await prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { name: true } });
  if (!tenant) throw new HttpError(404, "Workspace not found.");
  if (typeof confirmName !== "string" || !same(confirmName, tenant.name)) throw new HttpError(400, "Type the workspace name exactly to confirm.");
  const existing = await getDeletionRequest(actor.tenantId);
  if (existing) return existing;

  // Meta's limit (5.8): the owner's choices are stored for the erasure, which applies them before the Meta revoke.
  let metaLimit: DeletionRequest["metaLimit"];
  if (metaLimitChoices !== undefined && metaLimitChoices !== null) {
    if (typeof metaLimitChoices !== "object" || Array.isArray(metaLimitChoices)) throw new HttpError(400, "Choose what happens to Meta's spending limit.");
    const { saveOffboardChoices } = await import("@/lib/spend/metacap/offboard");
    metaLimit = await saveOffboardChoices(actor.tenantId, metaLimitChoices as Record<string, unknown>, { type: "user", userId: actor.userId, role: actor.role }, "close");
  }

  const request: DeletionRequest = {
    status: "requested",
    requestedAt: now.toISOString(),
    requestedByUserId: actor.userId,
    deleteBy: new Date(now.getTime() + DELETION_PROMISE_DAYS * 86_400_000).toISOString(),
    ...(metaLimit && Object.keys(metaLimit).length ? { metaLimit } : {}),
  };
  await store(actor.tenantId, request);
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "workspace.deletion_requested" });
  try {
    await emailOwners(actor.tenantId, () => workspaceDeletionRequestedTemplate({ workspaceName: tenant.name, days: DELETION_PROMISE_DAYS }));
    for (const to of teamAddresses()) {
      await queueEmail({ to, ...workspaceDeletionTeamTemplate({ workspaceId: actor.tenantId, workspaceName: tenant.name, days: DELETION_PROMISE_DAYS }) });
    }
  } catch {
    console.warn("[lifecycle] could not queue the deletion request mails");
  }
  return request;
}

/** Withdraws a request that has not been carried out yet. */
export async function cancelWorkspaceDeletion(actor: Actor): Promise<{ cancelled: boolean }> {
  requireRole(actor, "owner");
  if (!(await getDeletionRequest(actor.tenantId))) return { cancelled: false };
  await store(actor.tenantId, { status: "cancelled", cancelledAt: new Date().toISOString() });
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "workspace.deletion_cancelled" });
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { name: true } });
    await emailOwners(actor.tenantId, () => workspaceDeletionCancelledTemplate({ workspaceName: tenant?.name ?? "your workspace" }));
  } catch {
    console.warn("[lifecycle] could not queue the deletion cancelled mail");
  }
  return { cancelled: true };
}
