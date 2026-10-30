import { getActor } from "@/lib/auth";
import { readJsonLimited } from "@/lib/http/body";
import { noStore, writeActor } from "@/lib/content/http";
import { deletePost, getPost, parsePostInput, updatePost } from "@/lib/content/service";
import { errorResponse } from "@/lib/tenancy";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx) {
  try {
    const actor = await getActor(request);
    return Response.json({ post: await getPost(actor, (await params).id) }, { headers: noStore });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const actor = await writeActor(request);
    const post = await updatePost(actor, (await params).id, parsePostInput(await readJsonLimited(request)));
    return Response.json({ post });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const actor = await writeActor(request);
    await deletePost(actor, (await params).id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
