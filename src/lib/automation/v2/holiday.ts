import { prisma } from "@/lib/db";
import { sendText } from "@/lib/inbox/service";
import { describeError } from "@/lib/safe-error";
import { HttpError } from "@/lib/tenancy";
import { tenantMayRunBackground } from "@/lib/tenant-state";
import { remainingTriggers } from "./metering";
import { busyReason } from "./run";
import { getAutomationSettings, HOLIDAY_REPEAT_MS, isHolidayActive } from "./settings";
import { renderText } from "./variables";

/** Executions logged for holiday mode carry this in place of a rule id. */
export const HOLIDAY_RULE_ID = "holiday";

export type HolidayOutcome = "inactive" | "sent" | "already_sent" | "failed";

/**
 * Holiday mode answers incoming messages with the holiday message, at most once per chat in HOLIDAY_REPEAT_MS (this repeat
 * window replaces the loop guard). While it answers, the caller treats the message as answered, so the usual rules do not reply on top.
 * It stays out of chats a person or a chatbot is handling, and, like every rule, it stops when the monthly allowance is used up.
 * In those cases it reports "inactive" so the normal rules decide what happens.
 */
export async function answerWithHolidayMode(input: { tenantId: string; conversationId: string; contactId: string; now: Date }): Promise<HolidayOutcome> {
  const { tenantId, conversationId, contactId, now } = input;
  const { holiday } = await getAutomationSettings(tenantId);
  if (!isHolidayActive(holiday, now) || !(await tenantMayRunBackground(tenantId))) return "inactive";

  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, select: { id: true, assignedToId: true } });
  if (await busyReason(tenantId, conversation, now)) return "inactive";
  const left = await remainingTriggers(tenantId, now);
  if (left !== null && left <= 0) return "inactive";

  const earlier = await prisma.ruleExecution.findFirst({
    where: { tenantId, ruleId: HOLIDAY_RULE_ID, conversationId, outcome: "ok", createdAt: { gte: new Date(now.getTime() - HOLIDAY_REPEAT_MS) } },
    select: { id: true },
  });
  if (earlier) return "already_sent";

  const contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId }, select: { name: true, phone: true, attributes: true } });
  const attributes = contact?.attributes && typeof contact.attributes === "object" && !Array.isArray(contact.attributes) ? (contact.attributes as Record<string, unknown>) : {};
  const body = renderText(holiday.message, { name: contact?.name ?? null, phone: contact?.phone ?? "", attributes }).trim();
  try {
    await sendText({ tenantId, conversationId, body, origin: "automation" });
    await prisma.ruleExecution.create({ data: { tenantId, ruleId: HOLIDAY_RULE_ID, conversationId, contactId, outcome: "ok", detail: "Holiday mode reply sent" } });
    return "sent";
  } catch (error) {
    const reason = error instanceof HttpError ? error.message.slice(0, 160) : "something went wrong";
    if (!(error instanceof HttpError)) console.error("[automation] holiday reply failed:", describeError(error));
    await prisma.ruleExecution.create({ data: { tenantId, ruleId: HOLIDAY_RULE_ID, conversationId, contactId, outcome: "failed", detail: `Holiday mode reply: ${reason}` } });
    return "failed";
  }
}
