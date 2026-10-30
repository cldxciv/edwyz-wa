/**
 * The contacts and chats a value names, for erasure (EddyMessage.contactIds and conversationIds, ActionRecord.contactIds).
 * Pure, with no imports, so Eddy's loop can use it without reaching the database (docs/EDDY-SPEC.md 4.8, 7.6).
 */

export type SubjectIds = { contactIds: string[]; conversationIds: string[] };

/** The shape of a row id (cuid, ar_..., a test's c1): anything else is not an id and is never stored. */
const ID_VALUE = /^[A-Za-z0-9_:-]{1,64}$/;
const MAX_IDS = 200;
const MAX_DEPTH = 8;
const CONTACT_KEYS = new Set(["contact", "contacts"]);
const CHAT_KEYS = new Set(["conversation", "conversations", "chat", "chats"]);

/**
 * Every contact and chat id the values name: contactId / contactIds and conversationId / conversationIds / chatId fields at any
 * depth, and the `id` of an object under a contact(s) or conversation(s) / chat(s) key. Bounded (depth 8, 200 ids each), so
 * it is safe on any tool input or result.
 */
export function subjectIdsIn(...values: unknown[]): SubjectIds {
  const contacts = new Set<string>();
  const chats = new Set<string>();
  const add = (set: Set<string>, v: unknown) => {
    if (typeof v === "string" && ID_VALUE.test(v) && set.size < MAX_IDS) set.add(v);
  };
  const walk = (v: unknown, depth: number, under: "contact" | "chat" | null) => {
    if (depth > MAX_DEPTH || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v.slice(0, 500)) walk(item, depth + 1, under);
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === "contactId") add(contacts, x);
      else if (k === "contactIds" && Array.isArray(x)) x.forEach((id) => add(contacts, id));
      else if (k === "conversationId" || k === "chatId") add(chats, x);
      else if (k === "conversationIds" && Array.isArray(x)) x.forEach((id) => add(chats, id));
      else if (k === "id" && under) add(under === "contact" ? contacts : chats, x);
      else walk(x, depth + 1, CONTACT_KEYS.has(k) ? "contact" : CHAT_KEYS.has(k) ? "chat" : null);
    }
  };
  for (const v of values) walk(v, 0, null);
  return { contactIds: [...contacts], conversationIds: [...chats] };
}

/** Two lists of ids as one, de-duplicated and bounded. */
export function mergeSubjects(...lists: (Partial<SubjectIds> | null | undefined)[]): SubjectIds {
  const contacts = new Set<string>();
  const chats = new Set<string>();
  for (const l of lists) {
    for (const id of l?.contactIds ?? []) if (contacts.size < MAX_IDS) contacts.add(id);
    for (const id of l?.conversationIds ?? []) if (chats.size < MAX_IDS) chats.add(id);
  }
  return { contactIds: [...contacts], conversationIds: [...chats] };
}
