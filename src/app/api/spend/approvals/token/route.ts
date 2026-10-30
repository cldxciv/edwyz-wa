import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { assertTenantCanWrite } from "@/lib/billing";
import { hashApprovalToken, isApprovalTokenShape } from "@/lib/spend/approval-token";
import { approvalForToken, decideByToken, displayStatus, LINK_NOT_VALID, SIGN_IN_TO_APPROVE, viewByToken, type SessionLike } from "@/lib/spend/approvals";
import { readTextLimited } from "@/lib/http/body";
import { clientIp } from "@/lib/net/ip";
import { createLimiter } from "@/lib/ratelimit";
import { spendErrorResponse, spendJson } from "@/lib/spend/http";
import { HttpError } from "@/lib/tenancy";

/*
 * The one-tap link's API (docs/SPEND-CONTROLS-SPEC.md 7.4): https://wa.edwyz.com/s/<token>.
 *
 * GET  ?token=  what the request is, what it could add this month, why, and the time left. No sign-in needed to look.
 * POST { token, decision: "decline" | "approve" } (JSON, or a plain form post, which is answered with a redirect back to the
 *      page):
 *  - Decline works with the token alone, signed out: declining only lowers risk.
 *  - Approve needs a signed-in approver of that workspace (approving raises spending, so holding the phone is not enough).
 *    Signed out, the answer is 401 with a sign-in link back to the request.
 * Rate limits: 10 decisions per token per hour, 20 per address per 15 minutes; looking is limited per address too. Answers are
 * never cached and send no referrer, so the token does not leak.
 */

const decideTokenLimiter = createLimiter(10, 60 * 60 * 1000, "spend-approve");
const decideIpLimiter = createLimiter(20, 15 * 60 * 1000, "spend-approve-ip");
const viewIpLimiter = createLimiter(120, 5 * 60 * 1000, "spend-approve-view");

const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const TOO_MANY = "Too many attempts. Please wait a few minutes and try again.";

/** The signed-in person, or null when signed out (a decline never needs a session). */
async function optionalSession(request: Request): Promise<SessionLike> {
  try {
    const a = await getActor(request);
    return { userId: a.userId, tenantId: a.tenantId, role: a.role };
  } catch {
    return null;
  }
}

function parseBody(text: string, contentType: string): Record<string, unknown> {
  if (contentType.includes("application/json")) {
    try {
      const v = JSON.parse(text);
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
      throw new HttpError(400, "The request could not be read.");
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

const signInUrl = (approvalId: string) => `/login?next=${encodeURIComponent(`/app/settings/spending?approval=${approvalId}`)}`;

export async function GET(request: Request) {
  try {
    if (!viewIpLimiter.consume(clientIp(request))) throw new HttpError(429, TOO_MANY);
    const token = new URL(request.url).searchParams.get("token") ?? "";
    if (!isApprovalTokenShape(token)) throw new HttpError(404, LINK_NOT_VALID);
    const view = await viewByToken(token, await optionalSession(request));
    if (!view) throw new HttpError(404, LINK_NOT_VALID);
    return spendJson({ ...view, signInUrl: view.needsSignInToApprove ? signInUrl(view.approval.id) : null }, { headers: NO_STORE });
  } catch (e) {
    const res = spendErrorResponse(e);
    for (const [k, v] of Object.entries(NO_STORE)) res.headers.set(k, v);
    return res;
  }
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  const form = !contentType.includes("application/json");
  let token = "";
  try {
    if (!(await decideIpLimiter.consumeShared(clientIp(request)))) throw new HttpError(429, TOO_MANY);
    assertSameOrigin(request);
    const body = parseBody(await readTextLimited(request, 4096), contentType);
    token = typeof body.token === "string" ? body.token : "";
    const decision = body.decision;
    if (decision !== "approve" && decision !== "decline") throw new HttpError(400, "Choose approve or decline.");
    if (!isApprovalTokenShape(token)) throw new HttpError(404, LINK_NOT_VALID);
    if (!(await decideTokenLimiter.consumeShared(hashApprovalToken(token)))) throw new HttpError(429, TOO_MANY);

    let session: SessionLike = null;
    if (decision === "approve") {
      const row = await approvalForToken(token);
      if (!row) throw new HttpError(404, LINK_NOT_VALID);
      session = await optionalSession(request);
      if (!session) return spendJson({ error: SIGN_IN_TO_APPROVE, code: "spend.sign_in", signInUrl: signInUrl(row.id) }, { status: 401, headers: NO_STORE });
      // Approving a raise is a raising operation: the paywall applies to it (4.17); declining never waits on it.
      if (session.tenantId === row.tenantId && row.direction === "raise" && displayStatus(row, new Date()) === "pending") await assertTenantCanWrite(row.tenantId);
    } else {
      session = await optionalSession(request);
    }
    const result = await decideByToken(token, decision, session);
    if (form) return new Response(null, { status: 303, headers: { ...NO_STORE, Location: `/s/${encodeURIComponent(token)}` } });
    return spendJson({ approval: result.approval, status: result.status, text: result.text }, { headers: NO_STORE });
  } catch (e) {
    if (form && token && isApprovalTokenShape(token) && !(e instanceof HttpError && e.status === 429)) {
      return new Response(null, { status: 303, headers: { ...NO_STORE, Location: `/s/${encodeURIComponent(token)}` } });
    }
    const res = spendErrorResponse(e);
    for (const [k, v] of Object.entries(NO_STORE)) res.headers.set(k, v);
    return res;
  }
}
