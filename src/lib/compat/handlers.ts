import * as broadcasts from "./broadcasts";
import * as contacts from "./contacts";
import * as conversations from "./conversations";
import * as messaging from "./messaging";
import { run, type Handler } from "./runtime";
import type { EndpointId } from "./spec";
import * as webhooks from "./webhooks";

/** Every spec id must appear here; the type enforces it. */
export const HANDLERS: Record<EndpointId, Handler> = {
  "contacts.list": contacts.listContacts,
  "contacts.count": contacts.countContacts,
  "contacts.get": contacts.getContact,
  "contacts.create": contacts.createContact,
  "contacts.update": contacts.putContact,
  "contacts.delete": contacts.removeContact,
  "contacts.addTags": contacts.addTags,
  "contacts.removeTag": contacts.removeTag,
  "contacts.updateAttributes": contacts.putAttributes,
  "conversations.list": conversations.listConversations,
  "conversations.get": conversations.getConversation,
  "conversations.messages": messaging.listMessages,
  "conversations.sendText": messaging.sendText,
  "conversations.setStatus": conversations.setConversationStatus,
  "conversations.assign": conversations.assignConversation,
  "conversations.addTags": conversations.addConversationTags,
  "conversations.removeTag": conversations.removeConversationTag,
  "templates.list": messaging.listTemplatesHandler,
  "templates.get": messaging.getTemplate,
  "templates.send": messaging.sendTemplate,
  "broadcasts.list": broadcasts.listBroadcasts,
  "broadcasts.get": broadcasts.getBroadcastHandler,
  "broadcasts.recipients": broadcasts.listRecipients,
  "webhooks.eventTypes": webhooks.eventTypes,
  "webhooks.list": webhooks.listWebhooks,
  "webhooks.create": webhooks.createWebhook,
  "webhooks.get": webhooks.getWebhook,
  "webhooks.update": webhooks.putWebhook,
  "webhooks.delete": webhooks.removeWebhook,
  "webhooks.test": webhooks.testWebhook,
};

type RouteContext = { params: Promise<Record<string, string>> };

/** Used by every file under src/app/api/ext/v3: `export const GET = route("contacts.list")`. */
export const route = (id: EndpointId) => async (request: Request, context?: RouteContext) =>
  run(id, HANDLERS[id], request, context ? await context.params : {});
