import { handleAdminIdentity } from "@/lib/admin/identityRoute";
import { str } from "@/lib/admin/http";
import { confirmEnrollment } from "@/lib/admin/security";
import { stepUpCookie } from "@/lib/admin/stepup";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleAdminIdentity(request, async (id, body) => {
    const result = await confirmEnrollment(id.userId, str(body, "code", "Code", 12));
    return Response.json(result, { headers: { "cache-control": "no-store", "set-cookie": stepUpCookie(id.userId) } });
  });
}

export { adminMethodNotAllowed as GET, adminMethodNotAllowed as HEAD, adminMethodNotAllowed as PUT, adminMethodNotAllowed as PATCH, adminMethodNotAllowed as DELETE, adminMethodNotAllowed as OPTIONS } from "@/lib/admin/http";
