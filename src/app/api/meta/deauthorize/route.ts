import { clientIp } from "@/lib/net/ip";
import { createLimiter } from "@/lib/ratelimit";
import { readTextLimited } from "@/lib/http/body";
import { deauthorizeMetaUser } from "@/lib/meta-connect/deauthorize";
import { parseSignedRequest } from "@/lib/meta";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
/** Public endpoint (Meta posts here with no session), so it is limited per address. In process only: hits must not write rows for anonymous callers. */
const limiter = createLimiter(60, 60_000, "meta-deauthorize", { memoryOnly: true });

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...noStore, ...extra } });

/**
 * Meta "Deauthorize callback URL": a Facebook user removed the app. Meta posts a form with signed_request. This route is public and
 * deliberately has no session and no same-origin check (Meta is the caller); the HMAC-SHA256 signature with META_APP_SECRET is the
 * authentication. Nothing from the payload is stored; the audit rows written by deauthorizeMetaUser carry only workspace and connection ids.
 */
export async function POST(request: Request) {
  if (!limiter.consume(clientIp(request))) return json({ error: "too many requests" }, 429, { "Retry-After": "60" });

  const raw = await readTextLimited(request, 16 * 1024).catch(() => null);
  const form = raw === null ? null : await new Response(raw, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData().catch(() => null);
  const signedRequest = form?.get("signed_request");
  if (typeof signedRequest !== "string") return json({ error: "signed_request is required" }, 400);

  // parseSignedRequest checks the HMAC-SHA256 signature in constant time over base64url input; a payload that names no algorithm is refused here too.
  const payload = parseSignedRequest(signedRequest, process.env.META_APP_SECRET);
  const userId = payload?.user_id;
  if (!payload || String(payload.algorithm ?? "").toUpperCase() !== "HMAC-SHA256" || typeof userId !== "string" || userId.length === 0 || userId.length > 64) {
    return json({ error: "invalid signed_request" }, 400);
  }

  try {
    await deauthorizeMetaUser(userId);
  } catch {
    return json({ error: "temporarily unavailable" }, 503);
  }
  return json({ ok: true });
}

const notAllowed = () => json({ error: "method not allowed" }, 405, { Allow: "POST" });
export const GET = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
