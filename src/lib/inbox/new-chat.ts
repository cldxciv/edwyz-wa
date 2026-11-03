import { audit } from "@/lib/auth/audit";
import { emitAutomationEvent } from "@/lib/automation/v2/emit";
import { assertWithinLimit } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { normalizeBsuid } from "@/lib/contacts/identity";
import { normalizePhone } from "@/lib/contacts/phone";
import { assertConversationVisible } from "@/lib/teams/visibility";
import { hasRole, HttpError, type Actor } from "@/lib/tenancy";
import { sendConversationTemplate, type MemberSendOrigin } from "./template-send";

export type StartChatInput = {
  phone?: unknown;
  /** A WhatsApp user id (BSUID). Only a person who already messaged this workspace has one on file, so it must match an existing contact. */
  bsuid?: unknown;
  contactId?: unknown;
  name?: unknown;
  /** PhoneNumber.id of the business number to write from. Optional when the workspace has exactly one connected number. */
  phoneNumberId?: unknown;
  templateId?: unknown;
  variables?: unknown;
  /** An admin states that the person agreed to receive marketing messages. Recorded as the contact's opt-in with source agent_confirmed. */
  confirmOptIn?: unknown;
};

const text = (value: unknown, max: number, label: string): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max) throw new HttpError(400, `${label} must be text of up to ${max} characters.`);
  return value.trim() || undefined;
};

async function pickNumber(tenantId: string, requested: unknown) {
  const id = text(requested, 64, "phoneNumberId");
  if (id) {
    const phone = await prisma.phoneNumber.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!phone) throw new HttpError(404, "Phone number not found.");
    return phone.id;
  }
  const numbers = await prisma.phoneNumber.findMany({ where: { tenantId, status: "connected" }, select: { id: true }, take: 5 });
  if (numbers.length === 0) throw new HttpError(409, "Connect a WhatsApp number in Settings before you start a chat.");
  if (numbers.length > 1) throw new HttpError(400, "Choose which number to send from.");
  return numbers[0].id;
}

type ContactRow = { id: string; optIn: boolean; optInSource: string | null; optInAt: Date | null; optedOutAt: Date | null };

/** Finds the contact by id, WhatsApp user id or phone, creating one by phone when needed (also used by the admin test-message panel). */
export async function resolveContact(tenantId: string, input: StartChatInput): Promise<{ contact: ContactRow; created: boolean }> {
  const select = { id: true, optIn: true, optInSource: true, optInAt: true, optedOutAt: true } as const;
  const contactId = text(input.contactId, 64, "contactId");
  if (contactId) {
    const found = await prisma.contact.findFirst({ where: { id: contactId, tenantId }, select });
    if (!found) throw new HttpError(404, "Contact not found.");
    return { contact: found, created: false };
  }
  const rawBsuid = text(input.bsuid, 140, "bsuid");
  if (rawBsuid) {
    const bsuid = normalizeBsuid(rawBsuid);
    if (!bsuid) throw new HttpError(400, "That is not a WhatsApp user id. It looks like US.1234567890.");
    const known = await prisma.contact.findFirst({ where: { tenantId, bsuid }, select });
    if (!known) throw new HttpError(404, "No contact has this WhatsApp user id yet. A user id can only be used after that person has messaged you.");
    return { contact: known, created: false };
  }
  const raw = text(input.phone, 40, "phone");
  const phone = raw ? normalizePhone(raw) : null;
  if (!phone) throw new HttpError(400, "Enter a number with country code, like +91 98765 43210.");
  const existing = await prisma.contact.findFirst({ where: { tenantId, phone }, select });
  if (existing) return { contact: existing, created: false };
  await assertWithinLimit(tenantId, "contacts");
  try {
    const contact = await prisma.contact.create({ data: { tenantId, phone, name: text(input.name, 100, "name") ?? null }, select });
    return { contact, created: true };
  } catch (e) {
    if ((e as { code?: string })?.code !== "P2002") throw e;
    const raced = await prisma.contact.findFirst({ where: { tenantId, phone }, select });
    if (!raced) throw e;
    return { contact: raced, created: false };
  }
}

/**
 * Starts (or continues) a chat from the inbox by sending an approved template to a phone number or an existing contact. The
 * opt-out and marketing opt-in rules are enforced inside sendConversationTemplate and sendTemplateMessage. The chat is assigned to
 * the agent who started it when it has no owner. A contact or chat created here is removed again if the send is refused, and an
 * opt-in an admin confirmed for this send is taken back. When the contact already has a chat on that number, the caller must be
 * allowed to see it (team and view-only-assigned rules), otherwise the answer is the same 404 as for any hidden chat.
 */
export async function startChat(actor: Actor, input: StartChatInput, opts: { origin?: MemberSendOrigin } = {}) {
  const { tenantId, userId } = actor;
  const templateId = text(input.templateId, 100, "templateId");
  if (!templateId) throw new HttpError(400, "Choose a template to send.");
  if (input.confirmOptIn !== undefined && typeof input.confirmOptIn !== "boolean") throw new HttpError(400, "confirmOptIn must be true or false.");
  if (input.confirmOptIn === true && !hasRole(actor, "admin")) throw new HttpError(403, "Only an admin can record that someone agreed to receive marketing messages.");

  const phoneNumberId = await pickNumber(tenantId, input.phoneNumberId);
  const { contact, created: createdContact } = await resolveContact(tenantId, input);
  const undo = async (conversationCreated: boolean, conversationId?: string) => {
    try {
      if (conversationCreated && conversationId) {
        await prisma.conversation.deleteMany({ where: { id: conversationId, tenantId } });
        await prisma.conversationMark.deleteMany({ where: { tenantId, conversationId } });
      }
      if (createdContact) await prisma.contact.deleteMany({ where: { id: contact.id, tenantId } });
    } catch {
      console.error("[inbox] could not remove the unused contact after a refused new chat");
    }
  };

  const existing = await prisma.conversation.findFirst({ where: { tenantId, phoneNumberId, contactId: contact.id }, select: { id: true, assignedToId: true } });
  if (existing) await assertConversationVisible(actor, existing.id);

  if (input.confirmOptIn === true && contact.optedOutAt) throw new HttpError(422, "This contact opted out of marketing messages. Only they can opt in again, by sending START. You can still send them a utility template, like an order update.");
  const confirmedAt = input.confirmOptIn === true && !contact.optIn ? new Date() : null;
  if (confirmedAt) await prisma.contact.updateMany({ where: { id: contact.id, tenantId }, data: { optIn: true, optInSource: "agent_confirmed", optInAt: confirmedAt } });
  const revertOptIn = async () => {
    if (!confirmedAt) return;
    try {
      await prisma.contact.updateMany({ where: { id: contact.id, tenantId, optInSource: "agent_confirmed", optInAt: confirmedAt }, data: { optIn: false, optInSource: contact.optInSource, optInAt: contact.optInAt } });
    } catch {
      console.error("[inbox] could not undo the opt-in after a refused new chat");
    }
  };

  const conversation =
    existing ??
    (await prisma.conversation.upsert({
      where: { phoneNumberId_contactId: { phoneNumberId, contactId: contact.id } },
      create: { tenantId, phoneNumberId, contactId: contact.id, assignedToId: userId, assignedAt: new Date() },
      update: {},
      select: { id: true, assignedToId: true },
    }));
  try {
    // A member starting a chat from the inbox; Eddy's start_chat passes origin "eddy".
    const message = await sendConversationTemplate(actor, conversation.id, { templateId, variables: input.variables }, { origin: opts.origin ?? "human" });
    if (confirmedAt) await audit({ tenantId, userId, action: "contact.opt_in_confirmed", target: contact.id, meta: { via: "new_chat" } });
    if (!conversation.assignedToId) await prisma.conversation.updateMany({ where: { id: conversation.id, tenantId, assignedToId: null }, data: { assignedToId: userId, assignedAt: new Date() } });
    if (createdContact) void emitAutomationEvent({ type: "contact_created", tenantId, contactId: contact.id });
    return { conversation: { id: conversation.id, contactId: contact.id }, message };
  } catch (e) {
    await revertOptIn();
    await undo(!existing, conversation.id);
    throw e;
  }
}
