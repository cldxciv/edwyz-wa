import { handleAdmin } from "@/lib/admin/http";
import { getPlatformMetrics } from "@/lib/admin/queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleAdmin(request, false, async () => getPlatformMetrics(), "admin.api.view_metrics");
}

export { adminMethodNotAllowed as POST, adminMethodNotAllowed as PUT, adminMethodNotAllowed as PATCH, adminMethodNotAllowed as DELETE, adminMethodNotAllowed as OPTIONS } from "@/lib/admin/http";
