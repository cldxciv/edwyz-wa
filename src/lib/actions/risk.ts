/**
 * Risk classes of the action layer (docs/EDDY-SPEC.md 4.2). deriveRisk is the rule of 4.2, verbatim: anything loud
 * (messages customers, spends, deletes, cannot be undone, arms automation, exports personal data, changes access, returns a
 * secret, touches more than 10 subjects, or writes to Meta without lowering activity) needs a card; other writes are
 * undoable; reads run at once. A definition may declare a stricter risk, never a weaker one (assertRiskFloor). Pure.
 */
import type { Effects, Risk } from "./types";

export const RISKS: readonly Risk[] = ["instant", "undoable", "confirm"];

export function deriveRisk(e: Effects): Risk {
  const loud = e.messagesCustomers || (e.spends ?? 'none') !== 'none' || e.deletes || e.irreversible
    || e.armsAutomation || e.exportsPii || e.changesAccess || e.returnsSecret || e.bulk
    || (e.external && e.writes && !e.lowersActivity);
  if (loud) return 'confirm';
  if (!e.writes) return 'instant';
  return 'undoable';          // must declare undo (a lowering action may undo through a card: inverseAction)
}

export function riskRank(risk: Risk): number {
  return RISKS.indexOf(risk);
}

/** The stricter of two risks. */
export function maxRisk(a: Risk, b: Risk): Risk {
  return riskRank(a) >= riskRank(b) ? a : b;
}

/** The risk a call runs at: the higher of the declared and the derived risk (4.2, dynamic effects included). */
export function effectiveRisk(declared: Risk | undefined, effects: Effects): Risk {
  return maxRisk(declared ?? "instant", deriveRisk(effects));
}

export class RiskFloorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RiskFloorError";
  }
}

/**
 * Throws when a definition declares a risk below what its effects derive (the registry refuses to load it), and returns
 * the risk it runs at otherwise.
 */
export function assertRiskFloor(name: string, declared: Risk | undefined, effects: Effects): Risk {
  const derived = deriveRisk(effects);
  if (declared !== undefined && riskRank(declared) < riskRank(derived)) {
    throw new RiskFloorError(`Action ${name} declares risk "${declared}", below the "${derived}" its effects need.`);
  }
  return declared === undefined ? derived : maxRisk(declared, derived);
}

/** The effects every flag of a definition can raise, merged (true wins; a spending pot wins over none). */
export function mergeEffects(base: Effects, extra: Partial<Effects>): Effects {
  const out: Effects = { ...base };
  for (const [key, value] of Object.entries(extra) as [keyof Effects, Effects[keyof Effects]][]) {
    if (key === "spends") {
      if (value && value !== "none" && (out.spends ?? "none") === "none") out.spends = value as Effects["spends"];
    } else if (value === true) {
      (out as Record<string, unknown>)[key] = true;
    }
  }
  return out;
}
