import { audit } from "@/lib/auth/audit";
import { consentRecordedBy } from "@/lib/contacts/consent";
import { prisma } from "@/lib/db";
import { BOM, csvRow } from "./csv";
import type { ReportRange } from "./range";
import { rate } from "./stats";

export const PAGE_SIZE = 1000;
export const MAX_EXPORT_ROWS = 200_000;

type Page<T> = (cursor: string | undefined, take: number) => Promise<T[]>;
const encoder = new TextEncoder();

/** Cursor pagination by id, always scoped by the caller's where clause. */
export const pageArgs = (cursor: string | undefined, take: number) => ({
  orderBy: { id: "asc" as const },
  take,
  ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
});

export const TRUNCATION_NOTE = `This export stopped at ${MAX_EXPORT_ROWS} rows and is not complete. Narrow the date range or ask support for a full copy.`;

/**
 * Streams rows in pages of 1000, never more than maxRows. onDone runs once at the end with the row count and whether the cap cut the
 * export short, and also when the reader goes away mid-download (aborted = true), so the audit trail records every export that started.
 * A cut-short export says so inside the file through truncatedSuffix; it is never silent.
 */
export function streamRows<T extends { id: string }>(opts: {
  prefix: string;
  suffix?: string;
  /** Written before the suffix when the cap cut the export short. */
  truncatedSuffix?: string;
  fetchPage: Page<T>;
  format: (item: T) => string;
  maxRows?: number;
  onDone?: (rows: number, truncated: boolean, aborted?: boolean) => Promise<void>;
}): ReadableStream<Uint8Array> {
  const maxRows = opts.maxRows ?? MAX_EXPORT_ROWS;
  let cursor: string | undefined;
  let rows = 0;
  let started = false;
  let finished = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        let out = started ? "" : opts.prefix;
        started = true;
        const take = Math.min(PAGE_SIZE, maxRows - rows);
        const page = take > 0 ? await opts.fetchPage(cursor, take) : [];
        for (const item of page) out += opts.format(item);
        rows += page.length;
        cursor = page.at(-1)?.id;
        const done = page.length < take || rows >= maxRows;
        if (done) {
          // Exactly maxRows rows is a complete export; only a further row beyond the cap makes it truncated.
          const truncated = rows >= maxRows && page.length === take && (await opts.fetchPage(cursor, 1)).length > 0;
          if (truncated && opts.truncatedSuffix) out += opts.truncatedSuffix;
          out += opts.suffix ?? "";
          if (out) controller.enqueue(encoder.encode(out));
          finished = true;
          await opts.onDone?.(rows, truncated);
          controller.close();
        } else if (out) controller.enqueue(encoder.encode(out));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      if (finished) return;
      finished = true;
      try {
        await opts.onDone?.(rows, false, true);
      } catch {
        console.warn("[export] could not record an abandoned export");
      }
    },
  });
}

export function csvStream<T extends { id: string }>(opts: {
  headers: string[];
  fetchPage: Page<T>;
  toRow: (item: T) => unknown[];
  maxRows?: number;
  onDone?: (rows: number, truncated: boolean, aborted?: boolean) => Promise<void>;
}) {
  return streamRows<T>({
    prefix: BOM + csvRow(opts.headers),
    truncatedSuffix: csvRow([`# ${TRUNCATION_NOTE}`]),
    fetchPage: opts.fetchPage,
    format: (item) => csvRow(opts.toRow(item)),
    maxRows: opts.maxRows,
    onDone: opts.onDone,
  });
}

export const wantsJson = (request: Request): boolean => new URL(request.url).searchParams.get("format") === "json";

export function download(stream: ReadableStream<Uint8Array>, filename: string, contentType: string): Response {
  return new Response(stream, {
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

type ExportActor = { tenantId: string; userId: string };

const auditDone = (actor: ExportActor, action: string, extra: Record<string, string | number | boolean | null> = {}) => async (rows: number, truncated: boolean, aborted = false) =>
  audit({ tenantId: actor.tenantId, userId: actor.userId, action, meta: { rows, truncated, ...(aborted ? { aborted: true } : {}), ...extra } });

const day = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * JSON array of records, streamed in pages like the CSV exports. The same caps and audit rows apply.
 */
export function jsonStream<T extends { id: string }>(opts: {
  fetchPage: Page<T>;
  toRecord: (item: T) => unknown;
  maxRows?: number;
  onDone?: (rows: number, truncated: boolean, aborted?: boolean) => Promise<void>;
}) {
  let count = 0;
  return streamRows<T>({
    prefix: "[",
    suffix: "]",
    truncatedSuffix: "," + JSON.stringify({ _truncated: true, _note: TRUNCATION_NOTE }),
    fetchPage: opts.fetchPage,
    format: (item) => (count++ > 0 ? "," : "") + JSON.stringify(opts.toRecord(item)),
    maxRows: opts.maxRows,
    onDone: opts.onDone,
  });
}

const contactPage = (actor: ExportActor) => async (cursor: string | undefined, take: number) => {
  const rows = await prisma.contact.findMany({ where: { tenantId: actor.tenantId }, ...pageArgs(cursor, take) });
  const who = await consentRecordedBy(actor.tenantId, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, recordedBy: who.get(r.id) ?? null }));
};

export function contactsJson(actor: ExportActor) {
  return jsonStream({ fetchPage: contactPage(actor), toRecord: (c) => c, onDone: auditDone(actor, "export.contacts", { format: "json" }) });
}

export function contactsCsv(actor: ExportActor) {
  return csvStream({
    headers: ["phone", "name", "username", "bsuid", "tags", "opt_in", "opt_in_source", "opt_in_at", "opted_out_at", "created_at", "attributes", "opt_in_recorded_by"],
    fetchPage: contactPage(actor),
    toRow: (c) => [c.phone, c.name, c.username, c.bsuid, c.tags.join(";"), c.optIn ? "yes" : "no", c.optInSource, day(c.optInAt), day(c.optedOutAt), day(c.createdAt), c.attributes, c.recordedBy],
    onDone: auditDone(actor, "export.contacts"),
  });
}

export function messagesJson(actor: ExportActor, range: ReportRange) {
  const where = { tenantId: actor.tenantId, createdAt: { gte: range.start, lt: range.end } };
  return jsonStream({
    fetchPage: (cursor, take) => prisma.message.findMany({ where, ...pageArgs(cursor, take) }),
    toRecord: (m) => m,
    onDone: auditDone(actor, "export.messages", { from: range.from, to: range.to, format: "json" }),
  });
}

export function messagesCsv(actor: ExportActor, range: ReportRange) {
  const where = { tenantId: actor.tenantId, createdAt: { gte: range.start, lt: range.end } };
  return csvStream({
    headers: ["id", "created_at", "conversation_id", "direction", "type", "body", "template", "status", "error_code", "wamid", "sent_by_user_id"],
    fetchPage: (cursor, take) => prisma.message.findMany({ where, ...pageArgs(cursor, take) }),
    toRow: (m) => [m.id, day(m.createdAt), m.conversationId, m.direction, m.type, m.body, m.templateName, m.status, m.errorCode, m.wamid, m.sentByUserId],
    onDone: auditDone(actor, "export.messages", { from: range.from, to: range.to }),
  });
}

type BroadcastExportRow = { id: string; name: string; status: string; createdAt: Date; startedAt: Date | null; completedAt: Date | null; template: { name: string }; counts: Record<string, number> };

async function broadcastPage(actor: ExportActor, cursor: string | undefined, take: number): Promise<BroadcastExportRow[]> {
  const list = await prisma.broadcast.findMany({ where: { tenantId: actor.tenantId }, include: { template: { select: { name: true } } }, ...pageArgs(cursor, take) });
  if (list.length === 0) return [];
  const groups = await prisma.broadcastRecipient.groupBy({
    by: ["broadcastId", "status"],
    where: { tenantId: actor.tenantId, broadcastId: { in: list.map((b) => b.id) } },
    _count: { _all: true },
  });
  return list.map((b) => {
    const counts: Record<string, number> = {};
    for (const g of groups) if (g.broadcastId === b.id) counts[g.status] = g._count._all;
    return { ...b, counts };
  });
}

function broadcastFigures(b: BroadcastExportRow) {
  const read = b.counts.read ?? 0;
  const delivered = (b.counts.delivered ?? 0) + read;
  const sent = (b.counts.sent ?? 0) + delivered;
  const total = Object.values(b.counts).reduce((a, c) => a + c, 0);
  return { total, sent, delivered, read, failed: b.counts.failed ?? 0, skipped: b.counts.skipped ?? 0, deliveryRatePct: rate(delivered, sent), readRatePct: rate(read, sent) };
}

export function broadcastsJson(actor: ExportActor) {
  return jsonStream<BroadcastExportRow>({
    fetchPage: (cursor, take) => broadcastPage(actor, cursor, take),
    toRecord: (b) => ({ id: b.id, name: b.name, status: b.status, template: b.template.name, createdAt: b.createdAt, startedAt: b.startedAt, completedAt: b.completedAt, ...broadcastFigures(b) }),
    onDone: auditDone(actor, "export.broadcasts", { format: "json" }),
  });
}

export function broadcastsCsv(actor: ExportActor) {
  return csvStream<BroadcastExportRow>({
    headers: ["id", "name", "status", "template", "created_at", "started_at", "completed_at", "recipients", "sent", "delivered", "read", "failed", "skipped", "delivery_rate_pct", "read_rate_pct"],
    fetchPage: (cursor, take) => broadcastPage(actor, cursor, take),
    toRow: (b) => {
      const f = broadcastFigures(b);
      return [b.id, b.name, b.status, b.template.name, day(b.createdAt), day(b.startedAt), day(b.completedAt), f.total, f.sent, f.delivered, f.read, f.failed, f.skipped, f.deliveryRatePct, f.readRatePct];
    },
    onDone: auditDone(actor, "export.broadcasts"),
  });
}

const leadPage = (actor: ExportActor) => (cursor: string | undefined, take: number) => prisma.lead.findMany({ where: { tenantId: actor.tenantId }, ...pageArgs(cursor, take) });

export function leadsCsv(actor: ExportActor) {
  return csvStream({
    headers: ["id", "created_at", "status", "contact_id", "assigned_to_user_id", "lead_form_id", "campaign_id", "ad_id", "first_response_at", "consent_at", "consent_text", "fields"],
    fetchPage: leadPage(actor),
    toRow: (l) => [l.id, day(l.createdAt), l.status, l.contactId, l.assignedToId, l.leadFormId, l.campaignMetaId, l.adMetaId, day(l.firstResponseAt), day(l.consentAt), l.consentText, l.fields],
    onDone: auditDone(actor, "export.leads"),
  });
}

export function leadsJson(actor: ExportActor) {
  return jsonStream({ fetchPage: leadPage(actor), toRecord: (l) => l, onDone: auditDone(actor, "export.leads", { format: "json" }) });
}

type Section = { name: string; fetchPage: Page<{ id: string }> };

/** Full data portability bundle. Selects explicit fields only; nothing here holds tokens, hashes or API keys. */
export function workspaceJson(actor: ExportActor, now = new Date()) {
  const where = { tenantId: actor.tenantId };
  const sections: Section[] = [
    { name: "contacts", fetchPage: (c, t) => prisma.contact.findMany({ where, ...pageArgs(c, t) }) },
    { name: "conversations", fetchPage: (c, t) => prisma.conversation.findMany({ where, ...pageArgs(c, t) }) },
    { name: "messages", fetchPage: (c, t) => prisma.message.findMany({ where, ...pageArgs(c, t) }) },
    { name: "templates", fetchPage: (c, t) => prisma.template.findMany({ where, ...pageArgs(c, t) }) },
    { name: "broadcasts", fetchPage: (c, t) => prisma.broadcast.findMany({ where, ...pageArgs(c, t) }) },
    { name: "broadcastRecipients", fetchPage: (c, t) => prisma.broadcastRecipient.findMany({ where, ...pageArgs(c, t) }) },
    { name: "notes", fetchPage: (c, t) => prisma.note.findMany({ where, ...pageArgs(c, t) }) },
    { name: "leads", fetchPage: (c, t) => prisma.lead.findMany({ where, ...pageArgs(c, t) }) },
    { name: "quickReplies", fetchPage: (c, t) => prisma.quickReply.findMany({ where, ...pageArgs(c, t) }) },
    { name: "teams", fetchPage: (c, t) => prisma.team.findMany({ where, ...pageArgs(c, t) }) },
    { name: "teamMembers", fetchPage: (c, t) => prisma.teamMember.findMany({ where, ...pageArgs(c, t) }) },
    { name: "segments", fetchPage: (c, t) => prisma.segment.findMany({ where, ...pageArgs(c, t) }) },
    { name: "replyMaterials", fetchPage: (c, t) => prisma.replyMaterial.findMany({ where, ...pageArgs(c, t) }) },
    {
      name: "automationRules",
      fetchPage: (c, t) =>
        prisma.automationRule.findMany({
          where,
          select: { id: true, phoneNumberId: true, type: true, name: true, enabled: true, keywords: true, matchMode: true, replyText: true, schedule: true, cooldownMinutes: true, createdAt: true, version: true, priority: true, trigger: true, filters: true, actions: true, stopAfterMatch: true },
          ...pageArgs(c, t),
        }),
    },
  ];
  const counts: Record<string, number> = {};
  const truncatedSections: string[] = [];
  let index = 0;
  let cursor: string | undefined;
  let rowsInSection = 0;
  let started = false;
  let finished = false;
  const record = (aborted: boolean) =>
    audit({
      tenantId: actor.tenantId,
      userId: actor.userId,
      action: "export.workspace",
      meta: { ...counts, truncated: truncatedSections.length > 0, truncatedSections: truncatedSections.join(","), ...(aborted ? { aborted: true } : {}) },
    });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        let out = "";
        if (!started) {
          started = true;
          out += `{"exportedAt":${JSON.stringify(now.toISOString())},"workspaceId":${JSON.stringify(actor.tenantId)}`;
        }
        if (index >= sections.length) {
          // Always present, so a reader can tell "complete" from "cut short": the names of any sections that hit the row cap.
          controller.enqueue(encoder.encode(`${out},"truncatedSections":${JSON.stringify(truncatedSections)}${truncatedSections.length ? `,"note":${JSON.stringify(TRUNCATION_NOTE)}` : ""}}`));
          finished = true;
          await record(false);
          return controller.close();
        }
        const section = sections[index];
        if (rowsInSection === 0 && !cursor) out += `,${JSON.stringify(section.name)}:[`;
        const take = Math.min(PAGE_SIZE, MAX_EXPORT_ROWS - rowsInSection);
        const page = take > 0 ? await section.fetchPage(cursor, take) : [];
        out += page.map((item, i) => (rowsInSection + i > 0 ? "," : "") + JSON.stringify(item)).join("");
        rowsInSection += page.length;
        cursor = page.at(-1)?.id;
        if (page.length < take || rowsInSection >= MAX_EXPORT_ROWS) {
          if (rowsInSection >= MAX_EXPORT_ROWS && page.length === take && (await section.fetchPage(cursor, 1)).length > 0) {
            truncatedSections.push(section.name);
            out += `,${JSON.stringify({ _truncated: true, _note: TRUNCATION_NOTE })}`;
          }
          out += "]";
          counts[section.name] = rowsInSection;
          index++;
          cursor = undefined;
          rowsInSection = 0;
        }
        if (out) controller.enqueue(encoder.encode(out));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      if (finished) return;
      finished = true;
      try {
        await record(true);
      } catch {
        console.warn("[export] could not record an abandoned export");
      }
    },
  });
}
