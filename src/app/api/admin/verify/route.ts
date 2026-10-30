import { handleAdminIdentity } from "@/lib/admin/identityRoute";
import { str } from "@/lib/admin/http";
import { verifyStepUpCode } from "@/lib/admin/security";
import { stepUpCookie } from "@/lib/admin/stepup";
import { HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleAdminIdentity(request, async (id, body) => {
    if (!id.totpEnabled) throw new HttpError(409, "Set up two-factor authentication first.");
    const code = str(body, "code", "Code", 12, false);
    const recoveryCode = str(body, "recoveryCode", "Recovery code", 20, false);
    if (!code && !recoveryCode) throw new HttpError(400, "Enter a code.");
    await verifyStepUpCode(id.userId, { code, recoveryCode });
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store", "set-cookie": stepUpCookie(id.userId) } });
  });
}

export { adminMethodNotAllowed as GET, adminMethodNotAllowed as HEAD, adminMethodNotAllowed as PUT, adminMethodNotAllowed as PATCH, adminMethodNotAllowed as DELETE, adminMethodNotAllowed as OPTIONS } from "@/lib/admin/http";
