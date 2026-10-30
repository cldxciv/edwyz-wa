import { handleAdmin } from "@/lib/admin/http";
import { parseAuditParams } from "@/lib/admin/auditParams";
import { listAudit } from "@/lib/admin/queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleAdmin(request, false, async () => listAudit(parseAuditParams(new URL(request.url).searchParams)), "admin.api.view_audit");
}

export { adminMethodNotAllowed as POST, adminMethodNotAllowed as PUT, adminMethodNotAllowed as PATCH, adminMethodNotAllowed as DELETE, adminMethodNotAllowed as OPTIONS } from "@/lib/admin/http";
