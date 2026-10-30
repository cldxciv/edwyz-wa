import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";
import { parseSchedule } from "./match";
import { createRuleV2, isV2Body, updateRuleV2 } from "./v2/service";

export const RULE_TYPES = ["welcome", "away", "keyword"] as const;
export type RuleType = (typeof RULE_TYPES)[number];
export const MAX_REPLY_LENGTH = 1024;
export const MAX_KEYWORDS = 30;
export const MAX_RULES = 50;

export type RuleInput = {
  type: RuleType;
  name: string;
  enabled: boolean;
  phoneNumberId: string | null;
  keywords: string[];
  matchMode: "contains" | "exact";
  replyText: string;
  schedule: ReturnType<typeof parseSchedule>;
  cooldownMinutes: number;
};

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Validates a full rule (create) or, with partial=true, only the supplied fields (update). */
export function validateRule(raw: unknown, partial = false): Partial<RuleInput> {
  if (!isRecord(raw)) throw new HttpError(400, "Invalid rule.");
  const out: Partial<RuleInput> = {};
  const has = (k: string) => raw[k] !== undefined;
  const need = (k: string) => {
    if (!partial && !has(k)) throw new HttpError(400, `${k} is required.`);
    return has(k);
  };

  if (need("type")) {
    if (!(RULE_TYPES as readonly unknown[]).includes(raw.type)) throw new HttpError(400, "Unknown rule type.");
    out.type = raw.type as RuleType;
  }
  if (need("name")) {
    if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 80) throw new HttpError(400, "Name is required (up to 80 characters).");
    out.name = raw.name.trim();
  }
  if (need("replyText")) {
    if (typeof raw.replyText !== "string" || !raw.replyText.trim()) throw new HttpError(400, "Reply text is required.");
    if (raw.replyText.length > MAX_REPLY_LENGTH) throw new HttpError(400, `Reply text can be at most ${MAX_REPLY_LENGTH} characters.`);
    out.replyText = raw.replyText.trim();
  }
  if (has("enabled")) {
    if (typeof raw.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
    out.enabled = raw.enabled;
  }
  if (has("phoneNumberId")) {
    if (raw.phoneNumberId !== null && (typeof raw.phoneNumberId !== "string" || !raw.phoneNumberId)) throw new HttpError(400, "phoneNumberId is not valid.");
    out.phoneNumberId = raw.phoneNumberId as string | null;
  }
  if (has("matchMode")) {
    if (raw.matchMode !== "contains" && raw.matchMode !== "exact") throw new HttpError(400, "matchMode must be contains or exact.");
    out.matchMode = raw.matchMode;
  }
  if (has("cooldownMinutes")) {
    const c = raw.cooldownMinutes;
    if (typeof c !== "number" || !Number.isInteger(c) || c < 1 || c > 60 * 24 * 30) throw new HttpError(400, "Cooldown must be between 1 minute and 30 days.");
    out.cooldownMinutes = c;
  }
  if (has("keywords")) {
    const k = raw.keywords;
    if (!Array.isArray(k) || k.length > MAX_KEYWORDS || k.some((x) => typeof x !== "string" || !x.trim() || x.length > 60)) {
      throw new HttpError(400, `Keywords must be up to ${MAX_KEYWORDS} short phrases.`);
    }
    out.keywords = [...new Set((k as string[]).map((x) => x.trim()))];
  }
  if (has("schedule")) {
    if (raw.schedule === null) out.schedule = null;
    else {
      const s = parseSchedule(raw.schedule);
      if (!s) throw new HttpError(400, "Schedule needs a valid timezone, at least one day (0-6), and start and end as HH:MM.");
      out.schedule = s;
    }
  }

  if (!partial) {
    if (out.type === "keyword" && !out.keywords?.length) throw new HttpError(400, "A keyword rule needs at least one keyword.");
    if (out.type === "away" && !out.schedule) throw new HttpError(400, "An away rule needs its open hours.");
  }
  return out;
}

export async function listRules(tenantId: string) {
  return prisma.automationRule.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } });
}

async function assertPhoneOwned(tenantId: string, phoneNumberId: string | null | undefined) {
  if (!phoneNumberId) return;
  const phone = await prisma.phoneNumber.findFirst({ where: { id: phoneNumberId, tenantId }, select: { id: true } });
  if (!phone) throw new HttpError(404, "Phone number not found.");
}

export async function createRule(tenantId: string, raw: unknown) {
  if (isV2Body(raw)) return createRuleV2(tenantId, raw);
  const input = validateRule(raw);
  await assertPhoneOwned(tenantId, input.phoneNumberId);
  if ((await prisma.automationRule.count({ where: { tenantId } })) >= MAX_RULES) throw new HttpError(409, `You can have up to ${MAX_RULES} rules.`);
  return prisma.automationRule.create({
    data: {
      tenantId,
      type: input.type!,
      name: input.name!,
      replyText: input.replyText!,
      enabled: input.enabled ?? true,
      phoneNumberId: input.phoneNumberId ?? null,
      keywords: input.keywords ?? [],
      matchMode: input.matchMode ?? "contains",
      cooldownMinutes: input.cooldownMinutes ?? 720,
      schedule: (input.schedule ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

export async function updateRule(tenantId: string, id: string, raw: unknown) {
  if (isV2Body(raw)) return updateRuleV2(tenantId, id, raw);
  const patch = validateRule(raw, true);
  await assertPhoneOwned(tenantId, patch.phoneNumberId);
  const { schedule, ...rest } = patch;
  const data: Prisma.AutomationRuleUpdateManyMutationInput = { ...rest, ...(schedule !== undefined ? { schedule: schedule ?? Prisma.DbNull } : {}) };
  const { count } = await prisma.automationRule.updateMany({ where: { id, tenantId }, data });
  if (count === 0) throw new HttpError(404, "Rule not found.");
  return prisma.automationRule.findFirst({ where: { id, tenantId } });
}

export async function deleteRule(tenantId: string, id: string) {
  const { count } = await prisma.automationRule.deleteMany({ where: { id, tenantId } });
  if (count === 0) throw new HttpError(404, "Rule not found.");
}
