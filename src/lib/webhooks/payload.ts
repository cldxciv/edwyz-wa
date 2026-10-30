export type Rec = Record<string, unknown>;

export const asRec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
export const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined);

export type Change = { wabaId?: string; field: string; value: Rec };

export function extractChanges(payload: unknown): Change[] {
  const out: Change[] = [];
  for (const entry of asArr(asRec(payload).entry)) {
    const e = asRec(entry);
    for (const change of asArr(e.changes)) {
      const c = asRec(change);
      out.push({ wabaId: str(e.id), field: str(c.field) ?? "unknown", value: asRec(c.value) });
    }
  }
  return out;
}

export type ParsedMessage = {
  type: string;
  body: string;
  mediaId?: string;
  mediaMime?: string;
  /** Id of the tapped reply button or list row (interactive replies only). */
  replyId?: string;
  /** button.payload of a tapped template quick reply (type "button"), for example "spdec:<approvalId>:<hmac>" (spend spec 7.4). */
  buttonPayload?: string;
};

/** Stored as the body of an interactive message that is not a tapped button or list row (a form reply, for example). It is never treated as the customer's words. */
export const INTERACTIVE_PLACEHOLDER = "[interactive]";

/** Turns any inbound message type into a readable body plus optional media reference. */
export function describeMessage(message: Rec): ParsedMessage {
  const type = str(message.type) ?? "unknown";
  const media = (key: string): ParsedMessage => {
    const m = asRec(message[key]);
    const caption = str(m.caption);
    const filename = str(m.filename);
    const label = key === "document" && filename ? `[document: ${filename}]` : `[${key}]`;
    return { type, body: caption ? `${label} ${caption}` : label, mediaId: str(m.id), mediaMime: str(m.mime_type) };
  };

  switch (type) {
    case "text":
      return { type, body: str(asRec(message.text).body) ?? "" };
    case "image":
    case "document":
    case "audio":
    case "video":
    case "sticker":
      return media(type);
    case "location": {
      const l = asRec(message.location);
      const label = [str(l.name), str(l.address)].filter(Boolean).join(", ");
      return { type, body: `[location] ${l.latitude},${l.longitude}${label ? ` ${label}` : ""}` };
    }
    case "button": {
      const button = asRec(message.button);
      const payload = str(button.payload);
      return { type, body: str(button.text) ?? "[button]", ...(payload ? { buttonPayload: payload.slice(0, 512) } : {}) };
    }
    case "interactive": {
      const i = asRec(message.interactive);
      const reply = asRec(i.button_reply ?? i.list_reply);
      return { type, body: str(reply.title) ?? str(reply.id) ?? INTERACTIVE_PLACEHOLDER, ...(str(reply.id) ? { replyId: str(reply.id) } : {}) };
    }
    case "reaction":
      return { type, body: `[reaction] ${str(asRec(message.reaction).emoji) ?? ""}`.trim() };
    default:
      return { type, body: `[${type}]` };
  }
}

/** Whole-message opt-out phrases, after normalisation. A short message (up to 5 words) that starts with the word "stop" also counts. */
export const STOP_PHRASES = new Set(["stop", "stop all", "stop please", "unsubscribe", "end", "cancel", "quit", "opt out", "optout"]);
const MAX_STOP_WORDS = 5;

export const normalizeOptOutText = (body: string) =>
  body
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

export function isStopMessage(body: string): boolean {
  const text = normalizeOptOutText(body);
  if (!text) return false;
  if (STOP_PHRASES.has(text)) return true;
  const words = text.split(" ");
  return words[0] === "stop" && words.length <= MAX_STOP_WORDS;
}

/** Whole-message resubscribe phrases, after normalisation. Only honoured for a contact who is currently opted out. */
export const START_PHRASES = new Set(["start", "unstop", "subscribe", "resubscribe", "opt in", "optin"]);

export function isStartMessage(body: string): boolean {
  return START_PHRASES.has(normalizeOptOutText(body));
}

export const toE164 = (waId: string) => `+${waId.replace(/\D/g, "")}`;

/** What Meta says a delivered message costs (statuses[].pricing, docs/SPEND-CONTROLS-SPEC.md 4.9 "Actual cost"). */
export type StatusPricing = { billable: boolean | null; type: string | null; category: string | null };

const FREE_TYPES = new Set(["free_customer_service", "free_entry_point"]);

/**
 * The pricing object of a status, or null when the status carries none. `type` is the per-message pricing type (regular,
 * free_customer_service, free_entry_point), falling back to the older pricing_model. A free type with no billable flag reads as
 * not billable.
 */
export function parsePricing(status: Rec): StatusPricing | null {
  const p = asRec(status.pricing);
  if (Object.keys(p).length === 0) return null;
  const type = (str(p.type) ?? str(p.pricing_model) ?? "").toLowerCase().slice(0, 64) || null;
  const category = (str(p.category) ?? "").toLowerCase().slice(0, 64) || null;
  const billable = typeof p.billable === "boolean" ? p.billable : type && FREE_TYPES.has(type) ? false : null;
  if (billable === null && !type && !category) return null;
  return { billable, type, category };
}

export const asJsonArr = (v: unknown) => asArr(v) as import("@/generated/prisma/client").Prisma.InputJsonValue[];
