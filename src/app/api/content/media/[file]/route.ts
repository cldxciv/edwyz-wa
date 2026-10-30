import { getActor } from "@/lib/auth";
import { audit } from "@/lib/auth/audit";
import { writeActor } from "@/lib/content/http";
import { MEDIA_KEY_PATTERN } from "@/lib/content/limits";
import { deleteMedia } from "@/lib/content/media";
import { mediaInUse } from "@/lib/content/service";
import { serveMedia } from "@/lib/content/serve";
import { errorResponse, HttpError } from "@/lib/tenancy";

export async function GET(request: Request, { params }: { params: Promise<{ file: string }> }) {
  try {
    const actor = await getActor(request);
    return await serveMedia(request, actor.tenantId, (await params).file, "private, max-age=300");
  } catch (e) {
    return errorResponse(e);
  }
}

/** Admin or owner. Refuses files that a draft, scheduled or publishing post still uses. */
export async function DELETE(request: Request, { params }: { params: Promise<{ file: string }> }) {
  try {
    const actor = await writeActor(request);
    const key = (await params).file;
    if (!MEDIA_KEY_PATTERN.test(key)) throw new HttpError(404, "File not found.");
    if (await mediaInUse(actor.tenantId, key)) throw new HttpError(409, "This file is attached to a draft or scheduled post. Remove it from the post first.");
    if (!(await deleteMedia(actor.tenantId, key))) throw new HttpError(404, "File not found.");
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "content.media.delete", target: key });
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
