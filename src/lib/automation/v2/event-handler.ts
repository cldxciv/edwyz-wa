import type { JobHandler } from "@/lib/queue";
import { EVENT_TYPES, type AutomationEvent } from "./emit";
import { fireRulesSafely } from "./run";

const isEvent = (p: unknown): p is AutomationEvent => {
  const e = p as Partial<AutomationEvent> | null;
  return Boolean(e && typeof e === "object" && (EVENT_TYPES as readonly unknown[]).includes(e.type) && typeof e.tenantId === "string" && typeof e.contactId === "string");
};

export const eventJobHandler: JobHandler = async (payload) => {
  if (!isEvent(payload)) return;
  await fireRulesSafely({
    type: payload.type,
    tenantId: payload.tenantId,
    contactId: payload.contactId,
    conversationId: payload.conversationId ?? null,
    at: new Date(),
    tags: payload.tags,
    attribute: payload.attribute,
    status: payload.to ? { from: payload.from ?? null, to: payload.to } : undefined,
  });
};
