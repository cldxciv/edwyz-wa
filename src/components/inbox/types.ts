import type { InboxMessage } from "./helpers";

export type Contact = { id: string; phone: string | null; bsuid?: string | null; username?: string | null; waId?: string | null; name: string | null; optIn: boolean; optedOutAt: string | null; attributes?: unknown; createdAt?: string };

export type ConversationSummary = {
  id: string;
  status: string;
  tags: string[];
  unreadCount: number;
  lastMessageAt: string;
  lastInboundAt: string | null;
  assignedToId: string | null;
  contact: Contact;
  referral?: unknown;
  /** Derived: "new" = the customer wrote and no teammate has replied; "campaign" = the last thing they got was a broadcast. */
  labels?: ("new" | "campaign")[];
  /** The signed-in agent's own markers for this chat. */
  flags?: { favorite: boolean; unread: boolean; mention: boolean };
  /** An excerpt of the message that matched the search text, when the match was in a message. */
  matchSnippet?: string | null;
  messages: Pick<InboxMessage, "id" | "direction" | "type" | "body" | "status" | "createdAt">[];
};

export type ConversationDetail = {
  conversation: Omit<ConversationSummary, "messages"> & { phoneNumber?: { displayPhone: string; verifiedName: string | null } };
  windowOpen: boolean;
  messages: InboxMessage[];
  nextCursor: string | null;
};

export type Member = { userId: string; name: string; email: string; role: string };
export type Me = { user: { id: string; name: string }; role: "owner" | "admin" | "agent" };
export type QuickReply = { id: string; shortcut: string; body: string };
export type Note = { id: string; authorId: string; body: string; createdAt: string };

export type TemplateOption = { id: string; name: string; language: string; category: string; status: string; components: unknown };

export type ConversationContext = {
  lead: null | {
    id: string;
    status: string;
    createdAt: string;
    formName: string | null;
    adMetaId: string | null;
    campaignMetaId: string | null;
    consentAt: string | null;
    assignedToId: string | null;
    fields: { label: string; value: string }[];
  };
  stats: { messages: number; received: number; firstContactAt: string };
  otherChats: { id: string; status: string; lastMessageAt: string; unreadCount: number; number: string | null }[];
};

export type SavedView = { id: string; name: string; query: { tab: string; tag?: string; q?: string }; shared: boolean; mine: boolean };
export type Mention = { conversationId: string; contactName: string | null; phone: string | null; bsuid?: string | null; username?: string | null; mentionedAt: string };
export type BusinessNumber = { id: string; displayPhone: string; verifiedName: string | null };
/** stopWords: the workspace's own STOP words, on top of the defaults (lib/webhooks/payload.ts DEFAULT_STOP_WORDS). */
export type InboxSettings = { agentSignature: boolean; optOutReply: string; optInReply: string; stopWords?: string[] };
