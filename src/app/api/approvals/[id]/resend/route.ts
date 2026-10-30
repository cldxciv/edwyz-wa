import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { readJsonLimited } from "@/lib/http/body";
import { errorResponse, HttpError } from "@/lib/tenancy";
import { loadOwnedApproval } from "@/lib/approvals/access";
import { resendUserLimiter } from "@/lib/approvals/guards";
import { resendApproval, type ResendInput } from "@/lib/approvals/resend";

const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

/** Rotates the link (the old one stops working) and sends the new one to the given number by WhatsApp, only on this explicit call. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const { id } = await ctx.params;
    const body = await readJsonLimited(request, 4096);
    const phone = str(body.phone, 40);
    const phoneNumberId = str(body.phoneNumberId, 100);
    if (!phone) throw new HttpError(400, "Enter the phone number to send to.");
    let input: ResendInput;
    if (body.mode === "text") input = { mode: "text", phone, phoneNumberId };
    else if (body.mode === "template" && str(body.templateId, 100)) input = { mode: "template", phone, phoneNumberId, templateId: str(body.templateId, 100)! };
    else throw new HttpError(400, "Choose text or an approved template.");
    const hours = typeof body.expiresInHours === "number" ? body.expiresInHours : undefined;
    await loadOwnedApproval(actor, id);
    if (!resendUserLimiter.consume(`${actor.tenantId}:${actor.userId}`)) throw new HttpError(429, "Too many sends. Please wait before trying again.");
    return Response.json(await resendApproval(actor, id, input, hours));
  } catch (e) {
    return errorResponse(e);
  }
}
