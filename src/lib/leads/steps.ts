import { HttpError } from "@/lib/tenancy";

export type Step = { delayMinutes: number; templateId?: string; chatbotId?: string; stopOnReply: boolean; params?: string[] };
export type AppliesTo = { leadFormId?: string; campaignMetaId?: string };

export const MAX_STEPS = 10;
const MAX_DELAY = 60 * 24 * 30;
const PARAM = /^(name|email|phone|field:[a-z0-9_ ]{1,100})$/;

function bad(message: string): never {
  throw new HttpError(400, message);
}

export function parseSteps(value: unknown): Step[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_STEPS) bad(`steps must be a list of 1 to ${MAX_STEPS} steps.`);
  return value.map((raw, i) => {
    if (!raw || typeof raw !== "object") bad(`Step ${i + 1} is invalid.`);
    const s = raw as Record<string, unknown>;
    const delay = i === 0 ? 0 : s.delayMinutes;
    if (typeof delay !== "number" || !Number.isInteger(delay) || delay < 0 || delay > MAX_DELAY) bad(`Step ${i + 1}: delayMinutes must be a whole number of minutes.`);
    const templateId = optId(s.templateId, `Step ${i + 1}: templateId`);
    const chatbotId = optId(s.chatbotId, `Step ${i + 1}: chatbotId`);
    if (!templateId && !chatbotId) bad(`Step ${i + 1} needs a template or a chatbot.`);
    if (s.stopOnReply !== undefined && typeof s.stopOnReply !== "boolean") bad(`Step ${i + 1}: stopOnReply must be true or false.`);
    return { delayMinutes: delay, templateId, chatbotId, stopOnReply: s.stopOnReply !== false, params: parseParams(s.params, i) };
  });
}

function optId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 64) bad(`${label} is invalid.`);
  return value;
}

function parseParams(value: unknown, i: number): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 10 || value.some((p) => typeof p !== "string" || !PARAM.test(p))) {
    bad(`Step ${i + 1}: params must list name, email, phone or field:<key>.`);
  }
  return value as string[];
}

export function parseAppliesTo(value: unknown): AppliesTo | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) bad("appliesTo must be an object.");
  const v = value as Record<string, unknown>;
  const out: AppliesTo = {};
  const form = optId(v.leadFormId, "leadFormId");
  const campaign = optId(v.campaignMetaId, "campaignMetaId");
  if (form) out.leadFormId = form;
  if (campaign) out.campaignMetaId = campaign;
  return Object.keys(out).length ? out : null;
}

export function readSteps(stored: unknown): Step[] {
  try {
    return parseSteps(stored);
  } catch {
    return [];
  }
}

export function matchesSequence(appliesTo: unknown, lead: { leadFormId: string | null; campaignMetaId: string | null }): boolean {
  if (!appliesTo || typeof appliesTo !== "object") return true;
  const a = appliesTo as AppliesTo;
  if (a.leadFormId && a.leadFormId !== lead.leadFormId) return false;
  if (a.campaignMetaId && a.campaignMetaId !== lead.campaignMetaId) return false;
  return true;
}
