import { verifySignature } from "@/lib/content/media";
import { serveMedia } from "@/lib/content/serve";

/** Public on purpose: Meta fetches media from here. Access is only by an unexpired HMAC signature over tenant, file and expiry. */
export async function GET(request: Request, { params }: { params: Promise<{ tenantId: string; file: string }> }) {
  const { tenantId, file } = await params;
  const q = new URL(request.url).searchParams;
  let valid = false;
  try {
    valid = verifySignature(tenantId, file, q.get("exp"), q.get("sig"));
  } catch {
    valid = false;
  }
  if (!valid) return new Response("Not found", { status: 404 });
  return serveMedia(request, tenantId, file, "private, max-age=60");
}
