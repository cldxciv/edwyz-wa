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

export function docFromChatbot(c: Pick<Chatbot, "name" | "triggerType" | "triggerKeywords" | "flow"> & { phoneNumberId?: string | null }): Doc {
  return { name: c.name, triggerType: c.triggerType, triggerKeywords: c.triggerKeywords ?? [], phoneNumberId: c.phoneNumberId ?? null, flow: normalizeFlow(c.flow) };
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

/** True when the published copy differs from the current draft, so republishing would change behaviour. */
export function hasUnpublishedChanges(c: Pick<Chatbot, "flow" | "publishedFlow" | "status">): boolean {
  return c.status === "published" && withoutEmpty(c.flow) !== withoutEmpty(c.publishedFlow);
}
