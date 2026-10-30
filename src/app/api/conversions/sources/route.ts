import { getActor } from "@/lib/auth";
import { countConversationsByAdSource, listConversationsByAdSource } from "@/lib/conversions/referral";
import { errorResponse, requireRole } from "@/lib/tenancy";

const parseDate = (value: string | null) => {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d : undefined;
};

/** GET ?sourceId=&sourceType=&from=&to=&limit= (admin or owner) -> { sources: [{ sourceId, sourceType, headline, conversations }], conversations: [...] } */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const q = new URL(request.url).searchParams;
    const filter = {
      sourceId: q.get("sourceId")?.slice(0, 128) || undefined,
      sourceType: q.get("sourceType")?.slice(0, 32) || undefined,
      from: parseDate(q.get("from")),
      to: parseDate(q.get("to")),
      limit: Number(q.get("limit")) || undefined,
    };
    const [sources, conversations] = await Promise.all([countConversationsByAdSource(actor.tenantId, filter), listConversationsByAdSource(actor.tenantId, filter)]);
    return Response.json({ sources, conversations });
  } catch (e) {
    return errorResponse(e);
  }
}
