import type { Role } from "@/generated/prisma/client";

/**
 * Routing settings that have no column on RoutingConfig. They live in one PlatformSetting row per workspace under
 * routing:extra:<tenantId> (see docs/schema-requests.md for the column version).
 */
export type PersonScope = { allAgents: boolean; userIds: string[] };

export type RoutingExtra = {
  /** A returning customer goes back to the agent who last replied to them, when that agent can take the chat. Off until a workspace turns it on, so existing workspaces keep the routing they had. */
  lastAssignee: { enabled: boolean; withinHours: number };
  /** New chats from a contact that has an owner go to that owner when the owner can take the chat. */
  contactOwner: { enabled: boolean };
  /** Make the person who takes a chat the contact's owner when the contact has none. */
  setOwnerOnAssign: boolean;
  /** An automatically assigned chat the agent has not answered for this long moves to the next person. */
  autoReassign: { enabled: boolean; minutes: number; maxMoves: number };
  /** Agents covered here only see chats assigned to them. */
  viewOnlyAssigned: PersonScope;
  /** Agents covered here see phone numbers with the middle hidden. */
  maskPhone: PersonScope;
  /** Agents only see chats of teams they belong to (plus chats assigned to them). */
  teamVisibility: boolean;
  leadStages: string[];
};

export const DEFAULT_LEAD_STAGES = ["New lead", "Contacted", "Qualified", "Proposal sent", "Deal won", "Deal lost"];

export const EXTRA_LIMITS = { minutes: { min: 1, max: 1440 }, withinHours: { min: 1, max: 720 }, maxMoves: { min: 1, max: 10 }, stages: 12, stageLength: 40, people: 500 };

export const DEFAULT_EXTRA: RoutingExtra = {
  lastAssignee: { enabled: false, withinHours: 168 },
  contactOwner: { enabled: false },
  setOwnerOnAssign: false,
  autoReassign: { enabled: false, minutes: 15, maxMoves: 3 },
  viewOnlyAssigned: { allAgents: false, userIds: [] },
  maskPhone: { allAgents: false, userIds: [] },
  teamVisibility: false,
  leadStages: DEFAULT_LEAD_STAGES,
};

export const extraKey = (tenantId: string) => `routing:extra:${tenantId}`;
export const EXTRA_KEY_PREFIX = "routing:extra:";

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const int = (v: unknown, d: number, min: number, max: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : d);

function ids(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 64))].slice(0, EXTRA_LIMITS.people);
}

function scope(v: unknown): PersonScope {
  const r = rec(v);
  return { allAgents: bool(r.allAgents, false), userIds: ids(r.userIds) };
}

function stages(v: unknown): string[] {
  if (!Array.isArray(v)) return DEFAULT_LEAD_STAGES;
  const clean = [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => x.length > 0 && x.length <= EXTRA_LIMITS.stageLength))].slice(0, EXTRA_LIMITS.stages);
  return clean.length > 0 ? clean : DEFAULT_LEAD_STAGES;
}

/** Reads whatever is stored, falling back to the default for any missing or unusable field. */
export function parseExtra(value: unknown): RoutingExtra {
  const r = rec(value);
  const last = rec(r.lastAssignee);
  const owner = rec(r.contactOwner);
  const re = rec(r.autoReassign);
  const d = DEFAULT_EXTRA;
  return {
    lastAssignee: { enabled: bool(last.enabled, d.lastAssignee.enabled), withinHours: int(last.withinHours, d.lastAssignee.withinHours, EXTRA_LIMITS.withinHours.min, EXTRA_LIMITS.withinHours.max) },
    contactOwner: { enabled: bool(owner.enabled, d.contactOwner.enabled) },
    setOwnerOnAssign: bool(r.setOwnerOnAssign, d.setOwnerOnAssign),
    autoReassign: {
      enabled: bool(re.enabled, d.autoReassign.enabled),
      minutes: int(re.minutes, d.autoReassign.minutes, EXTRA_LIMITS.minutes.min, EXTRA_LIMITS.minutes.max),
      maxMoves: int(re.maxMoves, d.autoReassign.maxMoves, EXTRA_LIMITS.maxMoves.min, EXTRA_LIMITS.maxMoves.max),
    },
    viewOnlyAssigned: scope(r.viewOnlyAssigned),
    maskPhone: scope(r.maskPhone),
    teamVisibility: bool(r.teamVisibility, d.teamVisibility),
    leadStages: stages(r.leadStages),
  };
}

export type ExtraResult = { ok: true; value: RoutingExtra } | { ok: false; error: string };

/** Strict validation of a full replacement coming from the settings page. */
export function validateExtra(body: Record<string, unknown>): ExtraResult {
  const last = rec(body.lastAssignee);
  const owner = rec(body.contactOwner);
  const re = rec(body.autoReassign);
  const checks: [boolean, string][] = [
    [typeof last.enabled === "boolean", "lastAssignee.enabled must be true or false."],
    [Number.isInteger(last.withinHours) && (last.withinHours as number) >= EXTRA_LIMITS.withinHours.min && (last.withinHours as number) <= EXTRA_LIMITS.withinHours.max, `lastAssignee.withinHours must be a whole number from ${EXTRA_LIMITS.withinHours.min} to ${EXTRA_LIMITS.withinHours.max}.`],
    [typeof owner.enabled === "boolean", "contactOwner.enabled must be true or false."],
    [typeof body.setOwnerOnAssign === "boolean", "setOwnerOnAssign must be true or false."],
    [typeof re.enabled === "boolean", "autoReassign.enabled must be true or false."],
    [Number.isInteger(re.minutes) && (re.minutes as number) >= EXTRA_LIMITS.minutes.min && (re.minutes as number) <= EXTRA_LIMITS.minutes.max, `autoReassign.minutes must be a whole number from ${EXTRA_LIMITS.minutes.min} to ${EXTRA_LIMITS.minutes.max}.`],
    [Number.isInteger(re.maxMoves) && (re.maxMoves as number) >= EXTRA_LIMITS.maxMoves.min && (re.maxMoves as number) <= EXTRA_LIMITS.maxMoves.max, `autoReassign.maxMoves must be a whole number from ${EXTRA_LIMITS.maxMoves.min} to ${EXTRA_LIMITS.maxMoves.max}.`],
    [typeof body.teamVisibility === "boolean", "teamVisibility must be true or false."],
  ];
  for (const [ok, error] of checks) if (!ok) return { ok: false, error };
  for (const key of ["viewOnlyAssigned", "maskPhone"] as const) {
    const s = rec(body[key]);
    if (typeof s.allAgents !== "boolean") return { ok: false, error: `${key}.allAgents must be true or false.` };
    if (!Array.isArray(s.userIds) || s.userIds.length > EXTRA_LIMITS.people || s.userIds.some((x) => typeof x !== "string" || !x || x.length > 64)) return { ok: false, error: `${key}.userIds must be a list of user ids.` };
  }
  if (!Array.isArray(body.leadStages) || body.leadStages.length === 0 || body.leadStages.length > EXTRA_LIMITS.stages) return { ok: false, error: `leadStages needs 1 to ${EXTRA_LIMITS.stages} stage names.` };
  const names = body.leadStages.map((x) => (typeof x === "string" ? x.trim() : ""));
  if (names.some((x) => !x || x.length > EXTRA_LIMITS.stageLength)) return { ok: false, error: `Each lead stage must be 1 to ${EXTRA_LIMITS.stageLength} characters.` };
  if (new Set(names.map((x) => x.toLowerCase())).size !== names.length) return { ok: false, error: "Lead stage names must be different from each other." };
  return { ok: true, value: parseExtra({ ...body, leadStages: names }) };
}

/** Only people with the agent role are ever restricted: owners and admins always see everything. */
export function inScope(s: PersonScope, actor: { userId: string; role: Role | string }): boolean {
  return actor.role === "agent" && (s.allAgents || s.userIds.includes(actor.userId));
}
