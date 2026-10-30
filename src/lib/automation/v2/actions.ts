import { Prisma } from "@/generated/prisma/client";
import { handleInboundForAiAgent, STOP_TAG } from "@/lib/ai-agent";
import { startChatbot } from "@/lib/chatbots";
import { siteUrl } from "@/lib/config";
import { prisma } from "@/lib/db";
import { queueEmail } from "@/lib/email";
import { sendMedia, sendTemplateMessage, sendText } from "@/lib/inbox/service";
import { buildBodyComponents, bodyText, checkVariables, cleanVariable, fillTemplate, inlineSendable } from "@/lib/inbox/template-vars";
import { isWithinServiceWindow } from "@/lib/inbox/window";
import { emitStatusChanged } from "@/lib/integrations/emitters";
import { processRun } from "@/lib/leads/runner";
import { assignConversation } from "@/lib/routing";
import { describeError } from "@/lib/safe-error";
import { HttpError } from "@/lib/tenancy";
import { prepareMaterial } from "./materials";
import type { Action, TagScope } from "./model";
import { renderText } from "./variables";

export type EnvContact = { id: string; name: string | null; phone: string | null; tags: string[]; attributes: Record<string, unknown>; optIn: boolean };
export type EnvConversation = { id: string; phoneNumberId: string; assignedToId: string | null; tags: string[]; teamId: string | null; lastInboundAt: Date | null; status: string };

export type ActionEnv = {
  tenantId: string;
  rule: { id: string; name: string; phoneNumberId: string | null };
  contact: EnvContact;
  conversation: EnvConversation | null;
  /** Set when the rule started from a customer message. */
  inbound: { text: string; messageType: string; phoneNumberId: string; receivedAt: Date } | null;
  now: Date;
  /** A scheduled run's bulk hold (docs/SPEND-CONTROLS-SPEC.md 4.9); template sends take their estimate from it. */
  reservationId?: string;
};

export type ActionResult = { status: "ok" | "skipped" | "failed"; note?: string; replied?: boolean };

const ok = (replied = false): ActionResult => ({ status: "ok", ...(replied ? { replied: true } : {}) });
const skipped = (note: string): ActionResult => ({ status: "skipped", note });
const failed = (note: string): ActionResult => ({ status: "failed", note });

export const ACTION_LABEL: Record<Action["type"], string> = {
  send_text: "Send text",
  send_template: "Send template",
  send_material: "Send reply material",
  assign_user: "Assign to person",
  assign_team: "Assign to team",
  assign_round_robin: "Assign to next agent",
  start_chatbot: "Start chatbot",
  start_ai_agent: "Start AI agent",
  update_attribute: "Update detail",
  add_tag: "Add tag",
  remove_tag: "Remove tag",
  set_status: "Set status",
  notify: "Notify",
  start_lead_sequence: "Start sequence",
};

const sameTag = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function values(env: ActionEnv) {
  return { name: env.contact.name, phone: env.contact.phone ?? "", attributes: env.contact.attributes };
}

async function pickPhoneId(env: ActionEnv): Promise<string | null> {
  if (env.rule.phoneNumberId) return env.rule.phoneNumberId;
  const { tenantId } = env;
  const existing = await prisma.conversation.findFirst({ where: { tenantId, contactId: env.contact.id }, orderBy: { lastMessageAt: "desc" }, select: { phoneNumberId: true } });
  if (existing) return existing.phoneNumberId;
  const phone = await prisma.phoneNumber.findFirst({ where: { tenantId, status: "connected" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  return phone?.id ?? null;
}

/** The chat this run works on, created when the rule started without one (a schedule or a new contact). Null when no number is connected. */
async function ensureConversation(env: ActionEnv): Promise<EnvConversation | null> {
  if (env.conversation) return env.conversation;
  const phoneNumberId = await pickPhoneId(env);
  if (!phoneNumberId) return null;
  const row = await prisma.conversation.upsert({
    where: { phoneNumberId_contactId: { phoneNumberId, contactId: env.contact.id } },
    create: { tenantId: env.tenantId, phoneNumberId, contactId: env.contact.id },
    update: {},
    select: { id: true, phoneNumberId: true, assignedToId: true, tags: true, teamId: true, lastInboundAt: true, status: true },
  });
  env.conversation = row;
  return row;
}

const needChat = "there is no chat with this contact yet";
const windowClosed = "the 24-hour reply window is closed";

function openChatForFreeform(env: ActionEnv): ActionResult | null {
  if (!env.conversation) return skipped(`${needChat}, and free-form messages need a recent customer message`);
  if (!isWithinServiceWindow(env.conversation.lastInboundAt, env.now)) return skipped(windowClosed);
  return null;
}

async function sendTextAction(env: ActionEnv, text: string): Promise<ActionResult> {
  const blocked = openChatForFreeform(env);
  if (blocked) return blocked;
  const body = renderText(text, values(env)).trim();
  if (!body) return skipped("the message was empty after filling in the contact's details");
  await sendText({ tenantId: env.tenantId, conversationId: env.conversation!.id, body, origin: "automation" });
  return ok(true);
}

async function sendTemplateAction(env: ActionEnv, templateId: string, variables: string[]): Promise<ActionResult> {
  const template = await prisma.template.findFirst({ where: { id: templateId, tenantId: env.tenantId } });
  if (!template) return failed("the template was deleted");
  if (template.status !== "approved") return skipped("the template is not approved");
  if (String(template.category).toLowerCase() === "marketing" && !env.contact.optIn) return skipped("the contact has not agreed to marketing messages");
  const fit = inlineSendable(template.components);
  if (!fit.ok) return failed("the template needs a media header or button value, which rules cannot fill in");
  const filled = variables.map((v) => cleanVariable(renderText(v, values(env))));
  const checked = checkVariables(filled.slice(0, fit.variables), fit.variables);
  if (!checked.ok) return failed(checked.error);
  const phoneNumberId = env.conversation?.phoneNumberId ?? (await pickPhoneId(env));
  if (!phoneNumberId) return skipped("no WhatsApp number is connected");
  const message = await sendTemplateMessage({
    tenantId: env.tenantId,
    phoneNumberId,
    contactId: env.contact.id,
    templateName: template.name,
    language: template.language,
    components: buildBodyComponents(checked.values),
    ...(env.conversation ? { conversationId: env.conversation.id } : {}),
    origin: "automation",
    ...(env.reservationId ? { reservationId: env.reservationId } : {}),
  });
  const rendered = fillTemplate(bodyText(template.components), checked.values).slice(0, 4096);
  if (rendered) await prisma.message.updateMany({ where: { id: message.id, tenantId: env.tenantId }, data: { body: rendered } });
  return ok(true);
}

async function sendMaterialAction(env: ActionEnv, materialId: string): Promise<ActionResult> {
  const material = await prisma.replyMaterial.findFirst({ where: { id: materialId, tenantId: env.tenantId } });
  if (!material) return failed("the reply material was deleted");
  const blocked = openChatForFreeform(env);
  if (blocked) return blocked;
  const prepared = prepareMaterial(env.tenantId, material, (t) => renderText(t, values(env)));
  const conversationId = env.conversation!.id;
  if (prepared.kind === "text") {
    if (!prepared.text.trim()) return skipped("the material was empty after filling in the contact's details");
    await sendText({ tenantId: env.tenantId, conversationId, body: prepared.text, origin: "automation" });
  } else {
    await sendMedia({ tenantId: env.tenantId, conversationId, mediaType: prepared.mediaType, media: prepared.media, caption: prepared.caption ?? undefined, filename: prepared.filename, mime: prepared.mime, origin: "automation" });
  }
  return ok(true);
}

async function memberOrNull(tenantId: string, userId: string) {
  const member = await prisma.membership.findFirst({ where: { tenantId, userId }, select: { user: { select: { disabledAt: true } } } });
  return member && !member.user.disabledAt ? member : null;
}

async function assignUserAction(env: ActionEnv, userId: string): Promise<ActionResult> {
  const conversation = await ensureConversation(env);
  if (!conversation) return skipped("no WhatsApp number is connected");
  if (!(await memberOrNull(env.tenantId, userId))) return failed("that person is no longer on the team");
  await prisma.conversation.updateMany({ where: { id: conversation.id, tenantId: env.tenantId }, data: { assignedToId: userId, assignedAt: env.now } });
  conversation.assignedToId = userId;
  return ok();
}

async function pickTeamAgent(tenantId: string, teamId: string): Promise<string | null> {
  const rows = await prisma.teamMember.findMany({ where: { tenantId, teamId }, select: { userId: true } });
  const ids = rows.map((r) => r.userId);
  if (ids.length === 0) return null;
  const [members, availability] = await Promise.all([
    prisma.membership.findMany({ where: { tenantId, userId: { in: ids } }, select: { userId: true, user: { select: { disabledAt: true } } } }),
    prisma.agentAvailability.findMany({ where: { tenantId, userId: { in: ids } } }),
  ]);
  const avail = new Map(availability.map((a) => [a.userId, a]));
  const eligible = members.filter((m) => !m.user.disabledAt && avail.get(m.userId)?.available !== false);
  eligible.sort((a, b) => (avail.get(a.userId)?.lastAssignedAt?.getTime() ?? 0) - (avail.get(b.userId)?.lastAssignedAt?.getTime() ?? 0));
  return eligible[0]?.userId ?? null;
}

async function assignTeamAction(env: ActionEnv, teamId: string, pickAgent: boolean): Promise<ActionResult> {
  const team = await prisma.team.findFirst({ where: { id: teamId, tenantId: env.tenantId }, select: { id: true } });
  if (!team) return failed("the team was deleted");
  const conversation = await ensureConversation(env);
  if (!conversation) return skipped("no WhatsApp number is connected");
  await prisma.conversation.updateMany({ where: { id: conversation.id, tenantId: env.tenantId }, data: { teamId } });
  conversation.teamId = teamId;
  if (!pickAgent || conversation.assignedToId) return ok();
  const userId = await pickTeamAgent(env.tenantId, teamId);
  if (!userId) return ok();
  const claimed = await prisma.conversation.updateMany({ where: { id: conversation.id, tenantId: env.tenantId, assignedToId: null }, data: { assignedToId: userId, assignedAt: env.now } });
  if (claimed.count > 0) {
    conversation.assignedToId = userId;
    await prisma.agentAvailability.upsert({ where: { tenantId_userId: { tenantId: env.tenantId, userId } }, create: { tenantId: env.tenantId, userId, lastAssignedAt: env.now }, update: { lastAssignedAt: env.now } });
  }
  return ok();
}

async function roundRobinAction(env: ActionEnv): Promise<ActionResult> {
  const conversation = await ensureConversation(env);
  if (!conversation) return skipped("no WhatsApp number is connected");
  if (conversation.assignedToId) return skipped("the chat already has an agent");
  const result = await assignConversation(env.tenantId, conversation.id, { force: true, at: env.now });
  if (!result.assignedToId) return skipped("no agent is available right now");
  conversation.assignedToId = result.assignedToId;
  return ok();
}

async function startChatbotAction(env: ActionEnv, chatbotId: string): Promise<ActionResult> {
  const conversation = await ensureConversation(env);
  if (!conversation) return skipped("no WhatsApp number is connected");
  await startChatbot({ tenantId: env.tenantId }, chatbotId, conversation.id);
  return ok(true);
}

async function startAiAction(env: ActionEnv): Promise<ActionResult> {
  if (!env.inbound || !env.conversation) return skipped("the AI agent starts from a customer message");
  const conversation = env.conversation;
  if (conversation.tags.includes(STOP_TAG)) {
    const tags = conversation.tags.filter((t) => t !== STOP_TAG);
    await prisma.conversation.updateMany({ where: { id: conversation.id, tenantId: env.tenantId }, data: { tags } });
    conversation.tags = tags;
  }
  const handled = await handleInboundForAiAgent({
    tenantId: env.tenantId,
    phoneNumberId: env.inbound.phoneNumberId,
    conversationId: conversation.id,
    contactId: env.contact.id,
    text: env.inbound.text,
    receivedAt: env.inbound.receivedAt,
  });
  return handled ? ok(true) : skipped("the AI agent did not answer; check that it is switched on and its activation setting");
}

function matchKey(attributes: Record<string, unknown>, name: string): string {
  return Object.keys(attributes).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
}

async function updateAttributeAction(env: ActionEnv, name: string, value: string, remove: boolean): Promise<ActionResult> {
  const attributes = { ...env.contact.attributes };
  const key = matchKey(attributes, name);
  if (remove) delete attributes[key];
  else attributes[key] = renderText(value, values(env)).slice(0, 200);
  const res = await prisma.contact.updateMany({ where: { id: env.contact.id, tenantId: env.tenantId }, data: { attributes: attributes as Prisma.InputJsonObject } });
  if (res.count === 0) return failed("the contact was deleted");
  env.contact.attributes = attributes;
  return ok();
}

const touchesContact = (scope: TagScope) => scope === "contact" || scope === "both";
const touchesChat = (scope: TagScope) => scope === "chat" || scope === "both";

async function tagAction(env: ActionEnv, tag: string, scope: TagScope, add: boolean): Promise<ActionResult> {
  const apply = (list: string[]) => (add ? (list.some((t) => sameTag(t, tag)) ? list : [...list, tag]) : list.filter((t) => !sameTag(t, tag)));
  if (touchesContact(scope)) {
    const tags = apply(env.contact.tags);
    if (tags.length !== env.contact.tags.length || tags.some((t, i) => t !== env.contact.tags[i])) {
      await prisma.contact.updateMany({ where: { id: env.contact.id, tenantId: env.tenantId }, data: { tags } });
      env.contact.tags = tags;
    }
  }
  if (touchesChat(scope) && env.conversation) {
    const tags = apply(env.conversation.tags);
    if (tags.length !== env.conversation.tags.length || tags.some((t, i) => t !== env.conversation!.tags[i])) {
      await prisma.conversation.updateMany({ where: { id: env.conversation.id, tenantId: env.tenantId }, data: { tags } });
      env.conversation.tags = tags;
    }
  }
  return ok();
}

async function statusAction(env: ActionEnv, status: string): Promise<ActionResult> {
  if (!env.conversation) return skipped(needChat);
  await prisma.conversation.updateMany({ where: { id: env.conversation.id, tenantId: env.tenantId }, data: { status, statusChangedAt: env.now } });
  const previous = env.conversation.status;
  env.conversation.status = status;
  await emitStatusChanged(env.tenantId, { conversationId: env.conversation.id, contactId: env.contact?.id ?? null, from: previous ?? null, to: status, source: "system" }).catch(() => undefined);
  return ok();
}

async function recipientEmails(env: ActionEnv, target: "assigned" | "admins" | "user", userId: string | null): Promise<string[]> {
  const where =
    target === "admins"
      ? { tenantId: env.tenantId, role: { in: ["owner" as const, "admin" as const] } }
      : { tenantId: env.tenantId, userId: target === "user" ? (userId ?? "") : (env.conversation?.assignedToId ?? "") };
  const members = await prisma.membership.findMany({ where, select: { user: { select: { email: true, disabledAt: true } } } });
  return members.filter((m) => !m.user.disabledAt).map((m) => m.user.email);
}

async function notifyAction(env: ActionEnv, target: "assigned" | "admins" | "user", userId: string | null, message: string): Promise<ActionResult> {
  const text = renderText(message, values(env)).trim().slice(0, 300);
  const note = text ? `Rule "${env.rule.name}": ${text}` : `Rule "${env.rule.name}" asks for your attention on this chat.`;
  if (env.conversation) await prisma.note.create({ data: { tenantId: env.tenantId, conversationId: env.conversation.id, authorId: "automation", body: note } });
  const emails = await recipientEmails(env, target, userId);
  if (emails.length === 0 && !env.conversation) return skipped("there is nobody to notify");
  const link = env.conversation ? `${siteUrl()}/app/inbox?conversation=${env.conversation.id}` : `${siteUrl()}/app/automation`;
  for (const to of emails) {
    await queueEmail({ to, subject: `Needs attention: ${env.rule.name}`, text: `${note}\n\nOpen it here: ${link}\n` });
  }
  return ok();
}

async function leadSequenceAction(env: ActionEnv, sequenceId: string): Promise<ActionResult> {
  const sequence = await prisma.leadSequence.findFirst({ where: { id: sequenceId, tenantId: env.tenantId, enabled: true }, select: { id: true } });
  if (!sequence) return failed("the follow-up sequence was deleted or switched off");
  let lead = await prisma.lead.findFirst({ where: { tenantId: env.tenantId, contactId: env.contact.id }, orderBy: { createdAt: "desc" }, select: { id: true } });
  if (!lead) {
    const fields = { full_name: env.contact.name ?? "", phone_number: env.contact.phone ?? "" };
    lead = await prisma.lead.create({ data: { tenantId: env.tenantId, leadgenId: `rule:${env.rule.id}:${env.contact.id}`, contactId: env.contact.id, fields }, select: { id: true } });
  }
  try {
    const run = await prisma.leadSequenceRun.create({ data: { tenantId: env.tenantId, sequenceId, leadId: lead.id, stepIndex: 0, nextRunAt: env.now, status: "active" } });
    await processRun(run.id, env.now).catch(() => console.error("[automation] first sequence step failed"));
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return skipped("the contact is already in this sequence");
    throw error;
  }
  return ok(true);
}

async function dispatch(action: Action, env: ActionEnv): Promise<ActionResult> {
  switch (action.type) {
    case "send_text":
      return sendTextAction(env, action.text);
    case "send_template":
      return sendTemplateAction(env, action.templateId, action.variables);
    case "send_material":
      return sendMaterialAction(env, action.materialId);
    case "assign_user":
      return assignUserAction(env, action.userId);
    case "assign_team":
      return assignTeamAction(env, action.teamId, action.pickAgent);
    case "assign_round_robin":
      return roundRobinAction(env);
    case "start_chatbot":
      return startChatbotAction(env, action.chatbotId);
    case "start_ai_agent":
      return startAiAction(env);
    case "update_attribute":
      return updateAttributeAction(env, action.name, action.value, action.remove);
    case "add_tag":
      return tagAction(env, action.tag, action.scope, true);
    case "remove_tag":
      return tagAction(env, action.tag, action.scope, false);
    case "set_status":
      return statusAction(env, action.status);
    case "notify":
      return notifyAction(env, action.target, action.userId, action.message);
    case "start_lead_sequence":
      return leadSequenceAction(env, action.sequenceId);
  }
}

/** Runs one action. Expected refusals come back as skipped or failed with a plain reason; nothing here throws. */
export async function runAction(action: Action, env: ActionEnv): Promise<ActionResult> {
  try {
    return await dispatch(action, env);
  } catch (error) {
    if (error instanceof HttpError && error.status < 500) return failed(error.message.slice(0, 160));
    console.error("[automation] an action failed:", describeError(error));
    return failed("something went wrong");
  }
}
