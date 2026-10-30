import { checkWebhookHandshake, verifyWebhookSignature } from "@/lib/meta";
import { readTextLimited } from "@/lib/http/body";
import { extractLeadJobs, LEAD_QUEUE } from "@/lib/leads/ingest";
import { enqueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_000_000;
const noStore = { "Cache-Control": "no-store" };

export function GET(request: Request) {
  const result = checkWebhookHandshake(new URL(request.url).searchParams, process.env.META_VERIFY_TOKEN);
  if (!result.ok) return new Response("Forbidden", { status: 403, headers: noStore });
  return new Response(result.challenge, { status: 200, headers: { "Content-Type": "text/plain", ...noStore } });
}

export async function POST(request: Request) {
  let rawBody: string;
  try {
    rawBody = await readTextLimited(request, MAX_BODY_BYTES);
  } catch {
    return new Response("Payload too large", { status: 413, headers: noStore });
  }
  if (!verifyWebhookSignature(rawBody, request.headers.get("x-hub-signature-256"), process.env.META_APP_SECRET)) {
    console.warn("[leads-webhook] rejected a request with a missing or invalid signature");
    return new Response("Invalid signature", { status: 401, headers: noStore });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return new Response("Bad request", { status: 400, headers: noStore });
  }
  try {
    for (const job of extractLeadJobs(parsed)) await enqueue(LEAD_QUEUE, job);
  } catch {
    console.error("[leads-webhook] could not enqueue, asking Meta to retry");
    return new Response("Temporarily unavailable", { status: 500, headers: noStore });
  }
  return new Response("OK", { status: 200, headers: noStore });
}
