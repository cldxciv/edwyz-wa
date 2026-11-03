import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/queue";
import { checkWebhookHandshake, verifyWebhookSignature } from "@/lib/meta";
import { readTextLimited } from "@/lib/http/body";
import { requestLogger } from "@/lib/log";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 3_500_000;
const noStore = { "Cache-Control": "no-store" };

export function GET(request: Request) {
  const result = checkWebhookHandshake(new URL(request.url).searchParams, process.env.META_VERIFY_TOKEN);
  if (!result.ok) return new Response("Forbidden", { status: 403, headers: noStore });
  return new Response(result.challenge, { status: 200, headers: { "Content-Type": "text/plain", ...noStore } });
}

export async function POST(request: Request) {
  const { log } = requestLogger(request, { route: "webhooks.whatsapp" });
  let rawBody: string;
  try {
    rawBody = await readTextLimited(request, MAX_BODY_BYTES);
  } catch {
    return new Response("Payload too large", { status: 413, headers: noStore });
  }

  const valid = verifyWebhookSignature(rawBody, request.headers.get("x-hub-signature-256"), process.env.META_APP_SECRET);
  if (!valid) {
    log.warn("webhook.signature_rejected");
    return new Response("Invalid signature", { status: 401, headers: noStore });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return new Response("Bad request", { status: 400, headers: noStore });
  }

  try {
    const event = await prisma.webhookEvent.create({ data: { payload: parsed as object, signatureValid: true } });
    await enqueue("webhook", { eventId: event.id });
  } catch (error) {
    // Meta retries a 5xx, so nothing is lost; the line says why (kind and a scrubbed message, never the payload).
    log.error("webhook.store_failed", { err: error });
    return new Response("Temporarily unavailable", { status: 500, headers: noStore });
  }
  return new Response("OK", { status: 200, headers: noStore });
}
