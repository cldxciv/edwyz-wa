import { siteUrl } from "@/lib/config";
import { parseSignedRequest } from "@/lib/meta";
import { readTextLimited } from "@/lib/http/body";
import { recordDeletionRequest } from "@/lib/storage";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/**
 * Meta data-deletion callback: verifies signed_request, records the request, returns the status URL and a confirmation code.
 * The erasure of that Facebook user's workspace connections starts in the background and is retried by the worker sweep.
 */
export async function POST(request: Request) {
  const raw = await readTextLimited(request, 16 * 1024).catch(() => null);
  const form = raw === null ? null : await new Response(raw, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData().catch(() => null);
  const signedRequest = form?.get("signed_request");
  if (typeof signedRequest !== "string") return Response.json({ error: "signed_request is required" }, { status: 400, headers: noStore });

  const payload = parseSignedRequest(signedRequest, process.env.META_APP_SECRET);
  const userId = payload?.user_id;
  if (!payload || typeof userId !== "string") return Response.json({ error: "invalid signed_request" }, { status: 400, headers: noStore });

  let code: string;
  try {
    code = await recordDeletionRequest(userId);
  } catch {
    return Response.json({ error: "temporarily unavailable" }, { status: 503, headers: noStore });
  }

  void import("@/lib/lifecycle/deletion-requests").then((m) => m.processDeletionRequest(code)).catch(() => undefined);

  return Response.json({ url: `${siteUrl()}/data-deletion/status?code=${code}`, confirmation_code: code }, { headers: noStore });
}
