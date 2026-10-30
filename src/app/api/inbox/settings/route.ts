import { audit } from "@/lib/auth/audit";
import { getActor } from "@/lib/auth";
import { assertSameOrigin, readJson } from "@/lib/inbox/http";
import { getInboxSettings, parseSettingsPatch, updateInboxSettings } from "@/lib/inbox/settings";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET -> { settings: { agentSignature, optOutReply, optInReply } } (any member) */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    return Response.json({ settings: await getInboxSettings(actor.tenantId) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** PUT { agentSignature?: boolean, optOutReply?: string, optInReply?: string } -> { settings } (admin). Empty reply text turns that confirmation off. */
export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const patch = parseSettingsPatch(await readJson(request));
    const settings = await updateInboxSettings(actor.tenantId, patch);
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "inbox.settings.updated", meta: { fields: Object.keys(patch).join(",") } });
    return Response.json({ settings });
  } catch (e) {
    return errorResponse(e);
  }
}
