import { handleAdmin, readBody } from "@/lib/admin/http";
import { applyTenantAction, getTenantDetail } from "@/lib/admin/tenants";
import { HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleAdmin(
    request,
    false,
    async () => {
      const detail = await getTenantDetail((await params).id);
      if (!detail) throw new HttpError(404, "Workspace not found.");
      return detail;
    },
    "admin.api.view_tenant",
  );
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleAdmin(request, true, async ({ actor }) => applyTenantAction(actor.userId, (await params).id, await readBody(request)));
}

export { adminMethodNotAllowed as PUT, adminMethodNotAllowed as PATCH, adminMethodNotAllowed as DELETE, adminMethodNotAllowed as OPTIONS } from "@/lib/admin/http";
