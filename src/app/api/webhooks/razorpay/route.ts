import { WEBHOOK_MAX_BYTES, handleRazorpayWebhook } from "@/lib/billing/webhook";
import { readTextLimited } from "@/lib/http/body";
import { HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  let raw: string;
  try {
    raw = await readTextLimited(request, WEBHOOK_MAX_BYTES);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 400;
    return new Response("Rejected", { status, headers: noStore });
  }
  try {
    const result = await handleRazorpayWebhook(raw, request.headers);
    if (result.status === 401) console.warn("[razorpay-webhook] rejected a request with a missing or invalid signature");
    return new Response(result.body, { status: result.status, headers: noStore });
  } catch {
    console.error("[razorpay-webhook] unexpected failure");
    return new Response("Error", { status: 500, headers: noStore });
  }
}
