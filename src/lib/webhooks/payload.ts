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

export type OrderItem = { productRetailerId: string; quantity: number; itemPrice: number | null; currency: string | null };
/** A catalog order (type "order"). total is set only when every item has a price in one currency. */
export type ParsedOrder = { catalogId: string | null; text: string | null; items: OrderItem[]; total: number | null; currency: string | null };
/** One shared contact card (type "contacts"): the name and phone numbers only. */
export type SharedContact = { name: string | null; phones: { phone: string; waId: string | null; type: string | null }[] };
/** A WhatsApp system notice (type "system"). newWaId is the customer's new number (digits) when they changed it. */
export type SystemNotice = { event: "number_changed" | "identity_changed" | "other"; newWaId: string | null };

export type ParsedMessage = {
  type: string;
  body: string;
  mediaId?: string;
  mediaMime?: string;
  /** Id of the tapped reply button or list row (interactive replies only). */
  replyId?: string;
  /** button.payload of a tapped template quick reply (type "button"), for example "spdec:<approvalId>:<hmac>" (spend spec 7.4). */
  buttonPayload?: string;
  /** A reaction: the emoji ("" when the customer removed it) and the wamid of the message it is on. */
  reaction?: { emoji: string; messageId: string | null };
  order?: ParsedOrder;
  contacts?: SharedContact[];
  system?: SystemNotice;
};

/** Stored as the body of an interactive message that is not a tapped button or list row (a form reply, for example). It is never treated as the customer's words. */
export const INTERACTIVE_PLACEHOLDER = "[interactive]";

/**
 * Inbound message types that are not something the customer wrote: a reaction (an emoji on an earlier message) and a WhatsApp
 * system notice (a changed number or security code). They are stored and shown in the chat, but never count as a customer message,
 * so a check such as "is this the first message" or "how long was the customer quiet" leaves them out:
 * `type: { notIn: [...NOT_CUSTOMER_MESSAGE_TYPES] }` next to `direction: "inbound"`.
 */
export const NOT_CUSTOMER_MESSAGE_TYPES: readonly string[] = ["reaction", "system"];

const MAX_ORDER_LINES = 30;
const MAX_CONTACT_CARDS = 10;
const MAX_CONTACT_PHONES = 5;

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const amount = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "[order] 3 items, total 1598 INR", then one line per item ("2 x SKU-1 at 499 INR") and the customer's note. */
export function describeOrder(order: Rec): ParsedMessage {
  const items: OrderItem[] = asArr(order.product_items).map((raw) => {
    const i = asRec(raw);
    const quantity = num(i.quantity);
    return {
      productRetailerId: (str(i.product_retailer_id) ?? "").slice(0, 100),
      quantity: quantity !== null && quantity > 0 ? quantity : 1,
      itemPrice: num(i.item_price),
      currency: str(i.currency)?.toUpperCase().slice(0, 8) ?? null,
    };
  });
  const currencies = new Set(items.map((i) => i.currency));
  const priced = items.length > 0 && items.every((i) => i.itemPrice !== null) && currencies.size === 1;
  const total = priced ? Math.round(items.reduce((sum, i) => sum + i.quantity * (i.itemPrice ?? 0), 0) * 100) / 100 : null;
  const currency = priced ? (items[0].currency ?? null) : null;
  const text = str(order.text)?.slice(0, 1000) ?? null;
  const count = items.reduce((sum, i) => sum + i.quantity, 0);
  const price = (value: number, cur: string | null) => `${amount(value)}${cur ? ` ${cur}` : ""}`;
  const lines = [`[order] ${plural(count, "item")}${total !== null ? `, total ${price(total, currency)}` : ""}`];
  for (const i of items.slice(0, MAX_ORDER_LINES)) lines.push(`${i.quantity} x ${i.productRetailerId || "item"}${i.itemPrice !== null ? ` at ${price(i.itemPrice, i.currency)}` : ""}`);
  if (items.length > MAX_ORDER_LINES) lines.push(`and ${plural(items.length - MAX_ORDER_LINES, "more product")}`);
  if (text) lines.push(`Note: ${text}`);
  return { type: "order", body: lines.join("\n"), order: { catalogId: str(order.catalog_id)?.slice(0, 100) ?? null, text, items, total, currency } };
}

/** "[contacts] Priya Sharma: +91 98765 43210", one line per card when several are shared. */
export function describeContacts(cards: unknown[]): ParsedMessage {
  const contacts: SharedContact[] = cards.slice(0, MAX_CONTACT_CARDS).map((raw) => {
    const c = asRec(raw);
    const n = asRec(c.name);
    const name = str(n.formatted_name) ?? ([str(n.first_name), str(n.last_name)].filter(Boolean).join(" ") || null);
    const phones = asArr(c.phones)
      .slice(0, MAX_CONTACT_PHONES)
      .map((p) => {
        const r = asRec(p);
        const waId = str(r.wa_id)?.replace(/\D/g, "").slice(0, 20) || null;
        return { phone: (str(r.phone) ?? (waId ? `+${waId}` : "")).slice(0, 40), waId, type: str(r.type)?.slice(0, 20) ?? null };
      })
      .filter((p) => p.phone);
    return { name: name?.slice(0, 200) ?? null, phones };
  });
  const line = (c: SharedContact) => `${c.name ?? "No name"}${c.phones.length ? `: ${c.phones.map((p) => p.phone).join(", ")}` : ""}`;
  const body =
    contacts.length === 0 ? "[contacts]" : contacts.length === 1 ? `[contacts] ${line(contacts[0])}` : [`[contacts] ${plural(contacts.length, "contact")}`, ...contacts.map(line)].join("\n");
  return { type: "contacts", body, contacts };
}

const NUMBER_CHANGED = new Set(["user_changed_number", "customer_changed_number"]);
const IDENTITY_CHANGED = new Set(["user_identity_changed", "customer_identity_changed"]);

/**
 * A WhatsApp system notice. The body never repeats Meta's own text: it carries the customer's profile name and both phone numbers,
 * which teammates who see masked numbers must not read. newWaId is Meta's `wa_id` (or the older `new_wa_id`).
 */
export function describeSystem(system: Rec): ParsedMessage {
  const kind = (str(system.type) ?? "").toLowerCase();
  if (NUMBER_CHANGED.has(kind)) {
    const newWaId = (str(system.wa_id) ?? str(system.new_wa_id) ?? "").replace(/\D/g, "") || null;
    return { type: "system", body: "[number changed]", system: { event: "number_changed", newWaId } };
  }
  if (IDENTITY_CHANGED.has(kind)) return { type: "system", body: "[security code changed]", system: { event: "identity_changed", newWaId: null } };
  return { type: "system", body: "[system notice]", system: { event: "other", newWaId: null } };
}

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
    case "reaction": {
      const r = asRec(message.reaction);
      const emoji = str(r.emoji) ?? "";
      return { type, body: emoji ? `[reaction] ${emoji}` : "[reaction removed]", reaction: { emoji, messageId: str(r.message_id) ?? null } };
    }
    case "order":
      return describeOrder(asRec(message.order));
    case "contacts":
      return describeContacts(asArr(message.contacts));
    case "system":
      return describeSystem(asRec(message.system));
    default:
      return { type, body: `[${type}]` };
  }
}

/**
 * The STOP words every workspace honours (owner default 1). A message counts only when the WHOLE message is one of them after
 * normalisation (case, punctuation and extra spaces do not matter, and "opt-out" or "optout" read as "opt out"), so "cancel my
 * order" or "please do not stop" is an ordinary message. Each workspace can add its own words in Inbox settings (stopWords).
 * An opt-out stops marketing only (src/lib/contacts/opt-out.ts).
 */
export const DEFAULT_STOP_WORDS: readonly string[] = ["stop", "stop all", "unsubscribe", "opt out", "cancel", "end", "quit"];
/** Limits for the words a workspace adds. */
export const MAX_WORKSPACE_STOP_WORDS = 20;
export const MAX_STOP_WORD_LENGTH = 40;

/**
 * Lower case, punctuation and symbols removed, spaces collapsed. Combining marks (\p{M}) stay: in Hindi and other Indic scripts they
 * are part of the word (the matras and anusvara of बंद करो), and dropping them would make रोको (stop) and रुको (wait) the same word.
 * Variation selectors and the keycap mark belong to an emoji, and a mark left with no letter before it belongs to nothing, so those go.
 */
export const normalizeOptOutText = (body: string) =>
  body
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[︀-️⃣\u{E0100}-\u{E01EF}]/gu, "")
    .replace(/(?<![\p{L}\p{M}\p{N}])\p{M}+/gu, "")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

/** Spaces removed, so "opt out", "opt-out" and "optout" (and "stop all" and "stopall") compare equal. */
const compact = (text: string) => text.replace(/ /g, "");

/**
 * Where the words of an inbound message come from, for the STOP words:
 * - "typed": the customer's own text. Every STOP word counts.
 * - "template_button": a tap on a template's quick-reply button. The business wrote that text, and order and booking templates often
 *   offer "Cancel", so the everyday words (AMBIGUOUS_STOP_WORDS) do not count; stop, stop all, unsubscribe, opt out and the
 *   workspace's own words do, and so does Meta's Stop promotions button (isOptOutButton).
 * - "tapped_choice": a tapped reply button or list row of an interactive message. Also the business's wording, so never a STOP.
 */
export type StopSource = "typed" | "template_button" | "tapped_choice";

export function stopSourceOf(messageType: string | null | undefined, replyId?: string | null): StopSource {
  // Only a tapped reply button or list row carries a reply id (describeMessage).
  if (replyId) return "tapped_choice";
  if (messageType === "button") return "template_button";
  return "typed";
}

/** Default STOP words that are also everyday actions ("Cancel" a booking, "End" a chat): a template button with this text is not a STOP. */
export const AMBIGUOUS_STOP_WORDS: readonly string[] = ["cancel", "end", "quit"];

/** The default STOP words that only ever mean stop. */
const UNAMBIGUOUS_STOP_WORDS = DEFAULT_STOP_WORDS.filter((w) => !AMBIGUOUS_STOP_WORDS.includes(w));

/**
 * True when the whole message is a STOP word: one of DEFAULT_STOP_WORDS or one of the workspace's own words (`extraWords`, as stored
 * in Inbox settings). Never true for an empty message. `source` says where the words came from (stopSourceOf): a template button
 * counts only for the unambiguous words and the workspace's own, and a tapped reply button or list row never counts.
 */
export function isStopMessage(body: string, extraWords: readonly string[] | null | undefined = [], source: StopSource = "typed"): boolean {
  if (source === "tapped_choice") return false;
  const text = compact(normalizeOptOutText(body));
  if (!text) return false;
  const defaults = source === "template_button" ? UNAMBIGUOUS_STOP_WORDS : DEFAULT_STOP_WORDS;
  for (const word of [...defaults, ...(extraWords ?? [])]) {
    const w = compact(normalizeOptOutText(word));
    if (w && w === text) return true;
  }
  return false;
}

/** The longest message, in words, that is checked for a possible opt-out request. */
export const POSSIBLE_OPT_OUT_MAX_WORDS = 8;
const POSSIBLE_OPT_OUT_WORDS = new Set(UNAMBIGUOUS_STOP_WORDS.map(compact));

/**
 * A short typed message that contains stop, stop all, unsubscribe or opt out but is not only that word: "stop please", "please stop
 * sending offers", "unsubscribe me". Only the whole message opts out (owner default 1), so this does not; the chat gets a note so the
 * team can decide, and the AI agent leaves it to them. Cancel, end and quit are everyday words, so "cancel my order" is not one.
 */
export function mightBeOptOutRequest(body: string): boolean {
  const words = normalizeOptOutText(body).split(" ").filter(Boolean);
  if (words.length < 2 || words.length > POSSIBLE_OPT_OUT_MAX_WORDS || isStopMessage(body)) return false;
  return words.some((w, i) => POSSIBLE_OPT_OUT_WORDS.has(w) || (i + 1 < words.length && POSSIBLE_OPT_OUT_WORDS.has(w + words[i + 1])));
}

/**
 * The text of Meta's marketing opt-out quick-reply button on a template ("Stop promotions" by default). Tapping it is the customer
 * asking for no more marketing, so it counts as a STOP whatever the STOP words; only a template button (type "button") counts.
 */
export const OPT_OUT_BUTTON_TEXTS: readonly string[] = ["stop promotions"];

export function isOptOutButton(parsed: Pick<ParsedMessage, "type" | "body">): boolean {
  return parsed.type === "button" && OPT_OUT_BUTTON_TEXTS.includes(normalizeOptOutText(parsed.body));
}

/**
 * Whether a message is short enough to be any STOP word at all. The webhook reads the workspace's own words only for such a
 * message, so a normal message costs no extra read.
 */
export function mightBeStopWord(body: string): boolean {
  const text = normalizeOptOutText(body);
  return text.length > 0 && text.length <= MAX_STOP_WORD_LENGTH;
}

/**
 * Checks one word a workspace wants to add and returns it normalised, or the reason it cannot be used. A word that is already a
 * default, or that is a START word (it would opt the person out and back in at once), is refused.
 */
export function checkStopWord(raw: unknown): { ok: true; word: string } | { ok: false; reason: string } {
  if (typeof raw !== "string") return { ok: false, reason: "Each STOP word must be text." };
  const word = normalizeOptOutText(raw);
  if (!word) return { ok: false, reason: "A STOP word needs at least one letter or number." };
  if (word.length > MAX_STOP_WORD_LENGTH) return { ok: false, reason: `Keep each STOP word to ${MAX_STOP_WORD_LENGTH} characters or fewer.` };
  if (isStartMessage(word)) return { ok: false, reason: `"${word}" is the word people send to get offers again, so it cannot also be a STOP word.` };
  return { ok: true, word };
}

/**
 * The workspace's own STOP words as stored: normalised, without duplicates or defaults, at most MAX_WORKSPACE_STOP_WORDS. Anything
 * unusable is dropped quietly (the settings form validates with checkStopWord before saving).
 */
export function cleanStopWords(raw: unknown, max: number = MAX_WORKSPACE_STOP_WORDS): string[] {
  if (!Array.isArray(raw)) return [];
  const defaults = new Set(DEFAULT_STOP_WORDS.map((w) => compact(w)));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const checked = checkStopWord(item);
    if (!checked.ok) continue;
    const key = compact(checked.word);
    if (defaults.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(checked.word);
    if (out.length >= max) break;
  }
  return out;
}

/** Every word that opts a contact out in this workspace: the defaults first, then the workspace's own. */
export function effectiveStopWords(extraWords: readonly string[] | null | undefined): string[] {
  return [...DEFAULT_STOP_WORDS, ...cleanStopWords(extraWords ?? [])];
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
