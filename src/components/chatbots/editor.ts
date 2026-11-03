import { normalizeFlow } from "./flow";
import type { Chatbot, ChatbotStatus, FlowDefinition, TriggerType } from "./types";

export type Doc = { name: string; triggerType: TriggerType; triggerKeywords: string[]; phoneNumberId: string | null; flow: FlowDefinition };

export const TRIGGER_LABEL: Record<TriggerType, string> = {
  keyword: "When a message contains certain words",
  first_message: "When a customer writes for the first time",
  any_message: "On every message",
  manual: "Only when a teammate or rule starts it",
};

export const TRIGGER_HELP: Record<TriggerType, string> = {
  keyword: "The bot starts when a customer's message contains one of your words.",
  first_message: "The bot starts the first time a customer writes to you.",
  any_message: "The bot starts on every message that no other bot is handling. Use with care.",
  manual: "The bot never starts on its own. A teammate or an automation rule starts it.",
};

export const STATUS_TONE: Record<ChatbotStatus, "neutral" | "good" | "warn"> = { draft: "neutral", published: "good", archived: "warn" };

type TriggerDraft = { triggerType: TriggerType; triggerKeywords: string[]; phoneNumberId: string | null };
type TriggerCarrier = Pick<Chatbot, "triggerType" | "triggerKeywords" | "flow"> & { phoneNumberId?: string | null };

const TRIGGER_TYPES = Object.keys(TRIGGER_LABEL) as TriggerType[];

/**
 * The trigger of the saved draft. The server keeps a published bot's columns as what customers get, and holds a saved but
 * unpublished trigger change in the draft flow (flow.trigger) until it is published (src/lib/chatbots/service.ts draftTrigger).
 */
export function draftTriggerOf(c: TriggerCarrier): TriggerDraft {
  const live: TriggerDraft = { triggerType: c.triggerType, triggerKeywords: c.triggerKeywords ?? [], phoneNumberId: c.phoneNumberId ?? null };
  const raw = (c.flow as unknown as { trigger?: unknown } | null)?.trigger;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return live;
  const t = raw as Record<string, unknown>;
  return {
    triggerType: TRIGGER_TYPES.includes(t.triggerType as TriggerType) ? (t.triggerType as TriggerType) : live.triggerType,
    triggerKeywords: Array.isArray(t.triggerKeywords) ? t.triggerKeywords.filter((k): k is string => typeof k === "string") : live.triggerKeywords,
    phoneNumberId: t.phoneNumberId === null || typeof t.phoneNumberId === "string" ? t.phoneNumberId : live.phoneNumberId,
  };
}

export function docFromChatbot(c: Pick<Chatbot, "name" | "triggerType" | "triggerKeywords" | "flow"> & { phoneNumberId?: string | null }): Doc {
  return { name: c.name, ...draftTriggerOf(c), flow: normalizeFlow(c.flow) };
}

export const newDoc = (): Doc => ({ name: "", triggerType: "keyword", triggerKeywords: [], phoneNumberId: null, flow: normalizeFlow(null) });

export const docToPayload = (d: Doc) => ({
  name: d.name.trim(),
  triggerType: d.triggerType,
  triggerKeywords: d.triggerType === "keyword" ? d.triggerKeywords : [],
  phoneNumberId: d.phoneNumberId,
  flow: d.flow,
});

/** Responses may be wrapped as { chatbot } or returned bare. */
export function unwrapChatbot<T>(res: unknown): T {
  const r = res as { chatbot?: T };
  return (r && typeof r === "object" && "chatbot" in r ? r.chatbot : res) as T;
}

export const isDirty = (saved: Doc, current: Doc) => JSON.stringify(saved) !== JSON.stringify(current);

/** The server drops empty optional fields when it publishes, so empty text and empty lists must not count as a difference. */
const withoutEmpty = (flow: unknown) => JSON.stringify(flow, (_key, v) => (v === "" || (Array.isArray(v) && v.length === 0) ? undefined : Array.isArray(v) ? v.filter((x) => x !== "") : v));

/** The draft flow without its pending trigger, which is compared on its own (the published flow never carries one). */
function steps(flow: unknown): unknown {
  if (!flow || typeof flow !== "object" || Array.isArray(flow)) return flow;
  const { trigger: _pending, ...rest } = flow as Record<string, unknown>;
  return rest;
}

/**
 * True when the published copy differs from the current draft, so republishing would change behaviour: the steps and settings,
 * or the trigger (when it starts, its words, its number) saved since the last publish.
 */
export function hasUnpublishedChanges(c: Pick<Chatbot, "flow" | "publishedFlow" | "status"> & Partial<Pick<Chatbot, "triggerType" | "triggerKeywords">> & { phoneNumberId?: string | null }): boolean {
  if (c.status !== "published") return false;
  if (withoutEmpty(steps(c.flow)) !== withoutEmpty(c.publishedFlow)) return true;
  if (c.triggerType === undefined) return false;
  const live = { triggerType: c.triggerType, triggerKeywords: c.triggerKeywords ?? [], phoneNumberId: c.phoneNumberId ?? null };
  const draft = draftTriggerOf({ ...live, flow: c.flow });
  return draft.triggerType !== live.triggerType || draft.phoneNumberId !== live.phoneNumberId || draft.triggerKeywords.join("\n") !== live.triggerKeywords.join("\n");
}
