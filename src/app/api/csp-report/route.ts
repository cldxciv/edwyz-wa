import { clientIp } from "@/lib/net/ip";
import { createLimiter } from "@/lib/ratelimit";
import { extractDirectives, MAX_REPORT_BYTES, recordCspReport } from "@/lib/security/csp-report";

export const dynamic = "force-dynamic";

const limiter = createLimiter(120, 60_000, "csp-report", { memoryOnly: true });
const noContent = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

/** Public by design (browsers post here without credentials). Stores nothing; only per-directive counts reach the log. */
export async function POST(request: Request) {
  if (!limiter.consume(clientIp(request))) return noContent();
  if (Number(request.headers.get("content-length") ?? 0) > MAX_REPORT_BYTES) return noContent();
  try {
    const text = await request.text();
    if (text.length > MAX_REPORT_BYTES) return noContent();
    recordCspReport(extractDirectives(JSON.parse(text)));
  } catch {
    // malformed report: nothing to count
  }
  return noContent();
}
