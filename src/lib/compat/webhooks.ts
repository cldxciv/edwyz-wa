import { prisma } from "@/lib/db";
import { createEndpoint, deleteEndpoint, listEndpoints, sendTestEvent, updateEndpoint } from "@/lib/integrations/endpoints";
import { WEBHOOK_EVENTS } from "@/lib/integrations/events";
import { HttpError } from "@/lib/tenancy";
import { iso, pageJson, parsePaging } from "./common";
import type { Handler } from "./runtime";

type Endpoint = { id: string; url: string; events: string[]; enabled: boolean; failureCount: number; createdAt: Date };

const view = (e: Endpoint) => ({
  id: e.id,
  url: e.url,
  event_types: e.events,
  status: e.enabled ? "enabled" : "disabled",
  failure_count: e.failureCount,
  created: iso(e.createdAt),
});

function parseStatus(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== "enabled" && value !== "disabled") throw new HttpError(400, 'status must be "enabled" or "disabled".');
  return value === "enabled";
}

export const eventTypes: Handler = async () => ({ json: { event_types: [...WEBHOOK_EVENTS] } });

export const listWebhooks: Handler = async ({ actor, query }) => {
  const paging = parsePaging(query);
  const all = await listEndpoints(actor.tenantId);
  return { json: pageJson("webhook_list", all.slice(paging.skip, paging.skip + paging.take).map(view), paging, all.length) };
};

async function load(tenantId: string, id: string) {
  const row = await prisma.webhookEndpoint.findFirst({ where: { id, tenantId }, select: { id: true, url: true, events: true, enabled: true, failureCount: true, createdAt: true } });
  if (!row) throw new HttpError(404, "Webhook not found.");
  return row;
}

export const getWebhook: Handler = async ({ actor, params }) => ({ json: { webhook: view(await load(actor.tenantId, params.id)) } });

export const createWebhook: Handler = async ({ actor, body }) => {
  const input = await body();
  const enabled = parseStatus(input.status);
  const { endpoint, secret } = await createEndpoint(actor.tenantId, { url: input.url, events: input.event_types });
  const final = enabled === false ? ((await updateEndpoint(actor.tenantId, endpoint.id, { enabled: false })) ?? endpoint) : endpoint;
  return { status: 201, json: { webhook: view(final), signing_secret: secret } };
};

export const putWebhook: Handler = async ({ actor, params, body }) => {
  const input = await body();
  const enabled = parseStatus(input.status);
  if (input.url === undefined && input.event_types === undefined && enabled === undefined) throw new HttpError(400, "Send at least one of url, event_types or status.");
  const updated = await updateEndpoint(actor.tenantId, params.id, {
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.event_types !== undefined ? { events: input.event_types } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  });
  if (!updated) throw new HttpError(404, "Webhook not found.");
  return { json: { webhook: view(updated) } };
};

export const removeWebhook: Handler = async ({ actor, params }) => {
  await deleteEndpoint(actor.tenantId, params.id);
  return { json: {} };
};

export const testWebhook: Handler = async ({ actor, params }) => {
  const { deliveryId } = await sendTestEvent(actor.tenantId, params.id);
  return { status: 202, json: { delivery_id: deliveryId } };
};
