import type { Prisma } from "@/generated/prisma/client";
import { getBroadcast } from "@/lib/broadcasts/service";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";
import { iso, pageJson, parsePaging } from "./common";
import type { Handler } from "./runtime";

const RECIPIENT_STATUSES = ["pending", "queued", "sent", "delivered", "read", "failed", "skipped"];

type Row = { id: string; name: string; status: string; templateId: string; scheduledAt: Date | null; startedAt: Date | null; completedAt: Date | null; createdAt: Date };

function deliveryStatus(counts: Record<string, number>) {
  const n = (s: string) => counts[s] ?? 0;
  return {
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    pending: n("pending") + n("queued"),
    sent: n("sent") + n("delivered") + n("read"),
    delivered: n("delivered") + n("read"),
    read: n("read"),
    failed: n("failed"),
    skipped: n("skipped"),
  };
}

const view = (b: Row, counts: Record<string, number>) => ({
  id: b.id,
  name: b.name,
  status: b.status,
  template_id: b.templateId,
  scheduled_at: iso(b.scheduledAt),
  started_at: iso(b.startedAt),
  completed_at: iso(b.completedAt),
  created: iso(b.createdAt),
  delivery_status: deliveryStatus(counts),
});

export const listBroadcasts: Handler = async ({ actor, query }) => {
  const paging = parsePaging(query);
  const where = { tenantId: actor.tenantId };
  const [rows, total] = await Promise.all([
    prisma.broadcast.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: paging.skip, take: paging.take }),
    prisma.broadcast.count({ where }),
  ]);
  const groups = rows.length
    ? await prisma.broadcastRecipient.groupBy({ by: ["broadcastId", "status"], where: { tenantId: actor.tenantId, broadcastId: { in: rows.map((b) => b.id) } }, _count: { _all: true } })
    : [];
  const items = rows.map((b) => {
    const counts: Record<string, number> = {};
    for (const g of groups) if (g.broadcastId === b.id) counts[g.status] = g._count._all;
    return view(b, counts);
  });
  return { json: pageJson("broadcast_list", items, paging, total) };
};

export const getBroadcastHandler: Handler = async ({ actor, params }) => {
  const { broadcast, counts } = await getBroadcast(actor, params.id, { limit: 1 });
  return { json: { broadcast: view(broadcast, counts) } };
};

export const listRecipients: Handler = async ({ actor, params, query }) => {
  const paging = parsePaging(query);
  const owned = await prisma.broadcast.findFirst({ where: { id: params.id, tenantId: actor.tenantId }, select: { id: true } });
  if (!owned) throw new HttpError(404, "Broadcast not found.");
  const status = query.get("status");
  if (status && !RECIPIENT_STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${RECIPIENT_STATUSES.join(", ")}.`);
  const where: Prisma.BroadcastRecipientWhereInput = { tenantId: actor.tenantId, broadcastId: owned.id, ...(status ? { status: status as never } : {}) };
  const [rows, total] = await Promise.all([
    prisma.broadcastRecipient.findMany({ where, orderBy: { id: "asc" }, skip: paging.skip, take: paging.take, include: { contact: { select: { phone: true, bsuid: true, name: true } } } }),
    prisma.broadcastRecipient.count({ where }),
  ]);
  const items = rows.map((r) => ({
    id: r.id,
    contact_id: r.contactId,
    phone_number: r.contact?.phone ?? null,
    bsuid: r.contact?.bsuid ?? null,
    name: r.contact?.name ?? null,
    status: r.status,
    message_id: r.messageId,
    error_code: r.errorCode,
    sent_at: iso(r.sentAt),
    delivered_at: iso(r.deliveredAt),
    read_at: iso(r.readAt),
  }));
  return { json: pageJson("recipient_list", items, paging, total) };
};
