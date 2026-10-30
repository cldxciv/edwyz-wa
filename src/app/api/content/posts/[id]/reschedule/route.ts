import { readJsonLimited } from "@/lib/http/body";
import { writeActor } from "@/lib/content/http";
import { reschedulePost } from "@/lib/content/service";
import { HttpError, errorResponse } from "@/lib/tenancy";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await writeActor(request);
    const body = await readJsonLimited(request, 4096);
    if (typeof body.scheduledAt !== "string") throw new HttpError(400, "scheduledAt is required.");
    return Response.json({ post: await reschedulePost(actor, (await params).id, body.scheduledAt) });
  } catch (e) {
    return errorResponse(e);
  }
}
