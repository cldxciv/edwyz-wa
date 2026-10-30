import { describeError } from "@/lib/safe-error";
import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/queue";

export const EVENT_QUEUE = "automation-event";
export const EVENT_TYPES = ["contact_created", "tag_added", "tag_removed", "attribute_changed", "status_changed"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * A change somebody made to a contact or chat that rules may react to. Only changes made by people and integrations are
 * announced. Changes a rule makes itself are written directly and never announced, so rules cannot trigger each other in a loop.
 */
export type AutomationEvent = {
  type: EventType;
  tenantId: string;
  contactId: string;
  conversationId?: string | null;
  tags?: string[];
  attribute?: string;
  from?: string | null;
  to?: string;
};

/** Queues the event for the worker. Safe to call from any request handler: it never throws and costs one insert. */
export async function emitAutomationEvent(event: AutomationEvent): Promise<void> {
  try {
    await enqueue(EVENT_QUEUE, event, { maxAttempts: 3 });
  } catch (error) {
    console.error("[automation] could not queue an event:", describeError(error));
  }
}

export function diffTags(before: string[], after: string[]): { added: string[]; removed: string[] } {
  if (!Array.isArray(before) || !Array.isArray(after)) return { added: [], removed: [] };
  const lower = (list: string[]) => new Set(list.map((t) => t.toLowerCase()));
  const had = lower(before);
  const has = lower(after);
  return { added: after.filter((t) => !had.has(t.toLowerCase())), removed: before.filter((t) => !has.has(t.toLowerCase())) };
}

type Base = { tenantId: string; contactId: string; conversationId?: string | null };

/** The events for a change of tags between two lists. */
export function tagChangeEvents(base: Base, before: string[], after: string[]): AutomationEvent[] {
  const { added, removed } = diffTags(before, after);
  return [...(added.length ? [{ ...base, type: "tag_added" as const, tags: added }] : []), ...(removed.length ? [{ ...base, type: "tag_removed" as const, tags: removed }] : [])];
}

const text = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "string" ? v.trim() : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v));

/** One event per contact detail whose value differs between two attribute objects (at most 10). */
export function attributeChangeEvents(base: Base, before: Record<string, unknown>, after: Record<string, unknown>): AutomationEvent[] {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => text(before[key]) !== text(after[key])).slice(0, 10).map((attribute) => ({ ...base, type: "attribute_changed" as const, attribute }));
}

/** Announces tag additions and removals between two tag lists. */
export async function emitTagChanges(base: Base, before: string[], after: string[]): Promise<void> {
  for (const event of tagChangeEvents(base, before, after)) await emitAutomationEvent(event);
}

/** Announces each contact detail whose value differs between two attribute objects. */
export async function emitAttributeChanges(base: Base, before: Record<string, unknown>, after: Record<string, unknown>): Promise<void> {
  for (const event of attributeChangeEvents(base, before, after)) await emitAutomationEvent(event);
}

const BATCH = 500;

/** Queues many events with one insert per 500, for imports and other bulk changes. Never throws. */
export async function emitAutomationEvents(events: AutomationEvent[]): Promise<void> {
  try {
    for (let i = 0; i < events.length; i += BATCH) {
      const data = events.slice(i, i + BATCH).map((e) => ({ queue: EVENT_QUEUE, payload: e as object, runAt: new Date(), maxAttempts: 3 }));
      await prisma.job.createMany({ data });
    }
  } catch (error) {
    console.error("[automation] could not queue events:", describeError(error));
  }
}
