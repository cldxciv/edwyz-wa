import { mayReceive, OPTED_OUT_OF_MARKETING, sendKindForCategory } from "@/lib/contacts/opt-out";
import { prisma } from "@/lib/db";
import { DEFAULT_ORIGIN, type SendOrigin } from "@/lib/spend/messaging/origin";
import { HttpError } from "@/lib/tenancy";
import { sendTemplateMessage } from "./service";
import { bodyText, buildBodyComponents, checkVariables, fillTemplate, inlineSendable } from "./template-vars";

type Sender = { tenantId: string; userId: string };

/**
 * Who pressed send: a member in the inbox ("human") or a member confirming Eddy's card ("eddy"). There is no default person: a
 * caller that does not say is "unknown", which the send gate treats as automated (docs/SPEND-CONTROLS-SPEC.md 4.9, rule B13).
 */
export type MemberSendOrigin = Extract<SendOrigin, "human" | "eddy">;

export const OTHER_ACCOUNT_TEMPLATE = "This template belongs to a different WhatsApp business account than the number this chat uses, so WhatsApp would refuse it. Pick one of this number's templates.";

/**
 * Sends an approved template into an existing conversation. Allowed inside and outside the 24-hour window. The template must
 * belong to the WhatsApp Business Account of the chat's number: WhatsApp refuses one that exists only under another account
 * (132001), so that is answered here, before anything is queued.
 */
export async function sendConversationTemplate(actor: Sender, conversationId: string, input: { templateId: string; variables: unknown }, opts: { origin?: MemberSendOrigin } = {}) {
  const { tenantId } = actor;
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    select: { id: true, phoneNumberId: true, contactId: true, contact: { select: { optIn: true, optedOutAt: true } }, phoneNumber: { select: { wabaRefId: true } } },
  });
  if (!conversation) throw new HttpError(404, "Conversation not found.");

  const template = await prisma.template.findFirst({ where: { id: input.templateId, tenantId } });
  if (!template) throw new HttpError(404, "Template not found.");
  // An opt-out stops marketing only (lib/contacts/opt-out.ts): an order update or login code still goes.
  if (!mayReceive(conversation.contact, sendKindForCategory(template.category))) throw new HttpError(422, OPTED_OUT_OF_MARKETING);
  const numberWaba = conversation.phoneNumber?.wabaRefId;
  if (numberWaba && template.wabaRefId && template.wabaRefId !== numberWaba) throw new HttpError(422, OTHER_ACCOUNT_TEMPLATE);
  if (template.status !== "approved") throw new HttpError(409, "Only approved templates can be sent.");
  if (template.category === "MARKETING" && !conversation.contact.optIn) {
    throw new HttpError(422, "This contact has not opted in to marketing messages. Pick a utility template or record their opt-in first.");
  }

  const fit = inlineSendable(template.components);
  if (!fit.ok) throw new HttpError(422, fit.reason);
  const checked = checkVariables(input.variables, fit.variables);
  if (!checked.ok) throw new HttpError(400, checked.error);

  const message = await sendTemplateMessage({
    tenantId,
    phoneNumberId: conversation.phoneNumberId,
    contactId: conversation.contactId,
    templateName: template.name,
    language: template.language,
    components: buildBodyComponents(checked.values),
    conversationId: conversation.id,
    userId: actor.userId,
    origin: opts.origin ?? DEFAULT_ORIGIN,
  });
  const rendered = fillTemplate(bodyText(template.components), checked.values).slice(0, 4096);
  if (rendered) await prisma.message.updateMany({ where: { id: message.id, tenantId }, data: { body: rendered } });
  return { ...message, body: rendered || message.body };
}
