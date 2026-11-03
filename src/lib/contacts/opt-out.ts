/*
 * The opt-out rule (owner default 1, accepted 2026-10-31). A contact who opted out (replied STOP or a workspace STOP word, was
 * marked opted out in the dashboard or through the API, or went through a chatbot's unsubscribe step) gets NO MARKETING:
 * marketing templates, marketing broadcasts and follow-ups, and rule or chatbot steps that send a marketing template are refused.
 * Utility and authentication templates (order and delivery updates, login codes) still go, and so do replies inside the 24-hour
 * customer service window (a teammate's reply, the AI agent, a chatbot or a rule answering a message the customer sent).
 *
 * Every gate that used to read optedOutAt asks mayReceive instead, so the rule lives here and nowhere else. The marketing opt-in is
 * a separate rule (a marketing template also needs a recorded opt-in), checked by each gate next to this one. Pure: no database,
 * safe to import from client components.
 */

/** What is about to be sent: a template of one of Meta's categories, or a free-form reply inside the service window. */
export type SendKind = "marketing" | "utility" | "authentication" | "service";
export type TemplateSendKind = Exclude<SendKind, "service">;

/** Either the stored column or a boolean flag (the chatbot engine, Eddy and the MCP summaries carry `optedOut`). */
export type OptOutState = { optedOutAt?: Date | string | null; optedOut?: boolean | null };

export function isOptedOut(contact: OptOutState | null | undefined): boolean {
  return !!contact && (!!contact.optedOutAt || contact.optedOut === true);
}

/**
 * Whether this contact may receive this kind of message as far as the opt-out goes. Only marketing is blocked. A missing contact has
 * no opt-out on record, so it passes here; the caller decides what a missing contact means (usually 404).
 */
export function mayReceive(contact: OptOutState | null | undefined, kind: SendKind): boolean {
  return kind !== "marketing" || !isOptedOut(contact);
}

/**
 * True when the contact opted out at or after `since`: for example while a chatbot conversation was already running. The STOP
 * answered that conversation, so it ends and sends nothing more; a later message from the customer starts afresh (and is answered).
 * False without a start time (every stored chatbot session has one: ChatbotSession.startedAt defaults to now()).
 */
export function optedOutSince(contact: { optedOutAt?: Date | string | null } | null | undefined, since: Date | string | null | undefined): boolean {
  const at = contact?.optedOutAt ? new Date(contact.optedOutAt).getTime() : Number.NaN;
  const from = since ? new Date(since).getTime() : Number.NaN;
  return Number.isFinite(at) && Number.isFinite(from) && at >= from;
}

/**
 * The kind of a template send, from the category stored on the template (or stamped on the queued message). Fails closed: a missing
 * or unknown category is marketing, the same way the send gate prices and consents an unknown template.
 */
export function sendKindForCategory(category: string | null | undefined): TemplateSendKind {
  const c = typeof category === "string" ? category.trim().toUpperCase() : "";
  if (c.startsWith("UTILITY")) return "utility";
  if (c.startsWith("AUTHENTICATION")) return "authentication";
  return "marketing";
}

/**
 * The same rule as a database filter on Contact, for audiences and batch queries: opted-out contacts are left out only when the
 * send is marketing.
 */
export function receivableWhere(kind: SendKind): { optedOutAt: null } | Record<string, never> {
  return kind === "marketing" ? { optedOutAt: null } : {};
}

// ===== Copy =====
// Every place that explains an opt-out says the same three things: no marketing messages; order updates and replies to their own
// messages can still arrive; send START to get offers again.

/** The default confirmation sent to the customer after STOP (inbox settings optOutReply). */
export const OPT_OUT_REPLY = "You will not get marketing messages from us any more. Order updates and replies to your own messages can still arrive. Send START to get offers again.";
/** The default confirmation sent to the customer after START (inbox settings optInReply). */
export const OPT_IN_REPLY = "You will get offers from us again. Send STOP at any time to stop marketing messages.";

/** For the team: what an opt-out means for this contact. */
export const OPT_OUT_EFFECT = "They get no marketing messages. Order updates and replies to their own messages can still arrive. They can send START to get offers again.";

/** A send refused because the contact opted out and the template is marketing. */
export const OPTED_OUT_OF_MARKETING =
  "This contact opted out of marketing messages. Send a utility template, like an order update, or reply when they write to you. They can send START to get offers again.";

/** The short label used in lists and badges. */
export const OPTED_OUT_LABEL = "Opted out of marketing";

/** Automation screens: what rules do for a contact who opted out (rules still answer them; only marketing templates are skipped). */
export const OPT_OUT_RULES = "People who opted out get no marketing templates from rules. Replies to their own messages and utility templates, like order updates, still go.";
/** Scheduled rules, which walk contacts one by one. */
export const OPT_OUT_SCHEDULED = "People who opted out are skipped when the rule sends a marketing template.";

/**
 * The private note on a chat whose message may be an opt-out request without being a STOP word ("stop please",
 * lib/webhooks/payload.ts mightBeOptOutRequest). Only the team can tell, so the AI agent does not answer it.
 */
export const POSSIBLE_OPT_OUT_NOTE =
  "Possible opt-out request. If they want no more marketing messages, ask Eddy to record their opt-out. The AI agent left this message for your team to answer.";
