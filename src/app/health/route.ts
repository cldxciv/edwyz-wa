import { healthReport } from "./checks";

export const dynamic = "force-dynamic";

/** Liveness plus two numbers worth alerting on: database round trip and age of the last worker activity. No secrets, no versions. */
export async function GET() {
  const report = await healthReport();
  return Response.json(report, { status: report.status === "ok" ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
