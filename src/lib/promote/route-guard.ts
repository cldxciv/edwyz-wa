/**
 * The guard every /api/promote route, and every new ads and lead-form route, starts with (docs/IG-PAGE-ADS-SPEC.md 4.8, PRM-00).
 *
 * - Reads: getActor, then promoteAccess. A member who cannot see the feature gets 404, so the area is not discoverable while it
 *   is dark (PROMOTE_ENABLED=off) or open to Edwyz platform admins only (admins).
 * - Writes: assertSameOrigin, getActor, the same visibility rule, then the admin role. Agents get 403.
 * - Start: a write that also needs access.canStart (train P3: PROMOTE_ENABLED=on with both spend controls enforcing).
 * - assertPromoteStartOpen(): the same Start gate at the spend chokepoint, ads/service.activateCampaign (activate and resume), so
 *   a promote or Eddy campaign cannot be turned on early through an older route (/api/ads/campaigns/[id]/activate or resume, a
 *   spend approval, a breaker's auto-resume).
 * - isDryRun(): SPEND_DRY_RUN, for routes that answer with fake ids instead of writing to Meta (never in production).
 * Every refusal is an HttpError with a plain message; promoteRoute() turns it into the JSON answer through errorResponse.
 */
import type { Role } from "@/generated/prisma/client";
import { evaluateAdminAccess } from "@/lib/admin/auth";
import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { prisma } from "@/lib/db";
import { spendDryRun } from "@/lib/spend/flags";
import { sandboxFlagFor } from "@/lib/spend/sandbox";
import { type Actor, errorResponse, hasRole, HttpError } from "@/lib/tenancy";
import { type PromoteAccess, promoteAccess, promoteEnabled, promoteExperimental } from "./flags";

type Env = Record<string, string | undefined>;

/** The same answer as an unknown path: nothing tells a member that a hidden feature exists. */
export const PROMOTE_NOT_FOUND = "Not found.";
export const PROMOTE_WRITERS_ONLY = "Only workspace admins and owners can change ads. Ask one of them to do this.";
export const PROMOTE_ROLE_TOO_LOW = "Only workspace admins and owners can see this. Ask one of them for help.";
export const PROMOTE_OWNER_ONLY = "Only the workspace owner can see this. Ask them for help.";
export const PROMOTE_START_CLOSED = "Starting ads from here isn't open yet. Your draft is saved, so you can start it later.";

export type PromoteGuard = { actor: Actor; access: PromoteAccess; dryRun: boolean };

export type PromoteReadOptions = {
  /** The lowest role that may read this route. Default agent: agents see promotions read-only. */
  minRole?: Role;
  env?: Env;
};

export type PromoteWriteOptions = {
  /** The route starts spending (Start): it also needs access.canStart. */
  start?: boolean;
  env?: Env;
};

const notFound = () => new HttpError(404, PROMOTE_NOT_FOUND);

/** SPEND_DRY_RUN=1 outside production: answer with fake ids, write nothing to Meta. Always false in production. */
export function isDryRun(env: Env = process.env): boolean {
  return spendDryRun(env);
}

/** An Edwyz platform admin: allowlisted in PLATFORM_ADMIN_EMAILS, email verified, not disabled (src/lib/admin/auth.ts). */
async function isPlatformAdminUser(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerifiedAt: true, disabledAt: true, totpEnabledAt: true },
  });
  if (!user) return false;
  // Eligibility only: the admin console's TOTP step-up guards the console, not a platform admin's own workspace pages.
  return evaluateAdminAccess({ ...user, stepUpValid: false }) !== "deny";
}

/** Whether the workspace's spending ad account (Phase 0 2.3.3) is a Meta sandbox account. */
async function spendingAccountIsSandbox(tenantId: string): Promise<boolean> {
  const control = await prisma.spendControl.findUnique({ where: { tenantId }, select: { spendingAdAccountAssetId: true } });
  return sandboxFlagFor(tenantId, control?.spendingAdAccountAssetId ?? null);
}

/**
 * What this member may do. Looks up only what the flags need: nothing while the feature is off, the platform-admin rule only
 * in admins mode, and the sandbox account only while PROMOTE_EXPERIMENTAL is on.
 */
export async function accessFor(actor: Actor, env: Env = process.env): Promise<PromoteAccess> {
  const mode = promoteEnabled(env);
  const isPlatformAdmin = mode === "admins" ? await isPlatformAdminUser(actor.userId) : false;
  const visible = mode === "on" || (mode === "admins" && isPlatformAdmin);
  const sandboxAccount = visible && promoteExperimental(env) ? await spendingAccountIsSandbox(actor.tenantId) : false;
  return promoteAccess({ role: actor.role, isPlatformAdmin, sandboxAccount }, env);
}

/** The AdCampaign.surface values whose campaigns turn on only through the Start gate. Old-wizard and API campaigns keep Phase 0's rules. */
export const PROMOTE_START_SURFACES: readonly string[] = Object.freeze(["promote", "eddy"]);

/**
 * The Start gate at the chokepoint: a campaign made by Promote or Eddy (surface promote or eddy) is turned on or resumed only while
 * access.canStart holds (PROMOTE_ENABLED=on, SPEND_ENFORCE=enforce, SPEND_TRIPWIRE=enforce, and an owner or admin); otherwise 403
 * with PROMOTE_START_CLOSED, whichever route or job asked. ads/service.activateCampaign calls it right after loading the campaign,
 * before anything is audited, reserved or sent. Other surfaces pass untouched.
 * Pure, with no lookup: canStart never depends on the platform-admin or sandbox facts accessFor() reads (it needs mode on).
 * launchCampaign is not gated: it creates every object PAUSED under a neutral create permit and spends nothing.
 */
export function assertPromoteStartOpen(actor: Pick<Actor, "role">, campaign: { surface?: string | null }, env: Env = process.env): void {
  if (!PROMOTE_START_SURFACES.includes(campaign.surface ?? "wizard")) return;
  if (!promoteAccess({ role: actor.role, isPlatformAdmin: false, sandboxAccount: false }, env).canStart) throw new HttpError(403, PROMOTE_START_CLOSED);
}

/** A read: the signed-in member, 404 when the feature is hidden from them, 403 below minRole. */
export async function promoteRead(request: Request, options: PromoteReadOptions = {}): Promise<PromoteGuard> {
  const env = options.env ?? process.env;
  if (promoteEnabled(env) === "off") throw notFound();
  const actor = await getActor(request);
  const access = await accessFor(actor, env);
  if (!access.visible) throw notFound();
  if (options.minRole && !hasRole(actor, options.minRole)) throw new HttpError(403, options.minRole === "owner" ? PROMOTE_OWNER_ONLY : PROMOTE_ROLE_TOO_LOW);
  return { actor, access, dryRun: isDryRun(env) };
}

/** A write: same origin first, then the member, 404 when hidden, 403 for agents, and 403 for Start until it is open. */
export async function promoteWrite(request: Request, options: PromoteWriteOptions = {}): Promise<PromoteGuard> {
  const env = options.env ?? process.env;
  assertSameOrigin(request);
  if (promoteEnabled(env) === "off") throw notFound();
  const actor = await getActor(request);
  const access = await accessFor(actor, env);
  if (!access.visible) throw notFound();
  if (!hasRole(actor, "admin") || !access.canWrite) throw new HttpError(403, PROMOTE_WRITERS_ONLY);
  if (options.start && !access.canStart) throw new HttpError(403, PROMOTE_START_CLOSED);
  return { actor, access, dryRun: isDryRun(env) };
}

type Handler<C> = (guard: PromoteGuard, request: Request, context: C) => Promise<Response>;

/**
 * Wraps a route handler: runs the read or write guard, then the handler, and turns any HttpError into its JSON answer.
 *   export const GET = promoteRoute("read", async ({ access }) => Response.json({ access }));
 */
export function promoteRoute<C = unknown>(kind: "read", handler: Handler<C>, options?: PromoteReadOptions): (request: Request, context: C) => Promise<Response>;
export function promoteRoute<C = unknown>(kind: "write", handler: Handler<C>, options?: PromoteWriteOptions): (request: Request, context: C) => Promise<Response>;
export function promoteRoute<C = unknown>(kind: "read" | "write", handler: Handler<C>, options: PromoteReadOptions & PromoteWriteOptions = {}) {
  return async (request: Request, context: C): Promise<Response> => {
    try {
      const guard = kind === "write" ? await promoteWrite(request, options) : await promoteRead(request, options);
      return await handler(guard, request, context);
    } catch (error) {
      return errorResponse(error, request);
    }
  };
}
