import { prisma } from "@/lib/db";
import { displayName, displaySubtitle } from "@/lib/contacts/identity";
import { HttpError } from "@/lib/tenancy";
import { maskPhone } from "@/lib/teams/visibility";
import { listMembers } from "./marks";

export const EXPORT_FORMATS = ["txt", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** A chat longer than this is cut at its newest messages and the file says so. */
export const MAX_EXPORT_MESSAGES = 10_000;

type Line = { at: Date; who: string; kind: "message" | "note"; type: string; text: string; status?: string; direction?: "inbound" | "outbound"; id: string; mediaMime?: string | null };

const pad = (n: number) => String(n).padStart(2, "0");
export const stamp = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;

export function exportFileName(contactName: string | null, phone: string | null, format: ExportFormat, now: Date = new Date()): string {
  const base = (contactName || phone || "").normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "chat";
  return `chat-${base}-${now.toISOString().slice(0, 10)}.${format}`;
}

/** Plain text transcript, oldest first. Media is listed by type; the files themselves are not included. */
export function renderTranscript(header: { contact: string; phone: string | null; number: string | null; exportedAt: Date; truncated: boolean }, lines: Line[]): string {
  const out = [
    header.phone ? `Chat with ${header.contact} (${header.phone})` : `Chat with ${header.contact}`,
    header.number ? `Business number: ${header.number}` : null,
    `Exported: ${stamp(header.exportedAt)}`,
    header.truncated ? `Only the newest ${MAX_EXPORT_MESSAGES} messages are included.` : null,
    "",
  ].filter((l): l is string => l !== null);
  for (const l of lines) {
    const label = l.kind === "note" ? `Internal note, ${l.who}` : l.who;
    const body = l.text || (l.type !== "text" ? `[${l.type}]` : "");
    out.push(`[${stamp(l.at)}] ${label}: ${body}`.trimEnd());
  }
  return `${out.join("\n")}\n`;
}

export async function buildChatExport(tenantId: string, conversationId: string, opts: { format: ExportFormat; includeNotes: boolean; masked?: boolean; now?: Date }) {
  const now = opts.now ?? new Date();
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    select: {
      id: true,
      status: true,
      tags: true,
      createdAt: true,
      contact: { select: { name: true, phone: true, bsuid: true, username: true } },
      phoneNumber: { select: { displayPhone: true } },
    },
  });
  if (!conversation) throw new HttpError(404, "Conversation not found.");

  if (opts.masked && conversation.contact.phone) conversation.contact.phone = maskPhone(conversation.contact.phone);
  const names = new Map((await listMembers(tenantId)).map((m) => [m.userId, m.name]));
  const customer = displayName(conversation.contact);
  const agent = (id: string | null) => (id ? (names.get(id) ?? "Teammate") : "Business");

  const newest = await prisma.message.findMany({
    where: { tenantId, conversationId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_EXPORT_MESSAGES + 1,
    select: { id: true, direction: true, type: true, body: true, status: true, createdAt: true, sentByUserId: true, mediaMime: true, templateName: true },
  });
  const truncated = newest.length > MAX_EXPORT_MESSAGES;
  const messages = newest.slice(0, MAX_EXPORT_MESSAGES).reverse();

  const lines: Line[] = messages.map((m) => ({
    id: m.id,
    at: m.createdAt,
    kind: "message",
    direction: m.direction,
    who: m.direction === "inbound" ? customer : agent(m.sentByUserId),
    type: m.type,
    text: m.type === "template" ? `[template: ${m.templateName ?? "message"}] ${(m.body ?? "").replace(/^\[template\]\s*/, "")}`.trim() : (m.body ?? ""),
    status: m.status,
    mediaMime: m.mediaMime,
  }));

  if (opts.includeNotes) {
    const notes = await prisma.note.findMany({ where: { tenantId, conversationId }, orderBy: { createdAt: "asc" }, take: 2000 });
    for (const n of notes) lines.push({ id: n.id, at: n.createdAt, kind: "note", who: agent(n.authorId), type: "note", text: n.body });
    lines.sort((a, b) => a.at.getTime() - b.at.getTime());
  }

  const fileName = exportFileName(conversation.contact.name, conversation.contact.phone ?? conversation.contact.username ?? conversation.contact.bsuid, opts.format, now);
  if (opts.format === "txt") {
    const text = renderTranscript({ contact: customer, phone: conversation.contact.phone ?? (displaySubtitle(conversation.contact) || null), number: conversation.phoneNumber.displayPhone, exportedAt: now, truncated }, lines);
    return { fileName, contentType: "text/plain; charset=utf-8", body: text, count: lines.length };
  }
  const json = {
    exportedAt: now.toISOString(),
    truncated,
    conversation: {
      id: conversation.id,
      status: conversation.status,
      tags: conversation.tags,
      startedAt: conversation.createdAt.toISOString(),
      contact: { name: conversation.contact.name, phone: conversation.contact.phone, username: conversation.contact.username, bsuid: conversation.contact.bsuid },
      businessNumber: conversation.phoneNumber.displayPhone,
    },
    items: lines.map((l) => ({
      id: l.id,
      kind: l.kind,
      at: l.at.toISOString(),
      direction: l.direction ?? null,
      from: l.who,
      type: l.type,
      text: l.text,
      status: l.status ?? null,
      hasMedia: !!l.mediaMime,
    })),
  };
  return { fileName, contentType: "application/json; charset=utf-8", body: `${JSON.stringify(json, null, 2)}\n`, count: lines.length };
}
