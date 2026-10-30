import { getActor } from "@/lib/auth";
import { readJsonLimited } from "@/lib/http/body";
import { noStore, writeActor } from "@/lib/content/http";
import { createPost, listPosts, parsePostInput } from "@/lib/content/service";
import { errorResponse } from "@/lib/tenancy";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const params = new URL(request.url).searchParams;
    const posts = await listPosts(actor, { status: params.get("status") || undefined, limit: Number(params.get("limit") ?? 50) || 50 });
    return Response.json({ posts }, { headers: noStore });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await writeActor(request);
    const result = await createPost(actor, parsePostInput(await readJsonLimited(request)));
    return Response.json(result, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
