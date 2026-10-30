import { hashToken } from "@/lib/auth/tokens";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { readTextLimited } from "@/lib/http/body";
import { clientIp } from "@/lib/net/ip";
import { errorResponse, HttpError } from "@/lib/tenancy";
import { decideApproval, MAX_COMMENT_LENGTH } from "@/lib/approvals";
import { consumeNonce, decideIpLimiter, decideTokenLimiter, isWellFormedToken } from "@/lib/approvals/guards";
import { isDecision } from "@/lib/approvals/types";

const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

function parse(text: string, contentType: string): Record<string, unknown> {
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

/**
 * Public. The path segment is the approval token. Unknown, expired, decided and bad-nonce requests all get the same
 * redirect back to the page, so the response never reveals whether a token exists.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id: token } = await ctx.params;
    const ip = clientIp(request);
    if (!(await decideIpLimiter.consumeShared(ip))) throw new HttpError(429, "Too many attempts. Please wait a few minutes and try again.");
    assertSameOrigin(request);
    const body = parse(await readTextLimited(request, 4096), request.headers.get("content-type") ?? "");
    const decision = body.decision;
    const comment = typeof body.comment === "string" ? body.comment : "";
    const nonce = typeof body.nonce === "string" ? body.nonce : "";
    if (!isDecision(decision) || comment.length > MAX_COMMENT_LENGTH * 2) throw new HttpError(400, "The request could not be read.");

    if (decision === "changes_requested" && !comment.trim()) throw new HttpError(400, "Please describe the changes you would like.");

    const wellFormed = isWellFormedToken(token);
    const tokenHash = wellFormed ? hashToken(token) : "";
    if (wellFormed && !(await decideTokenLimiter.consumeShared(tokenHash))) throw new HttpError(429, "Too many attempts. Please wait a few minutes and try again.");
    const ok = wellFormed && consumeNonce(tokenHash, nonce) ? (await decideApproval(token, decision, comment)).ok : false;

    if (request.headers.get("content-type")?.includes("application/json")) return Response.json({ ok }, { headers: NO_STORE });
    return new Response(null, { status: 303, headers: { ...NO_STORE, Location: `/approve/${encodeURIComponent(token)}` } });
  } catch (e) {
    return errorResponse(e);
  }
}
