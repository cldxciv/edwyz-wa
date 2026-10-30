import { getActor } from "@/lib/auth";
import { spendErrorResponse, spendJson } from "@/lib/spend/http";
import { spendBanners, spendSummary } from "@/lib/spend/summary";

/*
 * GET /api/spend/summary (docs/SPEND-CONTROLS-SPEC.md 8.1, 8.4; WP-16). Every member, in every workspace state: no Meta
 * connection, no WhatsApp number, the demo workspace, locked and suspended. A missing SpendControl row is created with its
 * safe defaults on this first read. What each role gets is decided in src/lib/spend/summary.ts: team members get totals,
 * limits and states, never activity rows or the approvals list.
 *
 * ?view=banner answers only the AppShell banner (8.2), which every page asks for, without the ads maths.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const view = new URL(request.url).searchParams.get("view");
    if (view === "banner") return spendJson(await spendBanners(actor), { headers: { "Cache-Control": "no-store" } });
    return spendJson({ summary: await spendSummary(actor) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return spendErrorResponse(e);
  }
}
