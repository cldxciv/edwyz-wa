import { handleAdmin } from "@/lib/admin/http";
import { listPayments } from "@/lib/admin/queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleAdmin(request, false, async () => listPayments(), "admin.api.view_payments");
}

export { adminMethodNotAllowed as POST, adminMethodNotAllowed as PUT, adminMethodNotAllowed as PATCH, adminMethodNotAllowed as DELETE, adminMethodNotAllowed as OPTIONS } from "@/lib/admin/http";
