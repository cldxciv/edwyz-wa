import { getActor } from "@/lib/auth";
import { assertSameOrigin, readJson, reqString } from "@/lib/inbox/http";
import { createQuickReply, listQuickReplies } from "@/lib/inbox/service";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET -> { items } */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    return Response.json({ items: await listQuickReplies(actor.tenantId) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST { shortcut, body } -> 201 { item }. 409 if the shortcut exists. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const input = await readJson(request);
    const item = await createQuickReply(actor.tenantId, { shortcut: reqString(input, "shortcut", 40), body: reqString(input, "body", 4000) });
    return Response.json({ item }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
