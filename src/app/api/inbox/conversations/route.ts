import { getActor } from "@/lib/auth";
import { assertSameOrigin, intParam, readJson } from "@/lib/inbox/http";
import { startChat } from "@/lib/inbox/new-chat";
import { createLimiter } from "@/lib/ratelimit";
import { listConversations } from "@/lib/inbox/service";
import { countUnreadConversations } from "@/lib/inbox/stream";
import { inboxScopeWhere, maskContact, rulesToWhere, searchAllowed, viewerRules } from "@/lib/teams/visibility";
import { errorResponse, HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET ?assigned=me|unassigned|<userId>&team=<teamId>|none&status=&unread=1&expired=1&tag=&q=&view=new|campaign|favorite|mentioned|active&cursor=&limit= -> { items, nextCursor, unreadConversations } */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const p = new URL(request.url).searchParams;
    const assigned = p.get("assigned");
    const assignedTo = assigned === null ? undefined : assigned === "me" ? actor.userId : assigned === "unassigned" ? null : assigned;
    const rules = await viewerRules(actor);
    const search = p.get("q") ?? undefined;
    const result = searchAllowed(search, rules.maskPhone)
      ? await listConversations(actor.tenantId, {
      assignedTo,
      status: p.get("status") ?? undefined,
      unread: p.get("unread") === "1",
      expired: p.get("expired") === "1",
      tag: p.get("tag") ?? undefined,
      search,
      view: p.get("view") ?? undefined,
      viewerId: actor.userId,
      cursor: p.get("cursor") ?? undefined,
      limit: intParam(p.get("limit")),
      scope: await inboxScopeWhere(actor, { team: p.get("team"), rules, search }),
    })
      : { items: [], nextCursor: null };
    result.items = result.items.map((c) => ({ ...c, contact: maskContact(c.contact, rules.maskPhone) }));
    return Response.json({ ...result, unreadConversations: await countUnreadConversations(actor.tenantId, rulesToWhere(actor, rules)) });
  } catch (e) {
    return errorResponse(e);
  }
}

const startLimiter = createLimiter(30, 60_000, "inbox-new-chat");

/**
 * POST { phone | bsuid | contactId, name?, phoneNumberId?, templateId, variables?, confirmOptIn? } -> 201 { conversation: { id, contactId }, message }
 * Starts a chat by sending an approved template. 422 when the contact opted out, or for a marketing template without opt-in.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    if (!startLimiter.consume(`${actor.tenantId}:${actor.userId}`)) throw new HttpError(429, "You are starting chats too quickly. Wait a minute and try again.");
    const result = await startChat(actor, await readJson(request));
    return Response.json(result, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
