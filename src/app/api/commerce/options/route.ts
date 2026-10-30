import { getActor } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { bodyVariableCount, MAX_TEMPLATE_VARIABLES } from "@/lib/commerce/settings";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET -> { templates: [{ id, name, language, category }], phoneNumbers: [{ id, displayPhone }] }. Approved templates usable for reminders only. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const [templates, phoneNumbers] = await Promise.all([
      prisma.template.findMany({
        where: { tenantId: actor.tenantId, status: "approved" },
        orderBy: { name: "asc" },
        take: 200,
        select: { id: true, name: true, language: true, category: true, components: true },
      }),
      prisma.phoneNumber.findMany({ where: { tenantId: actor.tenantId }, select: { id: true, displayPhone: true }, take: 50 }),
    ]);
    return Response.json({
      templates: templates
        .filter((t) => bodyVariableCount(t.components) <= MAX_TEMPLATE_VARIABLES)
        .map(({ components: _components, ...t }) => t),
      phoneNumbers,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
