import { getActor } from "@/lib/auth";
import { audit } from "@/lib/auth/audit";
import { noStore, writeActor } from "@/lib/content/http";
import { listMedia, saveUpload } from "@/lib/content/media";
import { errorResponse } from "@/lib/tenancy";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    return Response.json({ media: await listMedia(actor.tenantId) }, { headers: noStore });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Raw body upload: Content-Type is the file type (image/jpeg, image/png, video/mp4, video/quicktime). */
export async function POST(request: Request) {
  try {
    const actor = await writeActor(request);
    const saved = await saveUpload(actor.tenantId, request);
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "content.media.upload", target: saved.key });
    return Response.json(saved, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
