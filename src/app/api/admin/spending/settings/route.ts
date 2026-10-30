import { handleAdmin, readBody } from "@/lib/admin/http";
import { getSpendSettings, updateSpendSettings } from "@/lib/admin/spending";

export const dynamic = "force-dynamic";

/*
 * GET /api/admin/spending/settings: limits for new workspaces, platform ceilings, exchange rates for limits, the notification
 * sender, the default request expiry and Meta's change budget (docs/SPEND-CONTROLS-SPEC.md 8.3).
 * PUT {section: "ceiling" | "fx" | "notifier" | "defaults", reason, ...}: changes one section; ledgered on the platform ledger.
 */
export async function GET(request: Request) {
  return handleAdmin(request, false, async () => getSpendSettings(), "admin.api.spending_settings");
}

export async function PUT(request: Request) {
  return handleAdmin(request, true, async ({ actor }) => updateSpendSettings(actor.userId, await readBody(request)));
}

export { adminMethodNotAllowed as POST, adminMethodNotAllowed as PATCH, adminMethodNotAllowed as DELETE, adminMethodNotAllowed as OPTIONS } from "@/lib/admin/http";
