import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readTextLimited } from "@/lib/http/body";
import { importContacts, parseExistingContacts } from "@/lib/contacts/import";
import { HttpError, errorResponse, requireRole } from "@/lib/tenancy";

const MAX_BYTES = 2 * 1024 * 1024;

async function readCsv(request: Request): Promise<string> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    const raw = await readTextLimited(request, MAX_BYTES + 4096);
    const form = await new Response(raw, { headers: { "content-type": type } }).formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file === "string") throw new HttpError(400, "Upload the CSV in a form field named file.");
    if (file.size > MAX_BYTES) throw new HttpError(413, "CSV must be 2 MB or smaller.");
    return file.text();
  }
  if (type.includes("text/csv")) return readTextLimited(request, MAX_BYTES);
  throw new HttpError(415, "Send multipart/form-data with a file field or a text/csv body.");
}

/** ?existing=skip leaves people already in the contacts untouched (counted as skipped); without it they are updated from the file. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const existing = parseExistingContacts(new URL(request.url).searchParams.get("existing"));
    const report = await importContacts(actor.tenantId, await readCsv(request), { recordedByUserId: actor.userId, existing });
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "contact.imported", meta: { created: report.created, updated: report.updated, skipped: report.skipped, errors: report.errors.length, existing } });
    return Response.json({ report });
  } catch (e) {
    return errorResponse(e);
  }
}
