/**
 * The single source of truth for the compatibility API. Route files, the runtime (scope, write flag), the public
 * documentation and the OpenAPI document all read this table; tests assert that the files under src/app/api/ext/v3 match it exactly.
 */
import type { ApiScope } from "@/lib/integrations/scopes";

export const COMPAT_BASE_PATH = "/api/ext/v3";

export type CompatScope = ApiScope;
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";
export type Field = { name: string; type: string; required?: boolean; description: string };

export type EndpointSpec = {
  id: string;
  method: HttpMethod;
  /** Relative to COMPAT_BASE_PATH. `{name}` segments are path parameters. */
  path: string;
  /** The scope the endpoint is documented under. A key holding it, or any scope that satisfies it (see integrations/scopes.ts), may call it. */
  scope: CompatScope;
  /** Further scopes that also open this endpoint on their own. */
  anyOf?: readonly CompatScope[];
  group: "Contacts" | "Conversations" | "Templates" | "Broadcasts" | "Webhooks";
  summary: string;
  query?: Field[];
  body?: Field[];
  /** Name of the key holding the array in a list response, or a short description of the object returned. */
  returns: string;
  paginated?: boolean;
};

const page: Field[] = [
  { name: "page_number", type: "integer", description: "1-based page. Default 1. page_number x page_size must not exceed 10,000 (400 beyond that)." },
  { name: "page_size", type: "integer", description: "Items per page, 1 to 100. Default 20." },
];

const customParams: Field = {
  name: "custom_params",
  type: "array of { name, value }",
  description: "Contact attributes. A null value removes the attribute on update.",
};

export const ENDPOINTS = [
  {
    id: "contacts.list",
    method: "GET",
    path: "/contacts",
    scope: "contacts:read",
    group: "Contacts",
    summary: "List contacts, newest first.",
    query: [...page, { name: "tag", type: "string", description: "Only contacts carrying this tag." }, { name: "search", type: "string", description: "Matches name or phone number." }],
    returns: "contact_list",
    paginated: true,
  },
  {
    id: "contacts.count",
    method: "GET",
    path: "/contacts/count",
    scope: "contacts:read",
    group: "Contacts",
    summary: "Count contacts, optionally only those with a tag or matching a search.",
    query: [
      { name: "tag", type: "string", description: "Only contacts carrying this tag." },
      { name: "search", type: "string", description: "Matches name or phone number." },
    ],
    returns: "count",
  },
  {
    id: "contacts.get",
    method: "GET",
    path: "/contacts/{target}",
    scope: "contacts:read",
    group: "Contacts",
    summary: "Get one contact by phone number, contact id, external_id:<value> or bsuid:<value>.",
    returns: "contact",
  },
  {
    id: "contacts.create",
    method: "POST",
    path: "/contacts",
    scope: "contacts:write",
    group: "Contacts",
    summary: "Create a contact. Answers 409 when the phone number or external id already exists.",
    body: [
      { name: "phone_number", type: "string", required: true, description: "Digits with country code; a leading + is optional." },
      { name: "name", type: "string", description: "Display name, up to 200 characters." },
      { name: "external_id", type: "string", description: "Your own identifier, stored as an attribute and usable as external_id:<value> in paths." },
      { name: "tags", type: "array of string", description: "Up to 50 tags." },
      customParams,
      { name: "opt_in", type: "boolean", description: "Set true only if the person agreed to receive messages." },
      { name: "opt_in_source", type: "string", description: "Where the consent was collected. Required when opt_in is true." },
    ],
    returns: "contact",
  },
  {
    id: "contacts.update",
    method: "PUT",
    path: "/contacts/{target}",
    scope: "contacts:write",
    group: "Contacts",
    summary: "Change name, tags or attributes. Attributes are merged, tags are replaced when sent.",
    body: [
      { name: "name", type: "string", description: "New display name." },
      { name: "tags", type: "array of string", description: "Replaces the full tag list." },
      customParams,
    ],
    returns: "contact",
  },
  {
    id: "contacts.delete",
    method: "DELETE",
    path: "/contacts/{target}",
    scope: "contacts:write",
    group: "Contacts",
    summary: "Delete a contact together with its conversations and messages. This cannot be undone.",
    returns: "ok",
  },
  {
    id: "contacts.addTags",
    method: "POST",
    path: "/contacts/{target}/tags",
    scope: "contacts:write",
    group: "Contacts",
    summary: "Add tags to a contact, keeping the ones it already has.",
    body: [{ name: "tags", type: "array of string", required: true, description: "Tags to add." }],
    returns: "contact",
  },
  {
    id: "contacts.removeTag",
    method: "DELETE",
    path: "/contacts/{target}/tags/{tag}",
    scope: "contacts:write",
    group: "Contacts",
    summary: "Remove one tag from a contact. Removing a tag the contact lacks succeeds.",
    returns: "contact",
  },
  {
    id: "contacts.updateAttributes",
    method: "PUT",
    path: "/contacts/{target}/attributes",
    scope: "contacts:write",
    group: "Contacts",
    summary: "Merge attributes into a contact without touching name or tags.",
    body: [{ ...customParams, required: true }],
    returns: "contact",
  },
  {
    id: "conversations.list",
    method: "GET",
    path: "/conversations",
    scope: "conversations:read",
    group: "Conversations",
    summary: "List conversations, most recently active first.",
    query: [
      ...page,
      { name: "status", type: "string", description: "open, pending, solved or blocked." },
      { name: "target", type: "string", description: "Only conversations of this contact (phone, id, external_id:<value> or bsuid:<value>)." },
    ],
    returns: "conversation_list",
    paginated: true,
  },
  {
    id: "conversations.get",
    method: "GET",
    path: "/conversations/{target}",
    scope: "conversations:read",
    group: "Conversations",
    summary: "One conversation by conversation id, or the most recently active one of a contact (phone, contact id, external_id:<value> or bsuid:<value>).",
    returns: "conversation",
  },
  {
    id: "conversations.messages",
    method: "GET",
    path: "/conversations/{target}/messages",
    scope: "conversations:read",
    group: "Conversations",
    summary: "Message history, newest first. The target is a conversation id, or a contact whose conversations are all included.",
    query: page,
    returns: "message_list",
    paginated: true,
  },
  {
    id: "conversations.sendText",
    method: "POST",
    path: "/conversations/{target}/messages/text",
    scope: "messages:write",
    anyOf: ["conversations:write"],
    group: "Conversations",
    summary: "Send a session (free-form) message to a conversation id or a contact (phone, contact id, external_id:<value> or bsuid:<value>). Needs an open 24-hour window; answers 409 otherwise.",
    body: [
      { name: "text", type: "string", required: true, description: "Message text, up to 4096 characters." },
      { name: "channel", type: "string", description: "Meta phone_number_id to send from. Defaults to your first connected number." },
      { name: "local_message_id", type: "string", description: "Your own id. A repeat of the same id to the same recipient within 24 hours returns the first result and sends nothing; the same id with a different message answers 422." },
    ],
    returns: "message",
  },
  {
    id: "conversations.setStatus",
    method: "PUT",
    path: "/conversations/{target}/status",
    scope: "conversations:write",
    group: "Conversations",
    summary: "Change the status of a conversation.",
    body: [{ name: "status", type: "string", required: true, description: "open, pending, solved or blocked." }],
    returns: "conversation",
  },
  {
    id: "conversations.assign",
    method: "PUT",
    path: "/conversations/{target}/assignee",
    scope: "conversations:write",
    group: "Conversations",
    summary: "Assign a conversation to a member of the workspace, or unassign it.",
    body: [{ name: "user_id", type: "string or null", required: true, description: "Id of a workspace member, or null to unassign." }],
    returns: "conversation",
  },
  {
    id: "conversations.addTags",
    method: "POST",
    path: "/conversations/{target}/tags",
    scope: "conversations:write",
    group: "Conversations",
    summary: "Add tags to a conversation, keeping the ones it already has.",
    body: [{ name: "tags", type: "array of string", required: true, description: "Up to 10 tags of up to 40 characters each." }],
    returns: "conversation",
  },
  {
    id: "conversations.removeTag",
    method: "DELETE",
    path: "/conversations/{target}/tags/{tag}",
    scope: "conversations:write",
    group: "Conversations",
    summary: "Remove one tag from a conversation. Removing a tag the conversation lacks succeeds.",
    returns: "conversation",
  },
  {
    id: "templates.list",
    method: "GET",
    path: "/messageTemplates",
    scope: "templates:read",
    group: "Templates",
    summary: "List message templates.",
    query: [...page, { name: "status", type: "string", description: "draft, pending, approved, rejected, paused or disabled." }],
    returns: "message_template_list",
    paginated: true,
  },
  {
    id: "templates.get",
    method: "GET",
    path: "/messageTemplates/{id}",
    scope: "templates:read",
    group: "Templates",
    summary: "One message template by id, with its components and review status.",
    returns: "message_template",
  },
  {
    id: "templates.send",
    method: "POST",
    path: "/messageTemplates/send",
    scope: "messages:write",
    group: "Templates",
    summary:
      "Send an approved template to up to 100 recipients, including templates with a media header, a link button, a coupon-code button or a login code. Each recipient is answered on its own: accepted means we queued the message for sending, not that it was delivered. Follow delivery with the message.status webhook or the message history.",
    body: [
      { name: "template_name", type: "string", required: true, description: "Name of an approved template." },
      { name: "language", type: "string", description: "Template language code. Needed only when the name exists in several languages." },
      { name: "broadcast_name", type: "string", description: "Accepted for compatibility and echoed back; no broadcast record is created." },
      { name: "channel", type: "string", description: "Meta phone_number_id to send from." },
      {
        name: "recipients",
        type: "array",
        required: true,
        description:
          "Each item: phone_number, or bsuid for a person who messaged you through a WhatsApp username (one of the two is required), local_message_id (optional, dedupes for 24 hours), " +
          "custom_params (array of { name, value } for the message text: they fill {{1}}, {{2}}... in order, or by number when every name is a number; a template with named placeholders such as {{first_name}} takes them by name, and every placeholder needs one), " +
          "header_param (text for a header placeholder, or the public https link of an image, video or document header), " +
          "button_params (array of { index, value }, index counting the template's buttons from 0: the value for a link button whose url has a placeholder, or the code of a coupon-code button). " +
          "A login-code (authentication) template takes the code as custom_params {{1}} (name \"1\"); its copy-code button gets the same code unless button_params gives one.",
      },
    ],
    returns: "per-recipient results",
  },
  {
    id: "broadcasts.list",
    method: "GET",
    path: "/broadcasts",
    scope: "broadcasts:read",
    group: "Broadcasts",
    summary: "List broadcasts with delivery counts.",
    query: page,
    returns: "broadcast_list",
    paginated: true,
  },
  {
    id: "broadcasts.get",
    method: "GET",
    path: "/broadcasts/{id}",
    scope: "broadcasts:read",
    group: "Broadcasts",
    summary: "One broadcast with its delivery status summary.",
    returns: "broadcast",
  },
  {
    id: "broadcasts.recipients",
    method: "GET",
    path: "/broadcasts/{id}/recipients",
    scope: "broadcasts:read",
    group: "Broadcasts",
    summary: "Per-recipient delivery status.",
    query: [...page, { name: "status", type: "string", description: "pending, queued, sent, delivered, read, failed or skipped." }],
    returns: "recipient_list",
    paginated: true,
  },
  {
    id: "webhooks.eventTypes",
    method: "GET",
    path: "/webhooks/event-types",
    scope: "webhooks:manage",
    group: "Webhooks",
    summary: "Event names you can subscribe to.",
    returns: "event_types",
  },
  {
    id: "webhooks.list",
    method: "GET",
    path: "/webhooks",
    scope: "webhooks:manage",
    group: "Webhooks",
    summary: "List webhook subscriptions.",
    query: page,
    returns: "webhook_list",
    paginated: true,
  },
  {
    id: "webhooks.create",
    method: "POST",
    path: "/webhooks",
    scope: "webhooks:manage",
    group: "Webhooks",
    summary: "Subscribe a public HTTPS URL. The signing secret is returned once.",
    body: [
      { name: "url", type: "string", required: true, description: "Public https URL." },
      { name: "event_types", type: "array of string", required: true, description: "Names from the event-types endpoint." },
      { name: "status", type: "string", description: "enabled (default) or disabled." },
    ],
    returns: "webhook",
  },
  {
    id: "webhooks.get",
    method: "GET",
    path: "/webhooks/{id}",
    scope: "webhooks:manage",
    group: "Webhooks",
    summary: "One webhook subscription.",
    returns: "webhook",
  },
  {
    id: "webhooks.update",
    method: "PUT",
    path: "/webhooks/{id}",
    scope: "webhooks:manage",
    group: "Webhooks",
    summary: "Change the URL, events or status. Enabling resets the failure count.",
    body: [
      { name: "url", type: "string", description: "New public https URL." },
      { name: "event_types", type: "array of string", description: "Replaces the subscribed events." },
      { name: "status", type: "string", description: "enabled or disabled." },
    ],
    returns: "webhook",
  },
  {
    id: "webhooks.delete",
    method: "DELETE",
    path: "/webhooks/{id}",
    scope: "webhooks:manage",
    group: "Webhooks",
    summary: "Delete a subscription and its delivery log.",
    returns: "ok",
  },
  {
    id: "webhooks.test",
    method: "POST",
    path: "/webhooks/{id}/test",
    scope: "webhooks:manage",
    group: "Webhooks",
    summary: "Queue a signed test event to this subscription.",
    returns: "delivery_id",
  },
] as const satisfies readonly EndpointSpec[];

export type EndpointId = (typeof ENDPOINTS)[number]["id"];

export const endpointById = (id: string): EndpointSpec => {
  const found = (ENDPOINTS as readonly EndpointSpec[]).find((e) => e.id === id);
  if (!found) throw new Error(`unknown compat endpoint ${id}`);
  return found;
};

/** The scopes the endpoint is declared with: the primary one first, then any alternatives. */
export const endpointScopes = (e: EndpointSpec): CompatScope[] => [e.scope, ...(e.anyOf ?? [])];

/** GET requests never need the billing write check; everything else does. */
export const isWrite = (e: EndpointSpec) => e.method !== "GET";

export const RATE_LIMIT_REQUESTS = 30;
export const RATE_LIMIT_WINDOW_SECONDS = 10;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_TEMPLATE_RECIPIENTS = 100;
export const IDEMPOTENCY_HOURS = 24;

export const ERROR_CODES = [
  { status: 400, code: "invalid_request", meaning: "A field is missing or malformed." },
  { status: 401, code: "unauthorized", meaning: "Missing, revoked or malformed token." },
  { status: 402, code: "payment_required", meaning: "The workspace trial or subscription has ended, so writes are refused until a plan is chosen. Reads keep working." },
  { status: 403, code: "forbidden", meaning: "The token has none of the scopes this endpoint accepts, or the workspace is suspended." },
  { status: 404, code: "not_found", meaning: "No such record in your workspace, or no such endpoint." },
  { status: 409, code: "conflict", meaning: "The request clashes with current state, for example a duplicate contact or a closed 24-hour window." },
  { status: 413, code: "payload_too_large", meaning: "The body exceeds 64 KB." },
  { status: 422, code: "unprocessable", meaning: "Understood but refused, for example a marketing template to a contact who opted out, or a contact with no phone number." },
  { status: 429, code: "rate_limited", meaning: "Too many requests; wait for Retry-After seconds." },
  { status: 500, code: "internal_error", meaning: "Something failed on our side. Safe to retry reads." },
] as const;

export const routeFilePath = (path: string) => `src/app/api/ext/v3${path.replace(/\{(\w+)\}/g, "[$1]")}/route.ts`;
