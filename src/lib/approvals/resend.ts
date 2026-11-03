import { mayReceive, OPTED_OUT_OF_MARKETING, sendKindForCategory } from "@/lib/contacts/opt-out";
import { normalizePhone } from "@/lib/contacts/phone";
import { prisma } from "@/lib/db";
import { sendTemplateMessage, sendText } from "@/lib/inbox/service";
import { isWithinServiceWindow } from "@/lib/inbox/window";
import { HttpError, type Actor } from "@/lib/tenancy";
import { reissueApproval } from "./index";

export type ResendInput =
  | { phone: string; mode: "text"; phoneNumberId?: string }
  | { phone: string; mode: "template"; templateId: string; phoneNumberId?: string };

async function pickPhoneNumber(tenantId: string, phoneNumberId?: string) {
  const phone = await prisma.phoneNumber.findFirst({
    where: { tenantId, ...(phoneNumberId ? { id: phoneNumberId } : { status: { not: "pending" } }) },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!phone) throw new HttpError(404, "No connected WhatsApp number was found.");
  return phone;
}

/**
 * Sends a fresh link to a phone number the user typed. Never automatic: only called from the explicit resend route.
 * Text needs an open 24-hour window; a template needs an approved template and a contact who opted in.
 * Preconditions are checked before the link is rotated, so a refused send leaves the existing link working.
 */
export async function resendApproval(actor: Actor, approvalId: string, input: ResendInput, expiresInHours?: number): Promise<{ sent: true }> {
  const { tenantId } = actor;
  const phoneE164 = normalizePhone(input.phone);
  if (!phoneE164) throw new HttpError(400, "Enter a valid phone number with country code.");
  const [contact, phone] = await Promise.all([
    prisma.contact.findFirst({ where: { tenantId, phone: phoneE164 }, select: { id: true, optIn: true, optedOutAt: true } }),
    pickPhoneNumber(tenantId, input.phoneNumberId),
  ]);
  if (!contact) throw new HttpError(409, "This number is not one of your contacts yet. Add the contact first.");
  // An opt-out stops marketing only (lib/contacts/opt-out.ts): a link in the open window, or a non-marketing template, still goes.
  if (!mayReceive(contact, "service")) throw new HttpError(409, OPTED_OUT_OF_MARKETING);

  if (input.mode === "text") {
    const conversation = await prisma.conversation.findFirst({
      where: { tenantId, contactId: contact.id, phoneNumberId: phone.id },
      select: { id: true, lastInboundAt: true },
    });
    if (!conversation || !isWithinServiceWindow(conversation.lastInboundAt)) {
      throw new HttpError(409, "The 24-hour customer service window is closed. Send an approved template message instead.");
    }
    const { url } = await reissueApproval(tenantId, approvalId, expiresInHours, actor.userId);
    await sendText({ tenantId, conversationId: conversation.id, userId: actor.userId, body: `Please review and respond here: ${url}`, origin: "approval" });
    return { sent: true };
  }

  if (!contact.optIn) throw new HttpError(409, "This contact has not opted in to template messages.");
  const template = await prisma.template.findFirst({ where: { id: input.templateId, tenantId, status: "approved" }, select: { name: true, language: true, category: true } });
  if (!template) throw new HttpError(404, "Approved template not found.");
  if (!mayReceive(contact, sendKindForCategory(template.category))) throw new HttpError(409, OPTED_OUT_OF_MARKETING);
  const { url } = await reissueApproval(tenantId, approvalId, expiresInHours, actor.userId);
  await sendTemplateMessage({
    tenantId,
    phoneNumberId: phone.id,
    contactId: contact.id,
    templateName: template.name,
    language: template.language,
    components: [{ type: "body", parameters: [{ type: "text", text: url }] }],
    userId: actor.userId,
    origin: "approval",
  });
  return { sent: true };
}
