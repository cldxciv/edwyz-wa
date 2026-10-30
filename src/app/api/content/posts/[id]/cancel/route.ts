import { writeActor } from "@/lib/content/http";
import { cancelPost } from "@/lib/content/service";
import { errorResponse } from "@/lib/tenancy";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await writeActor(request);
    return Response.json({ post: await cancelPost(actor, (await params).id) });
  } catch (e) {
    return errorResponse(e);
  }
}
