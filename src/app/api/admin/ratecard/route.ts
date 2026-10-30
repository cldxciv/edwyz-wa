import { clearRateCard, getRateCard, saveRateCard } from "@/lib/admin/ratecard";
import { handleAdmin, readBody } from "@/lib/admin/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleAdmin(request, false, async () => ({ rateCard: await getRateCard() }), "admin.api.view_ratecard");
}

export async function PUT(request: Request) {
  return handleAdmin(request, true, async ({ actor }) => ({ rateCard: await saveRateCard(actor.userId, await readBody(request)) }));
}

export async function DELETE(request: Request) {
  return handleAdmin(request, true, async ({ actor }) => {
    await clearRateCard(actor.userId);
    return { rateCard: null };
  });
}

export { adminMethodNotAllowed as POST, adminMethodNotAllowed as PATCH, adminMethodNotAllowed as OPTIONS } from "@/lib/admin/http";
