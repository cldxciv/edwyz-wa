import { WEBHOOK_MAX_BYTES, handleRazorpayWebhook } from "@/lib/billing/webhook";
import { readTextLimited } from "@/lib/http/body";
import { requestLogger } from "@/lib/log";
import { HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  const { log } = requestLogger(request, { route: "webhooks.razorpay" });
  let raw: string;
  try {
    raw = await readTextLimited(request, WEBHOOK_MAX_BYTES);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 400;
    return new Response("Rejected", { status, headers: noStore });
  }
  try {
    const result = await handleRazorpayWebhook(raw, request.headers);
    if (result.status === 401) log.warn("razorpay.signature_rejected");
    return new Response(result.body, { status: result.status, headers: noStore });
  } catch (error) {
    // Razorpay retries a 5xx. The line carries the error kind and a scrubbed message, never the payment payload.
    log.error("razorpay.webhook_failed", { err: error });
    return new Response("Error", { status: 500, headers: noStore });
  }
}
