import { getActor } from "@/lib/auth";
import { assertSameOrigin, readJson } from "@/lib/inbox/http";
import { setMark } from "@/lib/inbox/marks";
import { assertConversationVisible } from "@/lib/teams/visibility";
import { errorResponse, HttpError } from "@/lib/tenancy";

/**
 * PUT { favorite?: boolean, unread?: boolean } -> { ok: true }
 * Personal markers of the signed-in agent: star the chat, or mark it unread for yourself (opening the chat clears it).
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const { id } = await params;
    const body = await readJson(request);
    const changes = (["favorite", "unread"] as const).flatMap((kind) => {
      const value = body[kind];
      if (value === undefined) return [];
      if (typeof value !== "boolean") throw new HttpError(400, `${kind} must be true or false.`);
      return [{ kind, on: value }];
    });
    if (changes.length === 0) throw new HttpError(400, "Send favorite or unread.");
    await assertConversationVisible(actor, id);
    for (const c of changes) await setMark(actor.tenantId, actor.userId, id, c.kind, c.on);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
