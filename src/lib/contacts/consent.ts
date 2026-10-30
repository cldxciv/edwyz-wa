import { audit } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { type Actor, HttpError } from "@/lib/tenancy";

/*
 * Consent history. Contact.optIn* holds the latest state; every change is also written to the audit log with who made it, so the
 * owner can show proof of when and how a person agreed. Opt-outs sent by the person (STOP) are already audited by the webhook processor.
 */

export const CONSENT_ACTIONS = ["contact.consent_recorded", "contact.consent_withdrawn", "contact.opted_out", "contact.opted_in"] as const;
export type ConsentKind = "opt_in" | "withdrawn" | "opted_out";

const KIND: Record<(typeof CONSENT_ACTIONS)[number], ConsentKind> = {
  "contact.consent_recorded": "opt_in",
  "contact.consent_withdrawn": "withdrawn",
  "contact.opted_out": "opted_out",
  "contact.opted_in": "opt_in",
};

export type ConsentEvent = { at: string; kind: ConsentKind; source: string | null; by: { id: string; name: string | null; email: string } | "contact" | null };

export async function recordConsent(actor: Pick<Actor, "tenantId" | "userId">, contactId: string, input: { source: string }): Promise<void> {
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "contact.consent_recorded", target: contactId, meta: { source: input.source.slice(0, 200) } });
}

/** Where an opt-in that no dashboard user made came from: the customer through a form or chatbot, or an integration through the API. */
export type ConsentChannel = "api" | "lead_form" | "chatbot";

/**
 * Writes the consent history row for an opt-in made by an integration, a lead form or a chatbot. Without it the opt-in has a source and a
 * time on the contact but no history entry, so the owner could not show who or what recorded it. Never throws: the audit writer swallows its own errors.
 */
export async function recordChannelConsent(tenantId: string, contactId: string, input: { source: string; via: ConsentChannel; userId?: string | null }): Promise<void> {
  await audit({ tenantId, userId: input.userId ?? null, action: "contact.consent_recorded", target: contactId, meta: { source: input.source.slice(0, 200), via: input.via } });
}

export async function recordConsentWithdrawn(actor: Pick<Actor, "tenantId" | "userId">, contactId: string): Promise<void> {
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "contact.consent_withdrawn", target: contactId });
}

type Row = { action: string; userId: string | null; createdAt: Date; meta: unknown };

const AGREED_BY_CONTACT: Record<string, string> = { lead_form: "the contact, through a lead form", chatbot: "the contact, through a chatbot" };
const viaOf = (meta: unknown): string | null => {
  const v = meta && typeof meta === "object" ? (meta as { via?: unknown }).via : null;
  return typeof v === "string" ? v : null;
};

function sourceOf(meta: unknown): string | null {
  const v = meta && typeof meta === "object" ? (meta as { source?: unknown; via?: unknown }) : {};
  if (typeof v.source === "string") return v.source;
  if (v.via === "stop_keyword") return "Replied STOP";
  return v.via === "start_keyword" ? "Replied START" : null;
}

/** Newest first. Only owners and admins see who recorded each entry. */
export async function consentHistory(actor: Actor, contactId: string): Promise<{ events: ConsentEvent[]; current: { optIn: boolean; optInSource: string | null; optInAt: string | null; optedOutAt: string | null } }> {
  const contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId: actor.tenantId }, select: { optIn: true, optInSource: true, optInAt: true, optedOutAt: true } });
  if (!contact) throw new HttpError(404, "Contact not found.");
  const rows = (await prisma.auditLog.findMany({
    where: { tenantId: actor.tenantId, target: contactId, action: { in: [...CONSENT_ACTIONS] } },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { action: true, userId: true, createdAt: true, meta: true },
  })) as Row[];
  const ids = [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))];
  const people = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids }, memberships: { some: { tenantId: actor.tenantId } } }, select: { id: true, name: true, email: true } })
    : [];
  const byId = new Map(people.map((p) => [p.id, p]));
  const events = rows.map((r): ConsentEvent => {
    const person = r.userId ? byId.get(r.userId) : undefined;
    return {
      at: r.createdAt.toISOString(),
      kind: KIND[r.action as (typeof CONSENT_ACTIONS)[number]] ?? "opted_out",
      source: sourceOf(r.meta),
      by: person ? { id: person.id, name: person.name, email: person.email } : r.userId ? null : r.action === "contact.opted_out" || r.action === "contact.opted_in" || (r.action === "contact.consent_recorded" && (viaOf(r.meta) ?? "") in AGREED_BY_CONTACT) ? "contact" : null,
    };
  });
  return {
    events,
    current: { optIn: contact.optIn, optInSource: contact.optInSource, optInAt: contact.optInAt?.toISOString() ?? null, optedOutAt: contact.optedOutAt?.toISOString() ?? null },
  };
}

/** Email of the person who last recorded each contact's opt-in, for the contacts export. Empty when nothing was recorded or the log cannot be read. */
export async function consentRecordedBy(tenantId: string, contactIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (contactIds.length === 0) return out;
  try {
    const rows = await prisma.auditLog.findMany({
      where: { tenantId, action: "contact.consent_recorded", target: { in: [...contactIds] } },
      orderBy: { createdAt: "desc" },
      select: { target: true, userId: true, meta: true },
    });
    const first = new Map<string, string>();
    const seen = new Set<string>();
    for (const r of rows) {
      if (!r.target || seen.has(r.target)) continue;
      seen.add(r.target);
      if (r.userId) first.set(r.target, r.userId);
      else {
        const via = viaOf(r.meta);
        if (via && AGREED_BY_CONTACT[via]) out.set(r.target, AGREED_BY_CONTACT[via]);
      }
    }
    const userIds = [...new Set(first.values())];
    if (userIds.length === 0) return out;
    const users = await prisma.user.findMany({ where: { id: { in: userIds }, memberships: { some: { tenantId } } }, select: { id: true, email: true } });
    const email = new Map(users.map((u) => [u.id, u.email]));
    for (const [contactId, userId] of first) {
      const e = email.get(userId);
      if (e) out.set(contactId, e);
    }
  } catch {
    /* the column is simply empty */
  }
  return out;
}
