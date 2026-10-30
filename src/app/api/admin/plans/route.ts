import { handleAdmin, readBody } from "@/lib/admin/http";
import { createPlan, listPlans } from "@/lib/admin/plans";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleAdmin(request, false, async () => ({ plans: await listPlans() }), "admin.api.list_plans");
}

export async function POST(request: Request) {
  return handleAdmin(request, true, async ({ actor }) => createPlan(actor.userId, await readBody(request)));
}

export { adminMethodNotAllowed as PUT, adminMethodNotAllowed as PATCH, adminMethodNotAllowed as DELETE, adminMethodNotAllowed as OPTIONS } from "@/lib/admin/http";
