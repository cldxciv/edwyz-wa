import { readyReport } from "../checks";

export const dynamic = "force-dynamic";

/** Readiness for deploy verification and load balancers: database answers, core tables exist, migrations are complete. */
export async function GET() {
  const report = await readyReport();
  return Response.json(report, { status: report.status === "ready" ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
