import { getActor } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { reminderSupportReason } from "@/lib/commerce/settings";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

const HIDDEN_SHOWN = 20;

/**
 * GET -> { templates: [{ id, name, language, category }], hidden: [{ id, name, language, reason }], phoneNumbers: [{ id, displayPhone }] }.
 * templates are the approved ones a reminder can fill in; hidden are approved ones it cannot, with the reason, so the merchant knows
 * why a template is missing. One unusual template never breaks the list.
 */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const [rows, phoneNumbers] = await Promise.all([
      prisma.template.findMany({
        where: { tenantId: actor.tenantId, status: "approved" },
        orderBy: { name: "asc" },
        take: 200,
        select: { id: true, name: true, language: true, category: true, components: true },
      }),
      prisma.phoneNumber.findMany({ where: { tenantId: actor.tenantId }, select: { id: true, displayPhone: true }, take: 50 }),
    ]);
    const templates: { id: string; name: string; language: string; category: string }[] = [];
    const hidden: { id: string; name: string; language: string; reason: string }[] = [];
    for (const { components, ...t } of rows) {
      const reason = reminderSupportReason(components);
      if (!reason) templates.push(t);
      else if (hidden.length < HIDDEN_SHOWN) hidden.push({ id: t.id, name: t.name, language: t.language, reason });
    }
    return Response.json({ templates, hidden, phoneNumbers });
  } catch (e) {
    return errorResponse(e);
  }
}
