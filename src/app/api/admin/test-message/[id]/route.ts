import { handleAdmin } from "@/lib/admin/http";
import { getTestMessageStatus } from "@/lib/admin/service";
import { HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** Polled by the admin test-message panel. Not audited: one send polls it up to 15 times, and the POST already records the attempt. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleAdmin(request, false, async ({ actor }) => {
    const { id } = await params;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpError(404, "Not found.");
    return getTestMessageStatus(actor.userId, id);
  });
}

export { adminMethodNotAllowed as POST, adminMethodNotAllowed as HEAD, adminMethodNotAllowed as PUT, adminMethodNotAllowed as PATCH, adminMethodNotAllowed as DELETE, adminMethodNotAllowed as OPTIONS } from "@/lib/admin/http";
