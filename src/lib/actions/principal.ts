/**
 * Principals: who is calling an action, and on which surface (docs/EDDY-SPEC.md 4.2, 4.3 G4, 4.4, 7.1).
 * - eddy: the session actor of POST /api/eddy/turn or of a card button, with the member's real role;
 *   principalId `eddy:<userId>:<conversationId>`.
 * - mcp and api (after v1, EDDY-20): an API key's actor and scopes; principalId `mcp:<keyId>` or `api:<keyId>`.
 * - system: a background job, `{userId:'system:<job>', role:'admin'}`, limited to lowering actions by invoke.ts (G11).
 *
 * refreshPrincipal (G4) re-reads the membership, `user.disabledAt`, `emailVerifiedAt`, `tenant.deletedAt` and, for eddy, that
 * the session row is still live. Writes, confirms and undos always read fresh; reads are memoised for 5 seconds within a
 * turn. A role below the conversation's roleAtStart closes that conversation, because toolsets are fixed per role class.
 */
import { prisma } from "@/lib/db";
import { HttpError, ROLE_RANK, type Actor } from "@/lib/tenancy";
import type { ApiScope, EddyLang, Principal, Role, VerifiedPageContext } from "./types";

/** What a principal carries besides its public fields: the session it came from and the role its conversation started with. */
export type PrincipalSession = {
  /** The session's refresh-token hash (the access token's `sid`), checked live on every fresh refresh. */
  sessionRef?: string | null;
  /** The conversation's roleAtStart, when the caller already has it; otherwise G4 reads EddyConversation. */
  roleAtStart?: Role | null;
};

const SESSIONS = new WeakMap<Principal, PrincipalSession>();

function attach(p: Principal, meta: PrincipalSession | undefined): Principal {
  if (meta) SESSIONS.set(p, meta);
  return p;
}

export function principalSession(p: Principal): PrincipalSession {
  return SESSIONS.get(p) ?? {};
}

/** A copy of a principal with some fields changed; the session it came from stays attached. */
export function derivePrincipal(p: Principal, changes: Partial<Principal>): Principal {
  return attach({ ...p, ...changes }, SESSIONS.get(p));
}

export function eddyPrincipal(input: {
  actor: Actor;
  emailVerified: boolean;
  conversationId: string;
  lang: EddyLang;
  turnId?: string;
  toolUseId?: string;
  page?: VerifiedPageContext;
  sessionRef?: string | null;
  roleAtStart?: Role | null;
}): Principal {
  const p: Principal = {
    via: "eddy",
    actor: { userId: input.actor.userId, tenantId: input.actor.tenantId, role: input.actor.role },
    principalId: `eddy:${input.actor.userId}:${input.conversationId}`,
    emailVerified: input.emailVerified,
    lang: input.lang,
    conversationId: input.conversationId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
    ...(input.page ? { page: input.page } : {}),
  };
  return attach(p, { sessionRef: input.sessionRef ?? null, roleAtStart: input.roleAtStart ?? null });
}

export function keyPrincipal(input: { via: "mcp" | "api"; keyId: string; actor: Actor; scopes: readonly ApiScope[]; emailVerified?: boolean }): Principal {
  return {
    via: input.via,
    actor: { userId: input.actor.userId, tenantId: input.actor.tenantId, role: input.actor.role },
    principalId: `${input.via}:${input.keyId}`,
    emailVerified: input.emailVerified ?? true,
    scopes: [...input.scopes],
    lang: "en",
  };
}

export const SYSTEM_JOB = /^[a-z][a-z0-9_.:-]{1,62}$/;

export function systemPrincipal(job: string, tenantId: string): Principal {
  if (!SYSTEM_JOB.test(job)) throw new Error(`Invalid system job name "${job}".`);
  return {
    via: "system",
    actor: { userId: `system:${job}`, tenantId, role: "admin" },
    principalId: `system:${job}`,
    emailVerified: true,
    lang: "en",
  };
}

export const isKeyPrincipal = (p: Principal) => p.via === "mcp" || p.via === "api";
export const keyIdOf = (p: Principal) => (isKeyPrincipal(p) ? p.principalId.slice(p.principalId.indexOf(":") + 1) : null);

/** A refusal at G4, with the code the model and the card see. */
export class PrincipalRefusal extends HttpError {
  constructor(
    status: number,
    public code: "role_changed" | "signed_out",
    message: string,
  ) {
    super(status, message);
    this.name = "PrincipalRefusal";
  }
}

export const ROLE_CHANGED_MESSAGE = "Your role in this workspace changed, so this Eddy chat was closed. Start a new chat to carry on.";
const ACCESS_GONE_MESSAGE = "You no longer have access to this workspace.";
const SIGNED_OUT_MESSAGE = "Your session has ended. Sign in again.";

/** Read memo: 5 seconds within a turn (4.3 G4). */
export const READ_MEMO_MS = 5_000;
const memo = new Map<string, { at: number; principal: Principal }>();

export function clearPrincipalMemo(): void {
  memo.clear();
}

export type RefreshOptions = {
  /** Writes, confirm and undo: always true. Reads may reuse a refresh from the last 5 seconds of the same turn. */
  fresh: boolean;
  now?: Date;
};

async function refreshMember(p: Principal, now: Date): Promise<Principal> {
  const { tenantId, userId } = p.actor;
  const membership = await prisma.membership.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { role: true, user: { select: { disabledAt: true, emailVerifiedAt: true } }, tenant: { select: { deletedAt: true } } },
  });
  if (!membership || membership.user?.disabledAt || membership.tenant?.deletedAt) throw new PrincipalRefusal(403, "role_changed", ACCESS_GONE_MESSAGE);

  const meta = principalSession(p);
  if (p.via === "eddy" && meta.sessionRef) {
    const live = await prisma.session.findFirst({
      where: { userId, refreshTokenHash: meta.sessionRef, OR: [{ revokedAt: null }, { revokedAt: { gt: now } }], expiresAt: { gt: now } },
      select: { id: true },
    });
    if (!live) throw new PrincipalRefusal(401, "signed_out", SIGNED_OUT_MESSAGE);
  }

  if (p.via === "eddy" && p.conversationId) {
    let roleAtStart = meta.roleAtStart ?? null;
    if (!roleAtStart) {
      const conversation = await prisma.eddyConversation.findFirst({ where: { id: p.conversationId, tenantId, userId }, select: { roleAtStart: true } });
      roleAtStart = conversation?.roleAtStart ?? null;
    }
    if (roleAtStart && ROLE_RANK[membership.role] < ROLE_RANK[roleAtStart]) {
      await prisma.eddyConversation.updateMany({
        where: { id: p.conversationId, tenantId, userId, status: "active" },
        data: { status: "closed", closedReason: "role_changed" },
      });
      throw new PrincipalRefusal(403, "role_changed", ROLE_CHANGED_MESSAGE);
    }
  }

  return derivePrincipal(p, {
    actor: { userId, tenantId, role: membership.role },
    emailVerified: membership.user?.emailVerifiedAt !== null && membership.user?.emailVerifiedAt !== undefined,
  });
}

async function refreshKey(p: Principal): Promise<Principal> {
  const tenant = await prisma.tenant.findUnique({ where: { id: p.actor.tenantId }, select: { deletedAt: true } });
  if (!tenant || tenant.deletedAt) throw new PrincipalRefusal(403, "role_changed", ACCESS_GONE_MESSAGE);
  const keyId = keyIdOf(p);
  if (keyId) {
    const key = await prisma.apiKey.findFirst({ where: { id: keyId, tenantId: p.actor.tenantId, revokedAt: null }, select: { id: true } });
    if (!key) throw new PrincipalRefusal(401, "signed_out", "This API key was revoked.");
  }
  return p;
}

async function refreshSystem(p: Principal): Promise<Principal> {
  const tenant = await prisma.tenant.findUnique({ where: { id: p.actor.tenantId }, select: { deletedAt: true } });
  if (!tenant || tenant.deletedAt) throw new PrincipalRefusal(403, "role_changed", ACCESS_GONE_MESSAGE);
  return p;
}

/** G4. Throws PrincipalRefusal (403 role_changed, 401 signed_out). */
export async function refreshPrincipal(p: Principal, options: RefreshOptions): Promise<Principal> {
  const now = options.now ?? new Date();
  const key = p.turnId ? `${p.principalId}|${p.turnId}` : null;
  if (!options.fresh && key) {
    const hit = memo.get(key);
    if (hit && now.getTime() - hit.at < READ_MEMO_MS && now.getTime() >= hit.at) {
      return derivePrincipal(p, { actor: hit.principal.actor, emailVerified: hit.principal.emailVerified });
    }
  }
  const fresh = p.via === "eddy" ? await refreshMember(p, now) : p.via === "system" ? await refreshSystem(p) : await refreshKey(p);
  if (key) {
    memo.set(key, { at: now.getTime(), principal: fresh });
    if (memo.size > 5_000) for (const [k, v] of memo) if (now.getTime() - v.at >= READ_MEMO_MS) memo.delete(k);
  }
  return fresh;
}
