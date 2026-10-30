import { EXTRA_LIMITS, type RoutingExtra } from "@/lib/routing/extra-config";

export type ExtraForm = {
  lastOn: boolean;
  lastHours: string;
  ownerFirst: boolean;
  ownerOnAssign: boolean;
  reassignOn: boolean;
  reassignMinutes: string;
  reassignMoves: string;
  teamVisibility: boolean;
  viewAll: boolean;
  viewIds: string[];
  maskAll: boolean;
  maskIds: string[];
  stages: string;
};

export type ExtraErrors = Partial<Record<"lastHours" | "reassignMinutes" | "reassignMoves" | "stages", string>>;

export function toExtraForm(e: RoutingExtra): ExtraForm {
  return {
    lastOn: e.lastAssignee.enabled,
    lastHours: String(e.lastAssignee.withinHours),
    ownerFirst: e.contactOwner.enabled,
    ownerOnAssign: e.setOwnerOnAssign,
    reassignOn: e.autoReassign.enabled,
    reassignMinutes: String(e.autoReassign.minutes),
    reassignMoves: String(e.autoReassign.maxMoves),
    teamVisibility: e.teamVisibility,
    viewAll: e.viewOnlyAssigned.allAgents,
    viewIds: e.viewOnlyAssigned.userIds,
    maskAll: e.maskPhone.allAgents,
    maskIds: e.maskPhone.userIds,
    stages: e.leadStages.join("\n"),
  };
}

export function parseStages(text: string): string[] {
  return text.split("\n").map((s) => s.trim()).filter(Boolean);
}

const whole = (text: string, min: number, max: number): number | null => {
  if (!/^\d{1,5}$/.test(text.trim())) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
};

export function validateExtraForm(f: ExtraForm): ExtraErrors {
  const errors: ExtraErrors = {};
  const { withinHours, minutes, maxMoves, stages, stageLength } = EXTRA_LIMITS;
  if (f.lastOn && whole(f.lastHours, withinHours.min, withinHours.max) === null) errors.lastHours = `Enter a whole number of hours from ${withinHours.min} to ${withinHours.max}.`;
  if (f.reassignOn && whole(f.reassignMinutes, minutes.min, minutes.max) === null) errors.reassignMinutes = `Enter a whole number of minutes from ${minutes.min} to ${minutes.max}.`;
  if (f.reassignOn && whole(f.reassignMoves, maxMoves.min, maxMoves.max) === null) errors.reassignMoves = `Enter a whole number from ${maxMoves.min} to ${maxMoves.max}.`;
  const list = parseStages(f.stages);
  if (list.length === 0) errors.stages = "Add at least one lead stage.";
  else if (list.length > stages) errors.stages = `Use at most ${stages} stages.`;
  else if (list.some((s) => s.length > stageLength)) errors.stages = `Each stage can have at most ${stageLength} characters.`;
  else if (new Set(list.map((s) => s.toLowerCase())).size !== list.length) errors.stages = "Each stage needs a different name.";
  return errors;
}

/** Fields that are switched off keep their last good number, so hidden half-typed values never block a save. */
export function toExtraBody(f: ExtraForm, saved: RoutingExtra): RoutingExtra {
  const { withinHours, minutes, maxMoves } = EXTRA_LIMITS;
  return {
    lastAssignee: { enabled: f.lastOn, withinHours: (f.lastOn ? whole(f.lastHours, withinHours.min, withinHours.max) : null) ?? saved.lastAssignee.withinHours },
    contactOwner: { enabled: f.ownerFirst },
    setOwnerOnAssign: f.ownerOnAssign,
    autoReassign: {
      enabled: f.reassignOn,
      minutes: (f.reassignOn ? whole(f.reassignMinutes, minutes.min, minutes.max) : null) ?? saved.autoReassign.minutes,
      maxMoves: (f.reassignOn ? whole(f.reassignMoves, maxMoves.min, maxMoves.max) : null) ?? saved.autoReassign.maxMoves,
    },
    viewOnlyAssigned: { allAgents: f.viewAll, userIds: f.viewIds },
    maskPhone: { allAgents: f.maskAll, userIds: f.maskIds },
    teamVisibility: f.teamVisibility,
    leadStages: parseStages(f.stages),
  };
}

export function isExtraDirty(a: ExtraForm, b: ExtraForm): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

export function extraSummary(e: RoutingExtra): string {
  const parts: string[] = [];
  if (e.lastAssignee.enabled) parts.push("returning customers go back to their last agent");
  if (e.contactOwner.enabled) parts.push("contact owners get their customers first");
  if (e.autoReassign.enabled) parts.push(`unanswered chats move on after ${e.autoReassign.minutes} min`);
  return parts.length ? `${parts[0][0].toUpperCase()}${parts[0].slice(1)}${parts.length > 1 ? `, ${parts.slice(1).join(", ")}` : ""}.` : "No extra routing rules are on.";
}
