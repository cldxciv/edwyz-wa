import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { displayName } from "@/lib/contacts/identity";
import { templateFillNeeds } from "@/lib/chatbots/template-build";
import { HttpError } from "@/lib/tenancy";
import { clockToMinutes, isValidTimezone, localDateTime, parseSchedule } from "../match";
import { byPriority, emptyFilters, LIMITS, parseDefinition, type Action, type Filters, type RuleDefinition } from "./model";
import { ruleTemplateProblem } from "./template-check";

export const V2_KEYS = ["trigger", "filters", "actions", "priority", "stopAfterMatch"] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const json = (value: unknown) => value as Prisma.InputJsonValue;

export type V2Fields = {
  name?: string;
  enabled?: boolean;
  phoneNumberId?: string | null;
  cooldownMinutes?: number;
  stopAfterMatch?: boolean;
  definition?: RuleDefinition;
};

/** True when a request body carries rules v2 fields. */
export const isV2Body = (raw: unknown) => isRecord(raw) && (raw.version === 2 || V2_KEYS.some((k) => raw[k] !== undefined));

/** Validates a rule v2 body (create) or the supplied fields (update). Trigger, conditions and actions are validated together. */
export function validateRuleV2(raw: unknown, partial: boolean, current?: { trigger: unknown; filters: unknown; actions: unknown }): V2Fields {
  if (!isRecord(raw)) throw new HttpError(400, "Invalid rule.");
  const out: V2Fields = {};
  if (raw.name !== undefined || !partial) {
    if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.trim().length > LIMITS.name) throw new HttpError(400, `Give the rule a name of up to ${LIMITS.name} characters.`);
    out.name = raw.name.trim();
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
    out.enabled = raw.enabled;
  }
  if (raw.phoneNumberId !== undefined) {
    if (raw.phoneNumberId !== null && (typeof raw.phoneNumberId !== "string" || !raw.phoneNumberId)) throw new HttpError(400, "phoneNumberId is not valid.");
    out.phoneNumberId = raw.phoneNumberId as string | null;
  }
  if (raw.cooldownMinutes !== undefined) {
    const c = raw.cooldownMinutes;
    if (typeof c !== "number" || !Number.isInteger(c) || c < 0 || c > LIMITS.cooldownMinutes) throw new HttpError(400, "Waiting time between runs must be between 0 minutes and 30 days.");
    out.cooldownMinutes = c;
  }
  if (raw.stopAfterMatch !== undefined) {
    if (typeof raw.stopAfterMatch !== "boolean") throw new HttpError(400, "stopAfterMatch must be true or false.");
    out.stopAfterMatch = raw.stopAfterMatch;
  }
  const touchesDefinition = raw.trigger !== undefined || raw.filters !== undefined || raw.actions !== undefined;
  if (touchesDefinition || !partial) {
    const parsed = parseDefinition({
      trigger: raw.trigger !== undefined ? raw.trigger : current?.trigger,
      filters: raw.filters !== undefined ? raw.filters : (current?.filters ?? null),
      actions: raw.actions !== undefined ? raw.actions : current?.actions,
    });
    if (!parsed.ok) throw new HttpError(400, parsed.error);
    out.definition = parsed.value;
  }
  return out;
}

/** Date in a "once" schedule must not be in the past in its own timezone. */
function assertScheduleNotPast(def: RuleDefinition, now = new Date()) {
  const t = def.trigger;
  if (t.type !== "scheduled" || t.repeat !== "once" || !t.date || !isValidTimezone(t.timezone)) return;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: t.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  if (t.date < today) throw new HttpError(400, "Pick a date that is today or later.");
  const at = clockToMinutes(t.time);
  if (t.date === today && at !== null && at <= localDateTime(now, t.timezone).minutes) throw new HttpError(400, "That time has already passed today. Pick a later time or a later date.");
}

async function assertPhoneOwned(tenantId: string, phoneNumberId: string | null | undefined) {
  if (!phoneNumberId) return;
  const phone = await prisma.phoneNumber.findFirst({ where: { id: phoneNumberId, tenantId }, select: { id: true } });
  if (!phone) throw new HttpError(404, "Phone number not found.");
}

/** Everything a rule points at must belong to this workspace. Missing items are reported by name, not by id. */
export async function assertReferencesOwned(tenantId: string, def: RuleDefinition): Promise<void> {
  const want = { template: new Set<string>(), chatbot: new Set<string>(), material: new Set<string>(), user: new Set<string>(), team: new Set<string>(), sequence: new Set<string>(), segment: new Set<string>() };
  const collect = (a: Action) => {
    if (a.type === "send_template") want.template.add(a.templateId);
    if (a.type === "start_chatbot") want.chatbot.add(a.chatbotId);
    if (a.type === "send_material") want.material.add(a.materialId);
    if (a.type === "assign_user") want.user.add(a.userId);
    if (a.type === "notify" && a.userId) want.user.add(a.userId);
    if (a.type === "assign_team") want.team.add(a.teamId);
    if (a.type === "start_lead_sequence") want.sequence.add(a.sequenceId);
  };
  def.actions.forEach(collect);
  const walk = (items: Filters["root"]["items"]) => {
    for (const item of items) {
      if (item.type === "group") walk(item.items);
      else if (item.type === "segment") want.segment.add(item.segmentId);
      else if (item.type === "assignment" && item.userId) want.user.add(item.userId);
    }
  };
  walk(def.filters.root.items);

  const ids = (set: Set<string>) => [...set];
  const count = async (set: Set<string>, find: (ids: string[]) => Promise<number>) => (set.size === 0 ? set.size : find(ids(set)));
  const [templates, chatbots, materials, users, teams, sequences, segments] = await Promise.all([
    count(want.template, (id) => prisma.template.count({ where: { tenantId, id: { in: id } } })),
    count(want.chatbot, (id) => prisma.chatbot.count({ where: { tenantId, id: { in: id } } })),
    count(want.material, (id) => prisma.replyMaterial.count({ where: { tenantId, id: { in: id } } })),
    count(want.user, (id) => prisma.membership.count({ where: { tenantId, userId: { in: id } } })),
    count(want.team, (id) => prisma.team.count({ where: { tenantId, id: { in: id } } })),
    count(want.sequence, (id) => prisma.leadSequence.count({ where: { tenantId, id: { in: id } } })),
    count(want.segment, (id) => prisma.segment.count({ where: { tenantId, id: { in: id } } })),
  ]);
  const problems: [number, number, string][] = [
    [templates, want.template.size, "template"],
    [chatbots, want.chatbot.size, "chatbot"],
    [materials, want.material.size, "reply material"],
    [users, want.user.size, "team member"],
    [teams, want.team.size, "team"],
    [sequences, want.sequence.size, "follow-up sequence"],
    [segments, want.segment.size, "segment"],
  ];
  const missing = problems.find(([have, need]) => have !== need);
  if (missing) throw new HttpError(400, `A ${missing[2]} used by this rule no longer exists. Pick another one.`);
}

const HEADER_MEDIA_WORD = { image: "picture", video: "video", document: "file" } as const;

/** What a Send template step must fill in for this template and leaves empty, as the end of a sentence, or null. */
export function missingTemplateValue(components: unknown, action: Extract<Action, { type: "send_template" }>): string | null {
  const needs = templateFillNeeds(components);
  if (needs.headerMedia && !action.headerMediaUrl) return `has a ${HEADER_MEDIA_WORD[needs.headerMedia]} at the top. Add a https link to it in this step`;
  if (needs.headerText && !action.headerVariable) return "has a value to fill in its heading. Add it in this step";
  if (needs.buttonValue && !action.buttonVariable) return "has a value to fill in its button link. Add it in this step";
  return null;
}

/**
 * A rule can only send templates whose values it can fill in (a heading picture or value and a link button value come from the
 * step; login codes, coupon codes, named values, carousels and special buttons cannot, see ruleTemplateProblem), and only from a
 * number of the template's own WhatsApp Business account. Saving a rule that could never send is refused with the reason, the same
 * one the template list shows, instead of failing on every run.
 */
async function assertTemplatesUsable(tenantId: string, def: RuleDefinition, phoneNumberId: string | null | undefined): Promise<void> {
  const steps = def.actions.filter((a): a is Extract<Action, { type: "send_template" }> => a.type === "send_template");
  const ids = [...new Set(steps.map((a) => a.templateId))];
  if (ids.length === 0) return;
  const templates = ((await prisma.template.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true, components: true, wabaRefId: true } })) ?? []) as {
    id: string;
    name: string;
    components: unknown;
    wabaRefId: string | null;
  }[];
  for (const t of templates) {
    const problem = ruleTemplateProblem(t.components);
    if (problem) throw new HttpError(400, `The template "${t.name}" ${problem.long}. ${problem.instead}`);
    for (const step of steps.filter((a) => a.templateId === t.id)) {
      const missing = missingTemplateValue(t.components, step);
      if (missing) throw new HttpError(400, `The template "${t.name}" ${missing}.`);
    }
  }
  if (!phoneNumberId) return;
  const phone = await prisma.phoneNumber.findFirst({ where: { id: phoneNumberId, tenantId }, select: { wabaRefId: true } });
  const foreign = phone?.wabaRefId ? templates.find((t) => t.wabaRefId && t.wabaRefId !== phone.wabaRefId) : undefined;
  if (foreign) throw new HttpError(400, `The template "${foreign.name}" belongs to a different WhatsApp Business account than this rule's number. Choose a template of that account, or another number.`);
}

async function nextPriority(tenantId: string): Promise<number> {
  const top = await prisma.automationRule.findFirst({ where: { tenantId, version: 2 }, orderBy: { priority: "desc" }, select: { priority: true } });
  return (top?.priority ?? 0) + 10;
}

export const getRule = (tenantId: string, id: string) => prisma.automationRule.findFirst({ where: { id, tenantId } });

export async function createRuleV2(tenantId: string, raw: unknown) {
  const input = validateRuleV2(raw, false);
  const def = input.definition!;
  assertScheduleNotPast(def);
  await assertPhoneOwned(tenantId, input.phoneNumberId);
  await assertReferencesOwned(tenantId, def);
  await assertTemplatesUsable(tenantId, def, input.phoneNumberId);
  if ((await prisma.automationRule.count({ where: { tenantId } })) >= LIMITS.rules) throw new HttpError(409, `You can have up to ${LIMITS.rules} rules.`);
  return prisma.automationRule.create({
    data: {
      tenantId,
      // The classic columns are required by the table; v2 rows ignore them.
      type: "keyword",
      replyText: "",
      keywords: [],
      name: input.name!,
      enabled: input.enabled ?? true,
      phoneNumberId: input.phoneNumberId ?? null,
      cooldownMinutes: input.cooldownMinutes ?? 5,
      version: 2,
      priority: await nextPriority(tenantId),
      trigger: json(def.trigger),
      filters: json(def.filters),
      actions: json(def.actions),
      stopAfterMatch: input.stopAfterMatch ?? false,
    },
  });
}

export async function updateRuleV2(tenantId: string, id: string, raw: unknown) {
  const current = await prisma.automationRule.findFirst({ where: { id, tenantId, version: 2 } });
  if (!current) throw new HttpError(404, "Rule not found.");
  const input = validateRuleV2(raw, true, { trigger: current.trigger, filters: current.filters, actions: current.actions });
  await assertPhoneOwned(tenantId, input.phoneNumberId);
  if (input.definition) {
    assertScheduleNotPast(input.definition);
    await assertReferencesOwned(tenantId, input.definition);
  }
  // A new number, new steps, or both: the templates must still be sendable from the rule's number.
  const phoneNumberId = input.phoneNumberId !== undefined ? input.phoneNumberId : current.phoneNumberId;
  const stored = input.definition ? null : input.phoneNumberId !== undefined ? parseDefinition({ trigger: current.trigger, filters: current.filters, actions: current.actions }) : null;
  const checked = input.definition ?? (stored?.ok ? stored.value : null);
  if (checked) await assertTemplatesUsable(tenantId, checked, phoneNumberId);
  const { definition, ...plain } = input;
  const data: Prisma.AutomationRuleUpdateManyMutationInput = {
    ...plain,
    ...(definition ? { trigger: json(definition.trigger), filters: json(definition.filters), actions: json(definition.actions) } : {}),
  };
  const { count } = await prisma.automationRule.updateMany({ where: { id, tenantId, version: 2 }, data });
  if (count === 0) throw new HttpError(404, "Rule not found.");
  return prisma.automationRule.findFirst({ where: { id, tenantId } });
}

/** Moves a v2 rule one place up (runs earlier) or down. Priorities are renumbered 10, 20, 30 so they stay tidy. */
export async function moveRule(tenantId: string, id: string, direction: "up" | "down"): Promise<void> {
  const rules = (await prisma.automationRule.findMany({ where: { tenantId, version: 2 }, select: { id: true, priority: true, createdAt: true } })).sort(byPriority);
  const index = rules.findIndex((r) => r.id === id);
  if (index < 0) throw new HttpError(404, "Rule not found.");
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= rules.length) return;
  [rules[index], rules[target]] = [rules[target], rules[index]];
  // Only rows whose number changes are written, so moving one rule does not count as editing the others.
  const changes = rules.flatMap((r, i) => (r.priority === (i + 1) * 10 ? [] : [prisma.automationRule.updateMany({ where: { id: r.id, tenantId }, data: { priority: (i + 1) * 10 } })]));
  if (changes.length) await prisma.$transaction(changes);
}

const CLASSIC_ORDER = { keyword: 10, welcome: 20, away: 30 } as const;

/**
 * The v2 equivalent of a classic rule. Classic replies stay quiet while a person is handling the chat (engine.ts busyReason), so
 * the converted rule keeps "Reply even while a person is handling the chat" off and stays quiet then too. Two things differ on
 * purpose, and the conversion dialog (AutomationView CONVERT_BODY) names them: v2 runs count toward the monthly rule allowance, and
 * the rule goes after the rules already in the new format. A classic away rule without usable opening hours (which never replied)
 * cannot be converted until the hours are set.
 */
export function convertDefinition(rule: { type: "welcome" | "away" | "keyword"; keywords: string[]; matchMode: string; replyText: string; schedule: unknown; cooldownMinutes: number }): RuleDefinition {
  const filters = emptyFilters();
  if (rule.type === "keyword") filters.root.items.push({ type: "keyword", mode: rule.matchMode === "exact" ? "exact" : "contains", keywords: rule.keywords });
  if (rule.type === "welcome") filters.root.items.push({ type: "quiet_for", minutes: Math.max(1, rule.cooldownMinutes) });
  if (rule.type === "away") {
    const s = parseSchedule(rule.schedule);
    if (!s) throw new HttpError(409, "This away message has no opening hours yet, so it has never been sent. Set its opening hours first, then convert it.");
    filters.root.items.push({ type: "time_window", inside: false, timezone: s.timezone, days: s.days, start: s.start, end: s.end });
  }
  return { trigger: { type: "message_received" }, filters, actions: [{ type: "send_text", text: rule.replyText }] };
}

/** A converted rule goes after the rules already in the new format, which is where classic rules always ran. */
export async function convertRule(tenantId: string, id: string) {
  const rule = await prisma.automationRule.findFirst({ where: { id, tenantId } });
  if (!rule) throw new HttpError(404, "Rule not found.");
  if (rule.version === 2) throw new HttpError(409, "This rule is already in the new format.");
  const def = convertDefinition({ ...rule, keywords: rule.keywords, schedule: rule.schedule });
  const parsed = parseDefinition({ trigger: def.trigger, filters: def.filters, actions: def.actions });
  if (!parsed.ok) throw new HttpError(409, `This rule cannot be converted automatically. ${parsed.error}`);
  const { count } = await prisma.automationRule.updateMany({
    where: { id, tenantId, version: 1 },
    data: {
      version: 2,
      priority: await nextPriority(tenantId),
      trigger: json(parsed.value.trigger),
      filters: json(parsed.value.filters),
      actions: json(parsed.value.actions),
      stopAfterMatch: false,
    },
  });
  if (count === 0) throw new HttpError(409, "This rule changed while converting. Reload and try again.");
  return prisma.automationRule.findFirst({ where: { id, tenantId } });
}

export type RuleActivity = { lastRun: { at: Date; outcome: string; detail: string | null } | null; runs30d: number };

/** All rules of the workspace, v2 first in running order and classic ones after, each with its last run and 30-day count. */
export async function listRulesWithActivity(tenantId: string, now = new Date()) {
  const rules = await prisma.automationRule.findMany({ where: { tenantId } });
  const ids = rules.map((r) => r.id);
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const [lastExec, countsExec, lastRuns, countsRuns] = await Promise.all([
    prisma.ruleExecution.findMany({ where: { tenantId, ruleId: { in: ids } }, orderBy: { createdAt: "desc" }, distinct: ["ruleId"], select: { ruleId: true, createdAt: true, outcome: true, detail: true } }),
    prisma.ruleExecution.groupBy({ by: ["ruleId"], where: { tenantId, ruleId: { in: ids }, outcome: "ok", createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.automationRun.findMany({ where: { tenantId, ruleId: { in: ids } }, orderBy: { createdAt: "desc" }, distinct: ["ruleId"], select: { ruleId: true, createdAt: true } }),
    prisma.automationRun.groupBy({ by: ["ruleId"], where: { tenantId, ruleId: { in: ids }, createdAt: { gte: since } }, _count: { _all: true } }),
  ]);
  const last = new Map<string, RuleActivity["lastRun"]>();
  for (const r of lastRuns) last.set(r.ruleId, { at: r.createdAt, outcome: "ok", detail: null });
  for (const r of lastExec) last.set(r.ruleId, { at: r.createdAt, outcome: r.outcome, detail: r.detail });
  const counts = new Map<string, number>();
  for (const c of countsRuns) counts.set(c.ruleId, c._count._all);
  for (const c of countsExec) counts.set(c.ruleId, c._count._all);

  const v2 = rules.filter((r) => r.version === 2).sort(byPriority);
  const classic = rules.filter((r) => r.version !== 2).sort((a, b) => (CLASSIC_ORDER[a.type] ?? 30) - (CLASSIC_ORDER[b.type] ?? 30) || a.createdAt.getTime() - b.createdAt.getTime());
  return [...v2, ...classic].map((r) => ({ ...r, lastRun: last.get(r.id) ?? null, runs30d: counts.get(r.id) ?? 0 }));
}

export type ExecutionQuery = { ruleId?: string; outcome?: string; cursor?: string; limit?: number };

/** Execution log, newest first, with the rule name and the contact's name (or last four digits). */
export async function listExecutions(tenantId: string, q: ExecutionQuery) {
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? 30), 1), 100);
  const cursor = q.cursor && (await prisma.ruleExecution.findFirst({ where: { id: q.cursor, tenantId }, select: { id: true } })) ? q.cursor : undefined;
  const rows = await prisma.ruleExecution.findMany({
    where: { tenantId, ...(q.ruleId ? { ruleId: q.ruleId } : {}), ...(q.outcome && ["ok", "skipped", "failed"].includes(q.outcome) ? { outcome: q.outcome } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const items = rows.slice(0, limit);
  const ruleIds = [...new Set(items.map((r) => r.ruleId))];
  const contactIds = [...new Set(items.map((r) => r.contactId).filter((x): x is string => Boolean(x)))];
  const [rules, contacts] = await Promise.all([
    ruleIds.length ? prisma.automationRule.findMany({ where: { tenantId, id: { in: ruleIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    contactIds.length ? prisma.contact.findMany({ where: { tenantId, id: { in: contactIds } }, select: { id: true, name: true, phone: true, bsuid: true, username: true } }) : Promise.resolve([]),
  ]);
  const ruleName = new Map(rules.map((r) => [r.id, r.name]));
  const contactName = new Map(contacts.map((c) => [c.id, c.name?.trim() || (c.phone ? `Contact ending ${c.phone.slice(-4)}` : displayName(c))]));
  return {
    items: items.map((r) => ({
      id: r.id,
      ruleId: r.ruleId,
      ruleName: r.ruleId === "holiday" ? "Holiday mode" : (ruleName.get(r.ruleId) ?? "Deleted rule"),
      conversationId: r.conversationId,
      contactName: r.contactId ? (contactName.get(r.contactId) ?? "Deleted contact") : null,
      outcome: r.outcome,
      detail: r.detail,
      createdAt: r.createdAt,
    })),
    nextCursor: rows.length > limit ? items[items.length - 1].id : null,
  };
}

/**
 * Choices for the rule builder's dropdowns: only what this workspace has. Each template says whether a rule can send it
 * (sendable; when not, reason follows "it" and instead says what to do, the same check a save makes), what the step must fill in
 * besides the text values (needs: a heading value, a heading picture, video or file, a link button value) and which WhatsApp
 * Business account it belongs to, as does each number.
 */
export async function getBuilderOptions(tenantId: string) {
  const [templates, chatbots, sequences, teams, members, segments, materials, phoneNumbers] = await Promise.all([
    prisma.template.findMany({ where: { tenantId, status: "approved" }, orderBy: { name: "asc" }, take: 200, select: { id: true, name: true, language: true, category: true, components: true, wabaRefId: true } }),
    prisma.chatbot.findMany({ where: { tenantId, status: "published" }, orderBy: { name: "asc" }, take: 100, select: { id: true, name: true } }),
    prisma.leadSequence.findMany({ where: { tenantId, enabled: true }, orderBy: { name: "asc" }, take: 100, select: { id: true, name: true } }),
    prisma.team.findMany({ where: { tenantId }, orderBy: { name: "asc" }, take: 100, select: { id: true, name: true } }),
    prisma.membership.findMany({ where: { tenantId, user: { disabledAt: null } }, orderBy: { createdAt: "asc" }, take: 200, select: { userId: true, user: { select: { name: true, email: true } } } }),
    prisma.segment.findMany({ where: { tenantId }, orderBy: { name: "asc" }, take: 100, select: { id: true, name: true } }),
    prisma.replyMaterial.findMany({ where: { tenantId }, orderBy: { name: "asc" }, take: 200, select: { id: true, name: true, kind: true } }),
    prisma.phoneNumber.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" }, take: 20, select: { id: true, displayPhone: true, verifiedName: true, wabaRefId: true } }),
  ]);
  return {
    templates: templates.map((t) => {
      const problem = ruleTemplateProblem(t.components);
      const needs = templateFillNeeds(t.components);
      return {
        id: t.id,
        name: t.name,
        language: t.language,
        category: t.category,
        variables: countBodyVariables(t.components),
        wabaRefId: t.wabaRefId ?? null,
        needs: { headerText: needs.headerText, headerMedia: needs.headerMedia, buttonValue: needs.buttonValue },
        sendable: !problem,
        ...(problem ? { reason: problem.short, instead: problem.instead } : {}),
      };
    }),
    chatbots,
    sequences,
    teams,
    members: members.map((m) => ({ userId: m.userId, name: m.user.name || m.user.email })),
    segments,
    materials,
    phoneNumbers,
  };
}

function countBodyVariables(components: unknown): number {
  const body = (Array.isArray(components) ? components : []).find((c) => c && typeof c === "object" && String((c as { type?: unknown }).type).toUpperCase() === "BODY") as { text?: unknown } | undefined;
  let max = 0;
  for (const m of String(body?.text ?? "").matchAll(/\{\{(\d+)\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}
