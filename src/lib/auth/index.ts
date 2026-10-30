import { assertTenantCanWrite } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { type Actor, HttpError } from "@/lib/tenancy";
import { ACCESS_COOKIE, readCookie } from "./cookies";
import { verifyAccessToken } from "./tokens";
import { assertEmailVerifiedForWrite } from "./verification";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Must keep working when a workspace is locked: signing in and out, switching workspace, and paying.
// /api/actions/ (Eddy's card buttons, docs/EDDY-SPEC.md 5.11, EDDY-08): gate G7 in src/lib/actions/invoke.ts applies the
// paywall per action instead, so a lowering card (stop, pause, cancel) still confirms in a locked workspace and every other
// card still gets 402.
// /api/spend/ (docs/SPEND-CONTROLS-SPEC.md 4.17): lowering a limit or stopping spending must work in every workspace state, so
// each /api/spend/* route calls assertTenantCanWrite itself, only for raising operations (raising a limit, Not set to a number,
// turning spending back on, approving a raise, turning on Meta's limit).
// /api/notices and /api/notices/ (docs/EDDY-SPEC.md 6.7, 6.9, 6.14): a member's own seen, dismissed and mute receipts, and Team
// activity's Turn off, which is a lowering ("Lowering through Eddy is never blocked"). Nothing there turns anything on: turning
// an automation on is a card through /api/actions/, which keeps its per-action paywall.
// /api/eddy/ turn, prefs and conversations (docs/EDDY-SPEC.md 5.11): the turn's own gate answers `locked` with the right
// copy (an agent and an admin are told different things), a member's own Eddy preferences change nothing for anyone else,
// and deleting one's own Eddy history must work in every workspace state. Every write Eddy would make still goes through
// /api/actions/ and its per-action paywall. PUT /api/eddy/settings (switching Eddy on starts AI spend) keeps the paywall.
const PAYWALL_EXEMPT_PREFIXES = ["/api/auth/", "/api/billing/", "/api/actions/", "/api/spend/", "/api/notices/"];
const PAYWALL_EXEMPT_PATHS = new Set(["/api/notices", "/api/eddy/turn", "/api/eddy/prefs", "/api/eddy/conversations"]);
const PAYWALL_EXEMPT_PATTERNS = [/^\/api\/eddy\/conversations\/[A-Za-z0-9_-]{1,64}$/];

/** Whether a write to this path skips the workspace-state check in getActor (see the lists above). */
export function paywallExemptPath(path: string): boolean {
  return PAYWALL_EXEMPT_PATHS.has(path) || PAYWALL_EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix)) || PAYWALL_EXEMPT_PATTERNS.some((re) => re.test(path));
}

function extractToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim() || null;
  return readCookie(request, ACCESS_COOKIE);
}

function pathOf(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "";
  }
}

/** Locked (unpaid) and suspended workspaces are read-only: every write, from the app or the API, goes through the billing check. */
async function enforceWorkspaceState(actor: Actor, request: Request): Promise<void> {
  if (READ_METHODS.has(request.method)) return;
  const path = pathOf(request);
  if (paywallExemptPath(path)) return;
  await assertTenantCanWrite(actor.tenantId);
}

/**
 * The role in the token is never trusted: membership, the user and the workspace are re-read on every call.
 * API keys (wak_) are not accepted here: they work only on routes that authenticate keys themselves (v1, compat, MCP),
 * where scope and rate limit are enforced.
 */
export async function getActor(request: Request): Promise<Actor> {
  const token = extractToken(request);
  const claims = token ? verifyAccessToken(token) : null;
  if (!claims) throw new HttpError(401, "Not signed in.");
  const membership = await prisma.membership.findUnique({
    where: { tenantId_userId: { tenantId: claims.tid, userId: claims.sub } },
    include: {
      user: {
        select: {
          disabledAt: true,
          emailVerifiedAt: true,
          // The token is only good while the session that minted it is live, so logout and password reset end it at once.
          // Refresh rotation marks the old session revoked a minute ahead (see rotateRefreshToken), so requests already in flight (other tabs, prefetches) are not signed out by it.
          ...(claims.sid
            ? {
                sessions: {
                  where: {
                    refreshTokenHash: claims.sid,
                    OR: [{ revokedAt: null }, { revokedAt: { gt: new Date() } }],
                    expiresAt: { gt: new Date() },
                  },
                  select: { id: true },
                  take: 1,
                },
              }
            : {}),
        },
      },
      tenant: { select: { deletedAt: true } },
    },
  });
  if (!membership || membership.user?.disabledAt || membership.tenant?.deletedAt) throw new HttpError(401, "Not signed in.");
  if (claims.sid && !(membership.user as { sessions?: unknown[] } | null)?.sessions?.length) throw new HttpError(401, "Not signed in.");

  const actor: Actor = { userId: membership.userId, tenantId: membership.tenantId, role: membership.role };
  if (!READ_METHODS.has(request.method)) assertEmailVerifiedForWrite(membership.user?.emailVerifiedAt, pathOf(request));
  await enforceWorkspaceState(actor, request);
  return actor;
}
