import { getActor } from "@/lib/auth";
import { assertConversationVisible } from "@/lib/teams/visibility";
import { assertSameOrigin, readJson, reqString } from "@/lib/inbox/http";
import { addNote, listNotes } from "@/lib/inbox/service";
import { assertCanActOnConversation } from "@/lib/inbox/status";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET -> { notes } newest first */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor(request);
    await assertConversationVisible(actor, (await params).id);
    return Response.json({ notes: await listNotes(actor.tenantId, (await params).id) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST { body } -> 201 { note } */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const body = await readJson(request);
    await assertConversationVisible(actor, (await params).id);
    await assertCanActOnConversation(actor, (await params).id);
    const note = await addNote(actor.tenantId, (await params).id, actor.userId, reqString(body, "body", 4000));
    return Response.json({ note }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
