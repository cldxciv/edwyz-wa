import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { getTriggerUsage } from "@/lib/automation/v2/metering";
import { getAutomationSettings, isHolidayActive, updateAutomationSettings } from "@/lib/automation/v2/settings";
import { readJsonLimited } from "@/lib/http/body";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET -> { settings: { mode, holiday }, usage: { used, limit, percent, resetsOn }, holidayRunning }. holidayRunning is false when holiday mode is on but has no message or its last day has passed. Any member can read. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const [settings, usage] = await Promise.all([getAutomationSettings(actor.tenantId), getTriggerUsage(actor.tenantId)]);
    return Response.json({ settings, usage, holidayRunning: isHolidayActive(settings.holiday) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** PATCH { mode?, holiday?: { enabled?, message?, endsOn?, timezone? } } (admin or owner) -> { settings } */
export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json({ settings: await updateAutomationSettings(actor.tenantId, await readJsonLimited(request, 8 * 1024)) });
  } catch (e) {
    return errorResponse(e);
  }
}
