import { prisma } from "@/lib/db";
import { receivableWhere } from "@/lib/contacts/opt-out";
import { type Actor, HttpError } from "@/lib/tenancy";
import { broadcastSupportReason } from "./components";
import { parsePolicy, parseVariableMap } from "./mapping";
import { createBroadcast, ownedBroadcast } from "./service";

/**
 * Which people of a finished or stopped broadcast a follow-up reaches.
 * unsent: not messaged yet or failed (used to retry with another template). unread: delivered but not read.
 */
export const FOLLOW_UP_OUTCOMES = ["unsent", "unread", "read", "failed"] as const;
export type FollowUpOutcome = (typeof FOLLOW_UP_OUTCOMES)[number];

const STATUSES: Record<FollowUpOutcome, ("pending" | "failed" | "delivered" | "read")[]> = {
  unsent: ["pending", "failed"],
  unread: ["delivered"],
  read: ["read"],
  failed: ["failed"],
};

const CAP = 100_000;

export function parseOutcome(raw: unknown): FollowUpOutcome {
  if (typeof raw !== "string" || !(FOLLOW_UP_OUTCOMES as readonly string[]).includes(raw)) throw new HttpError(400, "Choose which people the follow-up is for.");
  return raw as FollowUpOutcome;
}

/** Approved templates on the same WhatsApp account whose placeholders the broadcast's value mapping can already fill. */
export async function followUpTemplates(actor: Actor, id: string) {
  const source = await ownedBroadcast(actor, id);
  const phone = await prisma.phoneNumber.findFirst({ where: { id: source.phoneNumberId, tenantId: actor.tenantId }, select: { wabaRefId: true } });
  if (!phone) return [];
  const templates = await prisma.template.findMany({
    where: { tenantId: actor.tenantId, wabaRefId: phone.wabaRefId, status: "approved", id: { not: source.templateId } },
    orderBy: { name: "asc" },
    take: 200,
    select: { id: true, name: true, language: true, category: true, components: true },
  });
  const policy = parsePolicy(source.missingValuePolicy);
  return templates
    .filter((t) => {
      if (broadcastSupportReason(t.components)) return false;
      try {
        parseVariableMap(source.variableMap, t.components, policy);
        return true;
      } catch {
        return false;
      }
    })
    .map(({ components: _components, ...t }) => (void _components, t));
}

const OPEN_STATUSES = ["draft", "scheduled", "sending", "paused"] as const;

/**
 * Creates a draft broadcast for a subset of an earlier broadcast's people, with another approved template. Nobody who already got
 * the message is included for "unsent". The new broadcast is a draft: a person still presses Send, and nothing about the source changes
 * until then. When the draft for "unsent" is sent, the source (which must be paused) is canceled so nobody is messaged twice; see
 * startBroadcast. A source that is still sending or scheduled cannot be retried (its pending people would get two messages), and only
 * one open retry per source is allowed.
 */
export async function createFollowUp(actor: Actor, id: string, input: { templateId: string; outcome: unknown; name?: string }) {
  const outcome = parseOutcome(input.outcome);
  const source = await ownedBroadcast(actor, id);
  if (source.status === "draft") throw new HttpError(409, "This broadcast has not been sent yet.");
  const reachesPending = outcome === "unsent" || outcome === "failed";
  if (reachesPending && (source.status === "sending" || source.status === "scheduled")) {
    throw new HttpError(409, "This broadcast is still running. Pause it first, then send the rest with another template, so nobody receives two messages.");
  }
  if (outcome === "unsent") {
    const open = await prisma.broadcast.count({
      where: {
        tenantId: actor.tenantId,
        status: { in: [...OPEN_STATUSES] },
        AND: [{ audienceFilter: { path: ["sourceBroadcastId"], equals: source.id } }, { audienceFilter: { path: ["outcome"], equals: "unsent" } }],
      },
    });
    if (open > 0) throw new HttpError(409, "There is already an unfinished retry for this broadcast. Send it or cancel it first, so nobody is messaged twice.");
  }
  // A follow-up is a broadcast: it needs a recorded opt-in, which an opt-out clears, and opted-out people never get its marketing.
  const rows = await prisma.broadcastRecipient.findMany({
    where: { tenantId: actor.tenantId, broadcastId: source.id, status: { in: STATUSES[outcome] }, contact: { optIn: true, ...receivableWhere("marketing") } },
    select: { contactId: true },
    take: CAP,
  });
  if (rows.length === 0) throw new HttpError(400, "No one matches. Everyone who qualified has already been handled, or opted out.");

  const suffix = outcome === "unsent" ? " (retry)" : " (follow-up)";
  const name = (input.name?.trim() || `${source.name}`.slice(0, 120 - suffix.length) + suffix).slice(0, 120);
  const created = await createBroadcast(actor, {
    name,
    phoneNumberId: source.phoneNumberId,
    templateId: input.templateId,
    variableMap: source.variableMap,
    missingValuePolicy: source.missingValuePolicy,
    retryDays: source.retryDays,
    fixedFrom: source.id,
    fixedOutcome: outcome,
  });
  await prisma.broadcastRecipient.createMany({
    data: rows.map((r) => ({ tenantId: actor.tenantId, broadcastId: created.id, contactId: r.contactId })),
    skipDuplicates: true,
  });
  return { broadcast: created, people: rows.length };
}
