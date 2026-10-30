import { handleAdmin, readBody } from "@/lib/admin/http";
import { applyPlanAction, updatePlan } from "@/lib/admin/plans";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleAdmin(request, true, async ({ actor }) => updatePlan(actor.userId, (await params).id, await readBody(request)));
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleAdmin(request, true, async ({ actor }) => applyPlanAction(actor.userId, (await params).id, await readBody(request)));
}

export { adminMethodNotAllowed as GET, adminMethodNotAllowed as HEAD, adminMethodNotAllowed as PUT, adminMethodNotAllowed as DELETE, adminMethodNotAllowed as OPTIONS } from "@/lib/admin/http";
