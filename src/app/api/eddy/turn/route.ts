import { getActor } from "@/lib/auth";
import { ACCESS_COOKIE, readCookie } from "@/lib/auth/cookies";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { verifyAccessToken } from "@/lib/auth/tokens";
import { prisma } from "@/lib/db";
import { parsePageContext, parseTurnRef, verifyPageContext, type PageChecks } from "@/lib/eddy/context-note";
import { TURN_IN_PROGRESS_MESSAGE, visibilityHashOf } from "@/lib/eddy/conversations";
import { tr } from "@/lib/eddy/copy/runtime";
import { prepareTurn, runPrepared, type TurnFactsPort } from "@/lib/eddy/loop";
import { defaultLoopDeps } from "@/lib/eddy/model-binding";
import { recentNoticeFacts } from "@/lib/eddy/settings";
import { sseFrame, sseResponse, SSE_HEADERS } from "@/lib/eddy/sse";
import { readJsonLimited } from "@/lib/http/body";
import { describeError } from "@/lib/safe-error";
import { getSetup } from "@/lib/setup";
import { assertContactVisible, assertConversationVisible, viewerRules } from "@/lib/teams/visibility";
import { errorResponse, HttpError, type Actor } from "@/lib/tenancy";

/**
 * POST /api/eddy/turn { text, page, conversationId?, newChat?, ref? } -> text/event-stream of EddyEvent
 * (docs/EDDY-SPEC.md 5.9, 5.12, EDDY-11). A browser session only (getActor never takes API keys), same origin.
 *
 * - The gate, the limits, the concurrency gauge and the turn lock run before the stream starts: a second turn while one
 *   runs is a 409 JSON answer; any other refusal is an SSE `error` event, so the panel shows it in place.
 * - The stream sends `Cache-Control: no-cache, no-store, no-transform` and `X-Accel-Buffering: no`, a `: ka` comment every
 *   15 s, and ends after 150 s at most; request.signal (Stop, tab closed) aborts the turn, which repairs its tail.
 * - `page` carries ids only, verified here against what the member may see; `ref` (a notice's [Fix with Eddy], a failed
 *   bubble's [Explain]) carries an id only, never a reason or a message body.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BODY_LIMIT = 16 * 1024;
const NO_STORE = { "cache-control": "no-cache, no-store, no-transform" };

/** The access token's session reference, so the action layer re-checks the very session that asked (G4). */
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

const checks: PageChecks = {
  async conversation(actor, id) {
    await assertConversationVisible(actor, id);
    const row = await prisma.conversation.findFirst({ where: { id, tenantId: actor.tenantId }, select: { status: true } });
    return { ok: !!row, status: row?.status ?? null };
  },
  async contact(actor, id) {
    await assertContactVisible(actor, id);
    return { ok: !!(await prisma.contact.findFirst({ where: { id, tenantId: actor.tenantId }, select: { id: true } })) };
  },
  async broadcast(actor, id) {
    const row = await prisma.broadcast.findFirst({ where: { id, tenantId: actor.tenantId }, select: { status: true } });
    return { ok: !!row, status: row?.status ?? null };
  },
  async template(actor, id) {
    const row = await prisma.template.findFirst({ where: { id, tenantId: actor.tenantId }, select: { status: true } });
    return { ok: !!row, status: row?.status ?? null };
  },
  async lead(actor, id) {
    const row = await prisma.lead.findFirst({ where: { id, tenantId: actor.tenantId }, select: { status: true } });
    return { ok: !!row, status: row?.status ?? null };
  },
};

/** What the member may see now, as the hash stored on each conversation (5.8 critic). */
async function memberVisibilityHash(actor: Actor): Promise<string> {
  const rules = await viewerRules(actor);
  return visibilityHashOf({ roleClass: actor.role === "agent" ? "agent" : "admin", teamIds: rules.teamIds, includeUnteamed: rules.includeUnteamed, onlyAssigned: rules.onlyAssigned, maskPhone: rules.maskPhone });
}

const facts: TurnFactsPort = {
  verifyPage: (actor, page) => verifyPageContext(actor, page, checks),
  async setup(tenantId) {
    const s = await getSetup(tenantId);
    return { percent: s.summary.percent, nextStepId: s.summary.nextStepId };
  },
  recentNotices: (actor, since) => recentNoticeFacts(actor, since),
  visibilityHash: (actor) => memberVisibilityHash(actor),
  async templateNames(tenantId) {
    const rows = await prisma.template.findMany({ where: { tenantId }, select: { name: true }, take: 500 });
    return rows.map((r) => r.name);
  },
};

/** A refusal before the turn, streamed as one `error` event and an `end`, so the panel renders it like any reply. */
function refusalStream(state: Parameters<typeof sseFrame>[0] & { type: "error" }): Response {
  const body = sseFrame(state) + sseFrame({ type: "end", credits: 0 });
  return new Response(body, { status: 200, headers: { ...SSE_HEADERS } });
}

export async function POST(request: Request) {
  let actor: Actor;
  let body: Record<string, unknown>;
  try {
    actor = await getActor(request);
    assertSameOrigin(request);
    body = await readJsonLimited(request, BODY_LIMIT);
  } catch (e) {
    return errorResponse(e);
  }
  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim()) return Response.json({ error: tr("en", "runtime.empty"), state: "internal" }, { status: 400, headers: NO_STORE });
  try {
    const deps = await defaultLoopDeps(facts);
    const prepared = await prepareTurn(
      {
        actor,
        sessionId: sessionRef(request),
        text,
        page: parsePageContext(body.page),
        newChat: body.newChat === true || body.conversationId === "new",
        ref: parseTurnRef(body.ref),
      },
      deps,
    );
    if (prepared.kind === "conflict") return Response.json({ error: TURN_IN_PROGRESS_MESSAGE, state: "turn_in_progress" }, { status: 409, headers: NO_STORE });
    if (prepared.kind === "refused") {
      if (prepared.httpStatus === 400) return Response.json({ error: tr("en", "runtime.empty"), state: prepared.state }, { status: 400, headers: NO_STORE });
      return refusalStream({ type: "error", state: prepared.state, ...(Object.keys(prepared.params).length ? { params: prepared.params } : {}) });
    }
    return sseResponse(
      async (emit, signal) => {
        await runPrepared(prepared.turn, emit, signal);
      },
      { signal: request.signal },
    );
  } catch (e) {
    if (e instanceof HttpError) return errorResponse(e);
    console.error("[eddy] turn failed:", describeError(e));
    return Response.json({ error: "Something went wrong; nothing was changed.", state: "internal" }, { status: 500, headers: NO_STORE });
  }
}
