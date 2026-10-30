import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { creditsByMemberSince } from "@/lib/eddy/conversations";
import { eddyHistoryDays, parseSettingsUpdate, settingDTO, updateWorkspaceSetting, workspaceSetting, OWNER_ONLY_MESSAGE } from "@/lib/eddy/settings";
import { readJsonLimited } from "@/lib/http/body";
import { errorResponse, HttpError, requireRole } from "@/lib/tenancy";

/**
 * GET /api/eddy/settings -> { setting, historyDays, usageToday }   (admins and the owner: Eddy settings and credits per
 *   member today, never per reply, docs/EDDY-SPEC.md 5.10)
 * PUT /api/eddy/settings { enabled?, consent?, proactiveNotices?, dailyTurnCap? } -> { setting }
 *   OWNER ONLY (12.1a decision 6; an admin gets 403). Eddy is off by default; switching it on stores enabledById, enabledAt
 *   and consentVersion = LEGAL.version (the tap is the AI-processing consent) and is audited. Same origin, and a verified
 *   email wherever verification is enforced: this path is not on the unverified-write list (5.11 critic, 7.1), because it
 *   sends workspace data to Anthropic and starts AI spend.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    if (request.headers.get("origin") !== null) assertSameOrigin(request);
    requireRole(actor, "admin");
    const [setting, historyDays, usage] = await Promise.all([workspaceSetting(actor.tenantId), eddyHistoryDays(), creditsByMemberSince(actor.tenantId, startOfUtcDay(new Date()))]);
    return Response.json({ setting: settingDTO(setting), historyDays, usageToday: usage }, { headers: NO_STORE });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    if (actor.role !== "owner") throw new HttpError(403, OWNER_ONLY_MESSAGE);
    const update = parseSettingsUpdate(await readJsonLimited(request, 4096));
    const setting = await updateWorkspaceSetting(actor, update);
    return Response.json({ setting: settingDTO(setting) }, { headers: NO_STORE });
  } catch (e) {
    return errorResponse(e);
  }
}
