import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readJsonObject } from "@/lib/contacts/http";
import { createLimiter } from "@/lib/ratelimit";
import { createTemplate, listTemplates } from "@/lib/templates/service";
import { HttpError, errorResponse, requireRole } from "@/lib/tenancy";

/** Each new template can go to Meta for review, so a workspace creates (or imports) at most 20 an hour, shared by all servers. */
const TEMPLATE_CREATE_PER_HOUR = 20;
const createLimiterPerTenant = createLimiter(TEMPLATE_CREATE_PER_HOUR, 60 * 60_000, "template-create");

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const status = new URL(request.url).searchParams.get("status") ?? undefined;
    return Response.json({ templates: await listTemplates(actor, { status }) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    if (!(await createLimiterPerTenant.consumeShared(actor.tenantId))) {
      throw new HttpError(429, `Your workspace created ${TEMPLATE_CREATE_PER_HOUR} templates in the last hour. Wait a while, then try again.`);
    }
    const template = await createTemplate(actor, await readJsonObject(request));
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "template.created", target: template.id });
    return Response.json({ template }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
