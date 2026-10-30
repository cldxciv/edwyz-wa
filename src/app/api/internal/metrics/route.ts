import { safeEqual } from "@/lib/meta";
import { errorResponse } from "@/lib/tenancy";
import { collectMetrics } from "./collect";

export const dynamic = "force-dynamic";

/**
 * Queue depths by queue and status, oldest due job age, failed counts and last periodic runs. Same guard as the tick route:
 *   curl -fsS -H "x-worker-secret: $WORKER_SECRET" http://127.0.0.1:3500/api/internal/metrics
 */
export async function GET(request: Request) {
  const secret = process.env.WORKER_SECRET;
  const given = request.headers.get("x-worker-secret");
  if (!secret || !given || !safeEqual(given, secret)) {
    return Response.json({ error: "Forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  try {
    return Response.json(await collectMetrics(), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
