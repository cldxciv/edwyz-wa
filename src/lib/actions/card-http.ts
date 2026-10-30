/**
 * The HTTP side of the card endpoints (docs/EDDY-SPEC.md 4.5, 7.1, 7.8, EDDY-08), shared by
 * src/app/api/actions/[id]/{route,confirm,cancel,revise,refresh,undo}.ts.
 *
 * - Only a human tap reaches these: a session request through getActor() (API keys are never accepted), same origin
 *   for every POST (a GET with an Origin header must be same origin too), and the limiter `actions-confirm`: 30 calls a
 *   minute per member across confirm, cancel, revise, refresh and undo, plus a separate 30 a minute for card-state reads.
 * - The paywall is not applied here: /api/actions/ is in getActor's PAYWALL_EXEMPT_PREFIXES, and gate G7 applies it per
 *   action, so a lowering card confirms in a locked workspace and any other card gets 402.
 * - No route makes a model call; confirm, revise and refresh work when the AI limit is used up.
 */
import type { ActionRecord } from "@/generated/prisma/client";
import { getActor } from "@/lib/auth";
import { ACCESS_COOKIE, readCookie } from "@/lib/auth/cookies";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { verifyAccessToken } from "@/lib/auth/tokens";
import { EDDY_LANGS, type CardState, type EddyLang } from "@/lib/eddy/contract";
import { readJsonLimited } from "@/lib/http/body";
import { createLimiter } from "@/lib/ratelimit";
import { describeError } from "@/lib/safe-error";
import { HttpError, type Actor } from "@/lib/tenancy";
import type { CardOutcome } from "./invoke";
import { eddyPrincipal } from "./principal";
import { findActionRecord } from "./store";
import type { Preview, Principal } from "./types";

/** 7.8: confirm, revise, cancel and undo, 30 a minute per member. */
export const CARD_ROUTE_PER_MIN = 30;
export const CARD_ROUTE_LIMITER = "actions-confirm";
/** Card bodies are small: a nonce, a hash and at most a few edited fields. */
export const CARD_BODY_LIMIT = 32 * 1024;
export const RATE_LIMITED_MESSAGE = "That's a lot of taps in a short time. Wait a minute, then try again.";

// The name is written out as a literal: tests/ratelimit-migration.test.ts reads every createLimiter() call in src for a
// stable, unique name, and it has to equal CARD_ROUTE_LIMITER above.
const limiter = createLimiter(CARD_ROUTE_PER_MIN, 60_000, "actions-confirm");

/** Clears the in-process limiter windows (tests). */
export async function resetCardRouteLimiter(): Promise<void> {
  await limiter.clear();
}

const ID = /^[A-Za-z0-9_:-]{1,64}$/;

/** A GET is a read: it may come without an Origin header, but one that is present must be this site. */
function assertSameOriginIfPresent(request: Request): void {
  if (request.headers.get("origin") !== null) assertSameOrigin(request);
}

/** The access token's session reference, so G4 re-checks that the very session that tapped is still live. */
function sessionRef(request: Request): string | null {
  const auth = request.headers.get("authorization");
  const token = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : readCookie(request, ACCESS_COOKIE);
  if (!token) return null;
  try {
    return verifyAccessToken(token)?.sid ?? null;
  } catch {
    return null;
  }
}

const langOf = (v: unknown): EddyLang => (typeof v === "string" && (EDDY_LANGS as readonly string[]).includes(v) ? (v as EddyLang) : "en");

export type CardRouteContext = { actor: Actor; principal: Principal; actionId: string; body: Record<string, unknown>; now: Date };

/** The card's principal: the session member, outside any turn; invoke.ts takes the conversation from the card itself. */
function principalFor(actor: Actor, request: Request, lang: EddyLang): Principal {
  // emailVerified is re-read by G4 (refreshPrincipal) on every card decision; false here fails safe.
  return eddyPrincipal({ actor, emailVerified: false, conversationId: "", lang, sessionRef: sessionRef(request) });
}

function json(outcome: CardOutcome | Record<string, unknown>, status: number): Response {
  return Response.json(outcome, { status, headers: { "cache-control": "no-store" } });
}

/** Runs one card route: session, origin, limiter, body, then the action-layer call. */
export async function cardRoute(request: Request, params: Promise<{ id: string }>, run: (c: CardRouteContext) => Promise<CardOutcome>): Promise<Response> {
  try {
    const actor = await getActor(request);
    assertSameOrigin(request);
    if (!limiter.consume(`card:${actor.tenantId}:${actor.userId}`)) throw new HttpError(429, RATE_LIMITED_MESSAGE);
    const { id } = await params;
    const body = await readJsonLimited(request, CARD_BODY_LIMIT).catch((e) => {
      if (e instanceof HttpError && e.status === 413) throw e;
      return {} as Record<string, unknown>;
    });
    if (!ID.test(id ?? "")) return json({ status: 404, state: "refused", code: "not_found", message: "This card wasn't found. It may have been used already or belong to someone else." }, 404);
    const outcome = await run({ actor, principal: principalFor(actor, request, langOf(body.lang)), actionId: id, body, now: new Date() });
    return json(outcome, outcome.status);
  } catch (e) {
    if (e instanceof HttpError) return json({ status: e.status, state: "refused", code: codeFor(e.status), message: e.message, error: e.message }, e.status);
    console.error("[actions] card route failed:", describeError(e));
    return json({ status: 500, state: "failed", code: "internal", message: "Something went wrong; nothing was changed.", error: "Something went wrong." }, 500);
  }
}

function codeFor(status: number): string {
  if (status === 401) return "signed_out";
  if (status === 402) return "workspace_locked";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 413) return "too_large";
  if (status === 429) return "rate_limited";
  return "invalid";
}

/** A string field of the body, or "" (invoke.ts turns a missing nonce into 404, never a hint). */
export const bodyString = (body: Record<string, unknown>, key: string): string => (typeof body[key] === "string" ? (body[key] as string) : "");

// ===== GET /api/actions/[id] =====

/** What the browser may know about one of its own cards. Never the nonce (only its hash is stored, and that never leaves). */
export type CardStateDTO = {
  actionId: string;
  action: string;
  state: CardState | "undone" | "refused";
  code: string | null;
  preview: Preview | null;
  previewHash: string | null;
  createdAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  undoUntil: string | null;
  undoneAt: string | null;
  supersededById: string | null;
};

const REFUSED_STATE: Readonly<Record<string, CardState>> = {
  spend_frozen: "spend_frozen",
  spend_not_set_up: "spend_not_set_up",
  needs_approver: "needs_approver",
  demo: "demo",
  not_connected: "not_connected",
  reconnect: "reconnect",
};

/** The card state of a record (8.4), as the card shows it. */
export function cardStateOf(record: Pick<ActionRecord, "status" | "expiresAt" | "undoneAt" | "error">, now: Date): CardStateDTO["state"] {
  switch (record.status) {
    case "pending":
      return record.expiresAt && record.expiresAt.getTime() <= now.getTime() ? "expired" : "pending";
    case "running":
    case "failed":
    case "cancelled":
    case "expired":
    case "unknown":
    case "awaiting_approval":
      return record.status;
    case "done":
      return record.undoneAt ? "undone" : "done";
    case "undone":
      return "undone";
    case "superseded":
      return "changed";
    case "refused":
      return (record.error && REFUSED_STATE[record.error]) || "refused";
    default:
      return "failed";
  }
}

const iso = (d: Date | null | undefined) => (d instanceof Date ? d.toISOString() : null);

export function cardStateDTO(record: ActionRecord, now: Date): CardStateDTO {
  const state = cardStateOf(record, now);
  return {
    actionId: record.id,
    action: record.action,
    state,
    code: state === "failed" || state === "refused" || state in REFUSED_STATE ? (record.error ?? null) : null,
    preview: (record.preview as Preview | null) ?? null,
    previewHash: record.previewHash ?? null,
    createdAt: record.createdAt.toISOString(),
    expiresAt: iso(record.expiresAt),
    decidedAt: iso(record.decidedAt),
    undoUntil: iso(record.undoUntil),
    undoneAt: iso(record.undoneAt),
    supersededById: record.supersededById ?? null,
  };
}

/** GET /api/actions/[id]: the member's own card, or 404 (another member's or tenant's card is not found either). */
export async function cardStateRoute(request: Request, params: Promise<{ id: string }>): Promise<Response> {
  try {
    const actor = await getActor(request);
    assertSameOriginIfPresent(request);
    if (!limiter.consume(`read:${actor.tenantId}:${actor.userId}`)) throw new HttpError(429, RATE_LIMITED_MESSAGE);
    const { id } = await params;
    const record = ID.test(id ?? "") ? await findActionRecord(actor.tenantId, id) : null;
    if (!record || record.userId !== actor.userId) return json({ error: "This card wasn't found.", code: "not_found" }, 404);
    return json({ card: cardStateDTO(record, new Date()) }, 200);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: codeFor(e.status) }, e.status);
    console.error("[actions] card state failed:", describeError(e));
    return json({ error: "Something went wrong." }, 500);
  }
}
