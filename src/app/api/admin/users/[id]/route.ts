import { handleAdmin, readBody } from "@/lib/admin/http";
import { applyUserAction } from "@/lib/admin/users";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleAdmin(request, true, async ({ actor }) => applyUserAction(actor.userId, (await params).id, await readBody(request)));
}

export { adminMethodNotAllowed as GET, adminMethodNotAllowed as HEAD, adminMethodNotAllowed as PUT, adminMethodNotAllowed as PATCH, adminMethodNotAllowed as DELETE, adminMethodNotAllowed as OPTIONS } from "@/lib/admin/http";
