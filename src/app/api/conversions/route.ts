import { getActor } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getConversionSettings } from "@/lib/conversions/settings";
import { errorResponse, requireRole } from "@/lib/tenancy";

const STATUSES = new Set(["pending", "sent", "failed", "skipped"]);

/** GET ?status=&limit= (admin or owner) -> { events: [{ id, eventName, eventTime, status, attempts, leadId, contactId, reason, createdAt }], counts, settings } */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
    const where = { tenantId: actor.tenantId, ...(status && STATUSES.has(status) ? { status } : {}) };
    const [rows, grouped, settings] = await Promise.all([
      prisma.conversionEvent.findMany({ where, orderBy: { createdAt: "desc" }, take: limit }),
      prisma.conversionEvent.groupBy({ by: ["status"], where: { tenantId: actor.tenantId }, _count: { _all: true } }),
      getConversionSettings(actor.tenantId),
    ]);
    const events = rows.map((r) => {
      const response = (r.response ?? {}) as { reason?: string; error?: string };
      return {
        id: r.id,
        eventName: r.eventName,
        eventTime: r.eventTime,
        status: r.status,
        attempts: r.attempts,
        leadId: r.leadId,
        contactId: r.contactId,
        reason: response.reason ?? response.error ?? null,
        createdAt: r.createdAt,
      };
    });
    const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
    return Response.json({ events, counts, settings });
  } catch (e) {
    return errorResponse(e);
  }
}
