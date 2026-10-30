import { prisma } from "@/lib/db";
import { startChatbot } from "@/lib/chatbots";
import { sendTemplateMessage } from "@/lib/inbox/service";
import { describeError } from "@/lib/safe-error";
import { tenantMayRunBackground } from "@/lib/tenant-state";
import { templateVariables } from "@/lib/templates/validate";
import { assignLeadToConversation } from "./assignment";
import { matchesSequence, readSteps, type Step } from "./steps";

const LEASE_MS = 5 * 60_000;
export const BLOCKED_DEFER_MS = 15 * 60_000;
export const BLOCKED_GIVE_UP_MS = 7 * 86_400_000;
const BATCH = 25;
const ENDED_LEAD = ["won", "lost", "invalid"];

export type LeadRow = { id: string; tenantId: string; contactId: string | null; fields: unknown; status: string; assignedToId: string | null; leadFormId: string | null; campaignMetaId: string | null };
type ContactRow = { id: string; name: string | null; phone: string; optIn: boolean; optedOutAt: Date | null };

export async function startSequenceForLead(tenantId: string, lead: LeadRow, now = new Date()): Promise<string | null> {
  if (!lead.contactId || !(await tenantMayRunBackground(tenantId))) return null;
  const sequences = await prisma.leadSequence.findMany({ where: { tenantId, enabled: true }, orderBy: { createdAt: "asc" }, take: 100 });
  const chosen = sequences.find((s) => readSteps(s.steps).length > 0 && matchesSequence(s.appliesTo, lead));
  if (!chosen) return null;
  let runId: string;
  try {
    const run = await prisma.leadSequenceRun.create({ data: { tenantId, sequenceId: chosen.id, leadId: lead.id, stepIndex: 0, nextRunAt: now, status: "active" } });
    runId = run.id;
  } catch {
    return null;
  }
  await processRun(runId, now).catch((e) => console.error("[leads] first step failed:", describeError(e)));
  return runId;
}

export async function runDueSequences(now = new Date()): Promise<number> {
  const due = await prisma.leadSequenceRun.findMany({ where: { status: "active", nextRunAt: { lte: now } }, orderBy: { nextRunAt: "asc" }, take: BATCH, select: { id: true, tenantId: true } });
  let ran = 0;
  for (const r of due) {
    try {
      if (!(await tenantMayRunBackground(r.tenantId))) {
        await deferBlockedRun(r.id, r.tenantId, now, { nextRunAt: { lte: now } });
        continue;
      }
      if (await processRun(r.id, now)) ran++;
    } catch (e) {
      console.error("[leads] sequence step failed:", describeError(e));
    }
  }
  return ran;
}

/**
 * A run of a suspended, deleted or locked workspace is pushed back 15 minutes, not dropped. It is given up (stopped) only when
 * its current step has been due for more than 7 days, measured against the ideal schedule (creation plus the step delays), so a
 * step is never sent a week late after a long lock.
 */
async function deferBlockedRun(runId: string, tenantId: string, now: Date, extraWhere: { nextRunAt?: { lte: Date } }): Promise<void> {
  const run = await prisma.leadSequenceRun.findFirst({ where: { id: runId, tenantId, status: "active" }, select: { createdAt: true, stepIndex: true, sequence: { select: { steps: true } } } });
  if (run) {
    const delays = readSteps(run.sequence.steps).slice(1, run.stepIndex + 1).reduce((sum, st) => sum + st.delayMinutes * 60_000, 0);
    if (now.getTime() - (run.createdAt.getTime() + delays) > BLOCKED_GIVE_UP_MS) {
      await finish(runId, tenantId, "stopped");
      return;
    }
  }
  await prisma.leadSequenceRun.updateMany({ where: { id: runId, tenantId, status: "active", ...extraWhere }, data: { nextRunAt: new Date(now.getTime() + BLOCKED_DEFER_MS) } });
}

/** Claims the run by moving nextRunAt forward as a lease, executes the pending step, then advances. */
export async function processRun(runId: string, now = new Date()): Promise<boolean> {
  const claimed = await prisma.leadSequenceRun.updateMany({
    where: { id: runId, status: "active", nextRunAt: { lte: now } },
    data: { nextRunAt: new Date(now.getTime() + LEASE_MS) },
  });
  if (claimed.count === 0) return false;
  const run = await prisma.leadSequenceRun.findUnique({ where: { id: runId }, include: { sequence: true } });
  if (!run) return false;
  const { tenantId } = run;
  if (!(await tenantMayRunBackground(tenantId))) {
    await deferBlockedRun(runId, tenantId, now, {});
    return false;
  }
  const steps = readSteps(run.sequence.steps);
  const step = steps[run.stepIndex];
  const [lead, contact] = await loadLeadAndContact(tenantId, run.leadId);

  if (!step || !lead || !contact || !run.sequence.enabled || ENDED_LEAD.includes(lead.status) || contact.optedOutAt) {
    await finish(runId, tenantId, step ? "stopped" : "completed");
    return true;
  }
  if (run.stepIndex > 0 && step.stopOnReply && (await hasReplied(tenantId, contact.id, run.createdAt))) {
    await finish(runId, tenantId, "stopped");
    return true;
  }

  await executeStep(tenantId, lead, contact, step, now);
  const next = steps[run.stepIndex + 1];
  if (!next) {
    await finish(runId, tenantId, "completed");
  } else {
    await prisma.leadSequenceRun.updateMany({
      where: { id: runId, tenantId, status: "active" },
      data: { stepIndex: run.stepIndex + 1, nextRunAt: new Date(now.getTime() + next.delayMinutes * 60_000) },
    });
  }
  return true;
}

async function loadLeadAndContact(tenantId: string, leadId: string): Promise<[LeadRow | null, ContactRow | null]> {
  const lead = (await prisma.lead.findFirst({ where: { id: leadId, tenantId } })) as LeadRow | null;
  if (!lead?.contactId) return [lead, null];
  const contact = (await prisma.contact.findFirst({ where: { id: lead.contactId, tenantId }, select: { id: true, name: true, phone: true, optIn: true, optedOutAt: true } })) as ContactRow | null;
  return [lead, contact];
}

async function finish(runId: string, tenantId: string, status: "completed" | "stopped") {
  await prisma.leadSequenceRun.updateMany({ where: { id: runId, tenantId, status: "active" }, data: { status, nextRunAt: null } });
}

async function hasReplied(tenantId: string, contactId: string, since: Date): Promise<boolean> {
  const c = await prisma.conversation.findFirst({ where: { tenantId, contactId, lastInboundAt: { gt: since } }, select: { id: true } });
  return Boolean(c);
}

async function pickPhone(tenantId: string, contactId: string): Promise<string | null> {
  const existing = await prisma.conversation.findFirst({ where: { tenantId, contactId }, orderBy: { lastMessageAt: "desc" }, select: { phoneNumberId: true } });
  if (existing) return existing.phoneNumberId;
  const phone = await prisma.phoneNumber.findFirst({ where: { tenantId, status: "connected" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  return phone?.id ?? null;
}

async function executeStep(tenantId: string, lead: LeadRow, contact: ContactRow, step: Step, now: Date): Promise<boolean> {
  const phoneId = await pickPhone(tenantId, contact.id);
  if (!phoneId) return false;
  let conversationId: string | null = null;
  let sent = false;

  if (step.templateId) {
    conversationId = await sendStepTemplate(tenantId, lead, contact, step, phoneId);
    sent = conversationId !== null;
  }
  if (step.chatbotId) {
    conversationId ??= await ensureConversation(tenantId, phoneId, contact.id);
    try {
      await startChatbot({ tenantId }, step.chatbotId, conversationId);
      sent = true;
    } catch (e) {
      console.error("[leads] chatbot step skipped:", describeError(e));
    }
  }
  if (sent && conversationId) await afterOutbound(tenantId, lead, conversationId, now);
  return sent;
}

async function ensureConversation(tenantId: string, phoneNumberId: string, contactId: string): Promise<string> {
  const c = await prisma.conversation.upsert({
    where: { phoneNumberId_contactId: { phoneNumberId, contactId } },
    create: { tenantId, phoneNumberId, contactId },
    update: {},
  });
  return c.id;
}

async function sendStepTemplate(tenantId: string, lead: LeadRow, contact: ContactRow, step: Step, phoneNumberId: string): Promise<string | null> {
  const template = await prisma.template.findFirst({ where: { id: step.templateId, tenantId, status: "approved" } });
  if (!template) return null;
  const category = template.category.toLowerCase();
  if (category !== "marketing" && category !== "utility") return null;
  if (category === "marketing" && !contact.optIn) return null;
  const components = buildLeadComponents(template.components, lead.fields, contact, step.params);
  if (!components) return null;
  const message = (await sendTemplateMessage({
    tenantId,
    phoneNumberId,
    contactId: contact.id,
    templateName: template.name,
    language: template.language,
    components,
    origin: "lead_sequence",
  })) as { conversationId?: string };
  return message.conversationId ?? (await ensureConversation(tenantId, phoneNumberId, contact.id));
}

function bodyText(components: unknown): string {
  const body = (Array.isArray(components) ? components : []).find((c) => c && (c as { type?: string }).type === "BODY") as { text?: string } | undefined;
  return body?.text ?? "";
}

function paramValue(source: string, fields: Record<string, string>, contact: ContactRow): string | undefined {
  if (source === "name") return contact.name ?? fields.full_name ?? fields.first_name;
  if (source === "phone") return contact.phone;
  if (source === "email") return fields.email;
  return fields[source.slice("field:".length)];
}

/** Body variable {{n}} comes from params[n-1] (default: the lead's name for {{1}}). Null when a value is missing. */
export function buildLeadComponents(templateComponents: unknown, leadFields: unknown, contact: ContactRow, params: string[] = []) {
  const vars = templateVariables(bodyText(templateComponents));
  if (vars.length === 0) return [];
  const fields = (leadFields && typeof leadFields === "object" ? leadFields : {}) as Record<string, string>;
  const parameters: { type: "text"; text: string }[] = [];
  for (const n of vars) {
    const source = params[n - 1] ?? (n === 1 ? "name" : "");
    const value = source ? paramValue(source, fields, contact)?.trim() : undefined;
    if (!value) return null;
    parameters.push({ type: "text", text: value });
  }
  return [{ type: "body" as const, parameters }];
}

async function afterOutbound(tenantId: string, lead: LeadRow, conversationId: string, now: Date) {
  await prisma.lead.updateMany({ where: { id: lead.id, tenantId, firstResponseAt: null }, data: { firstResponseAt: now } });
  await prisma.lead.updateMany({ where: { id: lead.id, tenantId, status: "new" }, data: { status: "contacted" } });
  await assignLeadToConversation(tenantId, lead.id, conversationId);
}

/** Called by the inbound pipeline for every inbound message from a contact: stops runs whose pending step has stopOnReply. */
export async function onInboundFromContact(tenantId: string, contactId: string): Promise<number> {
  const runs = await prisma.leadSequenceRun.findMany({
    where: { tenantId, status: "active", lead: { contactId, tenantId } },
    include: { sequence: { select: { steps: true } } },
    take: 50,
  });
  let stopped = 0;
  for (const run of runs) {
    const step = readSteps(run.sequence.steps)[run.stepIndex];
    if (step && !step.stopOnReply) continue;
    const { count } = await prisma.leadSequenceRun.updateMany({ where: { id: run.id, tenantId, status: "active" }, data: { status: "stopped", nextRunAt: null } });
    stopped += count;
  }
  return stopped;
}

/** Called when a contact opts out (STOP): every active run for that contact ends. */
export async function onContactOptedOut(tenantId: string, contactId: string): Promise<number> {
  const { count } = await prisma.leadSequenceRun.updateMany({ where: { tenantId, status: "active", lead: { contactId, tenantId } }, data: { status: "stopped", nextRunAt: null } });
  return count;
}
