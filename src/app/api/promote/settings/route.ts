import { refuseCrossSite } from "@/lib/promote/geo";
import { promoteRoute } from "@/lib/promote/route-guard";
import { getPromoteSettings, setPromoteSettings } from "@/lib/promote/settings";
import { HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/**
 * GET /api/promote/settings (get_promote_settings; docs/IG-PAGE-ADS-SPEC.md 3.5, 5.4): { settings: {privacyUrl, shop, welcome,
 * preferredGoal} }. Admins and owners; another site's page may not read it.
 */
export const GET = promoteRoute(
  "read",
  async ({ actor }, request) => {
    refuseCrossSite(request);
    return Response.json({ settings: await getPromoteSettings(actor.tenantId) }, { headers: noStore });
  },
  { minRole: "admin" },
);

/**
 * PUT /api/promote/settings (set_promote_settings, undoable) { privacyUrl?, shop?, welcome?, preferredGoal? }: each key given
 * replaces the saved one (null clears it). The privacy link is the business's own and must be https (D13); a PIN code is 6
 * digits. Answers { settings, before } (Undo saves `before` back). Admins and owners, same origin; agents get 403.
 */
export const PUT = promoteRoute("write", async ({ actor }, request) => {
  const body = (await request.json().catch(() => undefined)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Send the settings as an object.");
  const before = await getPromoteSettings(actor.tenantId);
  const settings = await setPromoteSettings(actor.tenantId, body);
  return Response.json({ settings, before }, { headers: noStore });
});
