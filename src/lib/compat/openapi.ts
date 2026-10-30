/**
 * Builds the OpenAPI 3.1 document of the public API from the endpoint table in spec.ts and the event catalogue in
 * integrations/payloads.ts. Nothing here is written by hand per endpoint, so the document cannot drift from the routes
 * (tests/compat-openapi.test.ts checks it against the table and the files).
 */
import { acceptedScopes, API_SCOPES } from "@/lib/integrations/scopes";
import { EVENT_CATALOG, type EventDoc } from "@/lib/integrations/payloads";
import { COMPAT_BASE_PATH, DEFAULT_PAGE_SIZE, ENDPOINTS, ERROR_CODES, type EndpointSpec, type Field, MAX_PAGE_SIZE, RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_SECONDS } from "./spec";

type Json = Record<string, unknown>;

const SCOPE_TEXT: Record<string, string> = {
  "messages:write": "Send session messages and approved templates.",
  "contacts:read": "Read contacts.",
  "contacts:write": "Create, change and delete contacts. Also allows reading them.",
  "templates:read": "Read message templates. Also granted by messages:write.",
  "conversations:read": "Read conversations and message history.",
  "conversations:write": "Change conversation status, assignee and tags. Also allows reading conversations and sending session text.",
  "broadcasts:read": "Read broadcasts and their recipients.",
  "webhooks:manage": "Create and change webhook subscriptions.",
};

/** Maps the short type words used in the endpoint table to JSON Schema. */
export function schemaForType(type: string): Json {
  const t = type.trim();
  if (t === "string or null") return { type: ["string", "null"] };
  if (t === "string") return { type: "string" };
  if (t === "integer") return { type: "integer" };
  if (t === "boolean") return { type: "boolean" };
  if (t === "array of string") return { type: "array", items: { type: "string" } };
  if (t.startsWith("array of {")) {
    return { type: "array", items: { type: "object", required: ["name"], properties: { name: { type: "string" }, value: { type: ["string", "number", "boolean", "null"] } } } };
  }
  if (t === "array") return { type: "array", items: { type: "object" } };
  return {};
}

function parameter(where: "query" | "path", f: Field & { required?: boolean }): Json {
  return { name: f.name, in: where, required: where === "path" ? true : Boolean(f.required), description: f.description, schema: schemaForType(f.type) };
}

function pathParams(path: string): Json[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => {
    const name = m[1];
    const description = name === "target" ? "Phone number, contact id, external_id:<value>, bsuid:<value> or a conversation id, as the endpoint describes." : `The ${name}.`;
    return parameter("path", { name, type: "string", description });
  });
}

function requestBody(fields: readonly Field[] | undefined): Json | undefined {
  if (!fields?.length) return undefined;
  const properties: Json = {};
  for (const f of fields) properties[f.name] = { ...schemaForType(f.type), description: f.description };
  const required = fields.filter((f) => f.required).map((f) => f.name);
  return { required: required.length > 0, content: { "application/json": { schema: { type: "object", properties, ...(required.length ? { required } : {}) } } } };
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const SINGLE_SCHEMA: Record<string, string> = {
  contact: "Contact",
  conversation: "Conversation",
  message: "Message",
  message_template: "MessageTemplate",
  broadcast: "Broadcast",
  webhook: "Webhook",
};

const ITEM_SCHEMA: Record<string, string> = {
  contact_list: "Contact",
  conversation_list: "Conversation",
  message_list: "Message",
  message_template_list: "MessageTemplate",
  broadcast_list: "Broadcast",
  recipient_list: "BroadcastRecipient",
  webhook_list: "Webhook",
};

function okSchema(e: EndpointSpec): Json {
  const properties: Json = { ok: { const: true } };
  if (e.paginated) {
    properties[e.returns] = { type: "array", items: ITEM_SCHEMA[e.returns] ? ref(ITEM_SCHEMA[e.returns]) : { type: "object" } };
    Object.assign(properties, {
      page_number: { type: "integer" },
      page_size: { type: "integer" },
      total: { type: "integer" },
      has_more: { type: "boolean" },
      window_exhausted: { type: "boolean", description: "True when more rows exist beyond the 10,000-row paging window. Narrow the list with filters." },
    });
    return { type: "object", required: ["ok", e.returns, "page_number", "page_size", "total", "has_more"], properties };
  }
  if (e.id === "templates.send") return { allOf: [ref("TemplateSendResult"), { type: "object", properties: { ok: { const: true } } }] };
  if (SINGLE_SCHEMA[e.returns]) properties[e.returns] = ref(SINGLE_SCHEMA[e.returns]);
  else if (e.returns === "count") properties.count = { type: "integer" };
  else if (e.returns === "event_types") properties.event_types = { type: "array", items: { type: "string" } };
  else if (e.returns === "delivery_id") properties.delivery_id = { type: "string" };
  if (e.id === "webhooks.create") properties.signing_secret = { type: "string", description: "Shown once. Store it to verify deliveries." };
  return { type: "object", required: ["ok"], properties };
}

function successStatus(e: EndpointSpec): string {
  if (e.id === "contacts.create" || e.id === "webhooks.create") return "201";
  if (e.id === "conversations.sendText" || e.id === "webhooks.test") return "202";
  return "200";
}

function responsesFor(e: EndpointSpec): Json {
  const out: Json = {
    [successStatus(e)]: { description: "Success.", content: { "application/json": { schema: okSchema(e) } } },
  };
  const wanted = new Set([400, 401, 403, 429, 500]);
  if (isWrite(e)) wanted.add(402);
  if (e.path.includes("{")) wanted.add(404);
  if (e.method === "POST" || e.method === "PUT") wanted.add(413);
  if (e.id === "contacts.create" || e.id === "conversations.sendText") wanted.add(409);
  if (e.id === "conversations.sendText" || e.id === "templates.send") wanted.add(422);
  for (const c of ERROR_CODES) if (wanted.has(c.status)) out[String(c.status)] = { $ref: `#/components/responses/Error${c.status}` };
  return out;
}

const isWrite = (e: EndpointSpec) => e.method !== "GET";

function operation(e: EndpointSpec): Json {
  const accepted = acceptedScopes([e.scope, ...(e.anyOf ?? [])]);
  const body = requestBody(e.body);
  return {
    operationId: e.id,
    tags: [e.group],
    summary: e.summary,
    description: `Needs an API key holding ${accepted.length === 1 ? `the ${accepted[0]} scope` : `one of these scopes: ${accepted.join(", ")}`}.${isWrite(e) ? " Writes are refused with 402 while the workspace trial or subscription has ended." : ""}`,
    security: accepted.map((s) => ({ bearerAuth: [s] })),
    "x-accepted-scopes": accepted,
    parameters: [...pathParams(e.path), ...(e.query ?? []).map((f) => parameter("query", f))],
    ...(body ? { requestBody: body } : {}),
    responses: responsesFor(e),
  };
}

function errorResponses(): Json {
  const out: Json = {};
  for (const c of ERROR_CODES) {
    out[`Error${c.status}`] = {
      description: `${c.code}: ${c.meaning}`,
      ...(c.status === 429 ? { headers: { "Retry-After": { description: "Seconds to wait.", schema: { type: "integer" } } } } : {}),
      content: { "application/json": { schema: ref("Error") } },
    };
  }
  return out;
}

const nullableString = { type: ["string", "null"] };
const dateTime = { type: ["string", "null"], format: "date-time" };

function schemas(): Json {
  return {
    Error: {
      type: "object",
      required: ["ok", "error", "timestamp"],
      properties: {
        ok: { const: false },
        error: { type: "object", required: ["code", "message"], properties: { code: { type: "string", enum: ERROR_CODES.map((c) => c.code) }, message: { type: "string" } } },
        timestamp: { type: "string", format: "date-time" },
      },
    },
    Contact: {
      type: "object",
      properties: {
        id: { type: "string" },
        phone_number: { ...nullableString, description: "Null for people who message through a WhatsApp username." },
        external_id: nullableString,
        bsuid: { ...nullableString, description: "WhatsApp business-scoped user id." },
        username: nullableString,
        wa_id: nullableString,
        name: nullableString,
        tags: { type: "array", items: { type: "string" } },
        custom_params: schemaForType("array of { name, value }"),
        opt_in: { type: "boolean" },
        opted_out_at: dateTime,
        created: dateTime,
      },
    },
    Conversation: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: ["open", "pending", "solved", "blocked"] },
        tags: { type: "array", items: { type: "string" } },
        unread_count: { type: "integer" },
        assigned_to: nullableString,
        team_id: nullableString,
        window_open: { type: "boolean", description: "True while a free-form reply is allowed (24 hours after the customer's last message)." },
        last_message_at: dateTime,
        last_inbound_at: dateTime,
        first_agent_reply_at: dateTime,
        last_agent_reply_at: dateTime,
        created: dateTime,
        contact: ref("Contact"),
      },
    },
    Message: { type: "object", additionalProperties: true, description: "A stored message with its direction, type, body, status and timestamps." },
    MessageTemplate: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        language: { type: "string" },
        category: { type: "string" },
        status: { type: "string" },
        components: { type: "array", items: { type: "object" } },
        rejection_reason: nullableString,
        created: dateTime,
      },
    },
    Broadcast: { type: "object", additionalProperties: true },
    BroadcastRecipient: { type: "object", additionalProperties: true },
    Webhook: { type: "object", additionalProperties: true },
    TemplateSendResult: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        broadcast_id: { type: "null", description: "Always null: no broadcast record is created for API sends." },
        broadcast_name: nullableString,
        error: nullableString,
        accepted_count: { type: "integer" },
        rejected_count: { type: "integer" },
        delivery_note: { type: "string" },
        recipients: {
          type: "array",
          items: {
            type: "object",
            properties: {
              local_message_id: { ...nullableString, description: "Your own id for this recipient, echoed back; null when you sent none." },
              phone_number: nullableString,
              bsuid: nullableString,
              accepted: { type: "boolean", description: "We took the message and queued it. It is not a delivery confirmation." },
              status: { type: "string" },
              message_id: nullableString,
              conversation_id: nullableString,
              deduplicated: { type: "boolean" },
              errors: { type: ["array", "null"], items: { type: "string" }, description: "null for an accepted recipient." },
              error_status: { type: ["integer", "null"], description: "HTTP-style status of the rejection; null for an accepted recipient." },
            },
            required: ["local_message_id", "phone_number", "bsuid", "accepted", "status", "message_id", "conversation_id", "deduplicated", "errors", "error_status"],
          },
        },
      },
    },
    WebhookEnvelope: {
      type: "object",
      required: ["id", "event", "createdAt", "data"],
      properties: { id: { type: "string" }, event: { type: "string" }, createdAt: { type: "string", format: "date-time" }, data: { type: "object" } },
    },
  };
}

/** A documented field type ("string or null", "integer", "object") as JSON Schema. */
function leafSchema(type: string): Json {
  const nullable = / or null$/.test(type);
  const base = type.replace(/ or null$/, "");
  const name = ["string", "integer", "boolean", "object"].includes(base) ? base : "string";
  return { type: nullable ? [name, "null"] : name };
}

/** Turns the documented dot paths of one event (contact.id, totals.sent) into a nested JSON Schema. */
export function eventDataSchema(doc: EventDoc): Json {
  const root: Json = { type: "object", properties: {} };
  for (const f of doc.fields) {
    const parts = f.name.split(".");
    let node = root;
    for (const [i, part] of parts.entries()) {
      const props = (node.properties ??= {}) as Json;
      if (i < parts.length - 1) {
        node = (props[part] ??= { type: "object" }) as Json;
      } else {
        props[part] = { ...((props[part] as Json | undefined) ?? {}), ...leafSchema(f.type), description: f.description };
      }
    }
  }
  return root;
}

function webhooks(): Json {
  const out: Json = {};
  for (const doc of EVENT_CATALOG) {
    out[doc.event] = {
      post: {
        operationId: `webhook.${doc.event}`,
        tags: ["Webhook events"],
        summary: doc.title,
        description: `${doc.when} Every delivery is signed; see /docs/webhooks. Answer any 2xx within 10 seconds.`,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { allOf: [ref("WebhookEnvelope"), { type: "object", properties: { event: { const: doc.event }, data: eventDataSchema(doc) } }] },
              example: { id: "3f1c0b5e-0000-4000-8000-000000000000", event: doc.event, createdAt: "2026-10-27T10:15:00.000Z", data: doc.sample },
            },
          },
        },
        responses: { "200": { description: "Any 2xx status acknowledges the delivery." } },
      },
    };
  }
  return out;
}

export function buildOpenApi(origin: string): Json {
  const paths: Json = {};
  for (const e of ENDPOINTS as readonly EndpointSpec[]) {
    const item = (paths[e.path] ??= {}) as Json;
    item[e.method.toLowerCase()] = operation(e);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Edwyz WA API",
      version: "3.0.0",
      summary: "Contacts, conversations, session and template messages, broadcasts and webhooks for a WhatsApp Business workspace.",
      description: `Authenticate with an API key from Settings, API: Authorization: Bearer wak_... . Limits: ${RATE_LIMIT_REQUESTS} requests per ${RATE_LIMIT_WINDOW_SECONDS} seconds per key, lists of ${DEFAULT_PAGE_SIZE} by default and ${MAX_PAGE_SIZE} at most. Free-form messages need an open 24-hour window; marketing templates need the recipient's opt-in.`,
    },
    servers: [{ url: `${origin.replace(/\/+$/, "")}${COMPAT_BASE_PATH}` }],
    tags: [...new Set<string>(ENDPOINTS.map((e) => e.group)), "Webhook events"].map((name) => ({ name })),
    security: [{ bearerAuth: [] }],
    paths,
    webhooks: webhooks(),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "API key (wak_...)",
          description: `An API key sent as a bearer token. The key must hold one of the scopes an operation lists. Scopes: ${API_SCOPES.map((s) => `${s} (${SCOPE_TEXT[s]})`).join(" ")}`,
        },
      },
      schemas: schemas(),
      responses: errorResponses(),
    },
  };
}
