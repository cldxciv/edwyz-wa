import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { createBroadcast, listBroadcasts } from "@/lib/broadcasts/service";
import { parseIsoDate, parseRetryDays } from "@/lib/broadcasts/schedule";
import { optionalString, readJsonObject, stringArray } from "@/lib/contacts/http";
import { HttpError, errorResponse, requireRole } from "@/lib/tenancy";

function parseAudience(raw: unknown): { segmentId?: string; filter?: unknown } | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "The audience is not valid.");
  const { segmentId, filter } = raw as { segmentId?: unknown; filter?: unknown };
  if (segmentId !== undefined && segmentId !== null && (typeof segmentId !== "string" || segmentId.length > 100)) throw new HttpError(400, "The segment is not valid.");
  return { segmentId: typeof segmentId === "string" && segmentId ? segmentId : undefined, filter };
}

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const params = new URL(request.url).searchParams;
    return Response.json(await listBroadcasts(actor, { cursor: params.get("cursor") ?? undefined }));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonObject(request);
    const name = optionalString(body.name, "name", 120);
    const phoneNumberId = optionalString(body.phoneNumberId, "phoneNumberId", 100);
    const templateId = optionalString(body.templateId, "templateId", 100);
    if (!name || !phoneNumberId || !templateId) throw new HttpError(400, "name, phoneNumberId and templateId are required.");
    const scheduledAt = body.scheduledAt === undefined || body.scheduledAt === null ? null : parseIsoDate(body.scheduledAt, "scheduledAt");
    const broadcast = await createBroadcast(actor, {
      name,
      phoneNumberId,
      templateId,
      segmentTags: stringArray(body.segmentTags, "segmentTags"),
      scheduledAt,
      retryDays: parseRetryDays(body.retryDays),
      audience: parseAudience(body.audience),
      variableMap: body.variableMap,
      missingValuePolicy: body.missingValuePolicy,
    });
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "broadcast.created", target: broadcast.id });
    return Response.json({ broadcast }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
