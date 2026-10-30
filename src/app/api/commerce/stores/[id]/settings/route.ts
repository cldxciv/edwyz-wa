import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { getSettings, saveSettings } from "@/lib/commerce/settings";
import { getStore } from "@/lib/commerce/stores";
import { readJsonLimited } from "@/lib/http/body";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET -> { settings: { enabled, templateId, phoneNumberId, cartGapsMin, checkoutGapsMin } } */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const actor = await getActor(request);
    const { id } = await params;
    await getStore(actor.tenantId, id);
    return Response.json({ settings: await getSettings(actor.tenantId, id) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** PUT any subset of the settings fields (admin or owner) -> { settings }. Gaps are 3 minute values: first reminder after the event, then after the previous one. */
export async function PUT(request: Request, { params }: Ctx) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const { id } = await params;
    await getStore(actor.tenantId, id);
    return Response.json({ settings: await saveSettings(actor.tenantId, id, await readJsonLimited(request, 8 * 1024)) });
  } catch (e) {
    return errorResponse(e);
  }
}
