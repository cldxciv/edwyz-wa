import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto/tokens";
import type { JobContext } from "@/lib/queue";
import { asRec, str } from "@/lib/webhooks/payload";
import { assertPublicUrl, defaultResolver, type Resolver } from "./ssrf";
import { notifyEndpointDisabled } from "./notify";
import { signPayload } from "./signing";

export const DELIVERY_TIMEOUT_MS = 10_000;
export const DISABLE_AFTER_FAILURES = 20;

export type OutboundRequest = { url: URL; address: string; headers: Record<string, string>; body: string; timeoutMs: number };
export type Transport = (req: OutboundRequest) => Promise<{ status: number }>;

/** POSTs to the already-validated address (so a DNS change after the check cannot redirect us), never follows redirects. */
export const pinnedTransport: Transport = (req) =>
  new Promise((resolve, reject) => {
    const family = isIP(req.address) === 6 ? 6 : 4;
    const call = httpsRequest(
      {
        method: "POST",
        hostname: req.url.hostname.replace(/^\[|\]$/g, ""),
        port: req.url.port || 443,
        path: `${req.url.pathname}${req.url.search}`,
        headers: { ...req.headers, "content-length": Buffer.byteLength(req.body).toString() },
        timeout: req.timeoutMs,
        lookup: (_host, options, callback) => {
          if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: req.address, family }]);
          else callback(null, req.address, family);
        },
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
        res.destroy();
      },
    );
    call.on("timeout", () => call.destroy(new Error("timeout")));
    call.on("error", reject);
    call.end(req.body);
  });

export type DeliverDeps = { resolve?: Resolver; transport?: Transport; now?: () => number };

type Outcome = { ok: true; status: number } | { ok: false; status?: number; error: string; permanent?: boolean };

async function attempt(
  endpoint: { url: string; secretCiphertext: string; iv: string; authTag: string },
  delivery: { id: string; event: string; payload: unknown },
  deps: DeliverDeps,
): Promise<Outcome> {
  let target;
  try {
    target = await assertPublicUrl(endpoint.url, deps.resolve ?? defaultResolver);
  } catch {
    return { ok: false, error: "blocked: destination is not a public https address", permanent: true };
  }
  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor((deps.now?.() ?? Date.now()) / 1000).toString();
  const secret = decrypt({ ciphertext: endpoint.secretCiphertext, iv: endpoint.iv, authTag: endpoint.authTag });
  try {
    const { status } = await (deps.transport ?? pinnedTransport)({
      url: target.url,
      address: target.addresses[0],
      timeoutMs: DELIVERY_TIMEOUT_MS,
      body,
      headers: {
        "content-type": "application/json",
        "user-agent": "Edwyz-Webhooks/1.0",
        "x-edwyz-event": delivery.event,
        "x-edwyz-delivery": delivery.id,
        "x-edwyz-timestamp": timestamp,
        "x-edwyz-signature": signPayload(secret, timestamp, body),
      },
    });
    if (status >= 200 && status < 300) return { ok: true, status };
    return { ok: false, status, error: status >= 300 && status < 400 ? "redirects are not followed" : `receiver answered ${status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.message === "timeout" ? "timed out" : "connection failed" };
  }
}

/** Handles one "outbound-webhook" job. Throws to let the queue retry; marks failed (and maybe disables the endpoint) on the last attempt. */
export async function processDelivery(payload: unknown, context?: JobContext, deps: DeliverDeps = {}): Promise<void> {
  const job = asRec(payload);
  const deliveryId = str(job.deliveryId);
  const tenantId = str(job.tenantId);
  if (!deliveryId || !tenantId) return;

  const delivery = await prisma.webhookDelivery.findFirst({ where: { id: deliveryId, tenantId } });
  if (!delivery || delivery.status === "delivered" || delivery.status === "failed") return;
  const endpoint = await prisma.webhookEndpoint.findFirst({ where: { id: delivery.endpointId, tenantId } });
  const attempts = delivery.attempts + 1;

  if (!endpoint || !endpoint.enabled) {
    await prisma.webhookDelivery.updateMany({ where: { id: delivery.id, tenantId }, data: { status: "failed", attempts, lastError: "endpoint missing or disabled" } });
    return;
  }

  const outcome = await attempt(endpoint, delivery, deps);

  if (outcome.ok) {
    await prisma.webhookDelivery.updateMany({ where: { id: delivery.id, tenantId }, data: { status: "delivered", attempts, lastStatus: outcome.status, lastError: null } });
    if (endpoint.failureCount > 0) await prisma.webhookEndpoint.updateMany({ where: { id: endpoint.id, tenantId }, data: { failureCount: 0 } });
    return;
  }

  const final = outcome.permanent || context?.isLastAttempt !== false;
  await prisma.webhookDelivery.updateMany({
    where: { id: delivery.id, tenantId },
    data: { status: final ? "failed" : "retrying", attempts, lastStatus: outcome.status ?? null, lastError: outcome.error },
  });
  if (!final) throw new Error(outcome.error);

  const failureCount = endpoint.failureCount + 1;
  await prisma.webhookEndpoint.updateMany({
    where: { id: endpoint.id, tenantId },
    data: { failureCount, ...(failureCount >= DISABLE_AFTER_FAILURES ? { enabled: false } : {}) },
  });
  if (failureCount >= DISABLE_AFTER_FAILURES) await notifyEndpointDisabled({ tenantId, endpointId: endpoint.id, url: endpoint.url, failures: failureCount });
}
