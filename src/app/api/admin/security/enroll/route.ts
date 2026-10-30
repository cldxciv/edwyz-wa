import { handleAdminIdentity } from "@/lib/admin/identityRoute";
import { startEnrollment } from "@/lib/admin/security";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleAdminIdentity(request, async (id) => {
    const result = await startEnrollment(id.userId, id.email);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  });
}

export { adminMethodNotAllowed as GET, adminMethodNotAllowed as HEAD, adminMethodNotAllowed as PUT, adminMethodNotAllowed as PATCH, adminMethodNotAllowed as DELETE, adminMethodNotAllowed as OPTIONS } from "@/lib/admin/http";
