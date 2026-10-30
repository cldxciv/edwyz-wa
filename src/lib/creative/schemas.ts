import { COPY_LIMITS, PLACEMENTS, type Placement } from "./constants";

export type Angle = { hook: string; audience: string; cta: string; rationale: string };
export type CopyVariant = { placement: Placement; headline: string; primaryText: string; description: string };
export type ResearchSummary = { offer: string; audience: string; tone: string; proofPoints: string[] };

export class SchemaError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function str(obj: Record<string, unknown>, key: string, max: number, optional = false): string {
  const v = obj[key];
  if (v === undefined || v === null || v === "") {
    if (optional) return "";
    throw new SchemaError(`"${key}" is missing`);
  }
  if (typeof v !== "string") throw new SchemaError(`"${key}" must be a string`);
  const t = v.trim();
  if (!t && !optional) throw new SchemaError(`"${key}" is empty`);
  if (t.length > max) throw new SchemaError(`"${key}" is longer than ${max} characters`);
  return t;
}

/** Pulls the first JSON value out of model output, tolerating code fences and surrounding prose. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.search(/[{[]/);
  if (start < 0) throw new SchemaError("no JSON found");
  const open = body[start];
  const end = body.lastIndexOf(open === "{" ? "}" : "]");
  if (end <= start) throw new SchemaError("unterminated JSON");
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new SchemaError("invalid JSON syntax");
  }
}

export function parseAngles(raw: unknown): Angle[] {
  const list = isObj(raw) ? raw.angles : raw;
  if (!Array.isArray(list)) throw new SchemaError('expected {"angles": [...]}');
  if (list.length < 3 || list.length > 5) throw new SchemaError("expected 3 to 5 angles");
  return list.map((item, i) => {
    if (!isObj(item)) throw new SchemaError(`angle ${i + 1} is not an object`);
    return { hook: str(item, "hook", 300), audience: str(item, "audience", 300), cta: str(item, "cta", 80), rationale: str(item, "rationale", 600, true) };
  });
}

export function parseResearch(raw: unknown): ResearchSummary {
  if (!isObj(raw)) throw new SchemaError("expected an object");
  const proof = raw.proofPoints;
  if (!Array.isArray(proof) || proof.length > 10 || proof.some((p) => typeof p !== "string" || p.length > 300)) {
    throw new SchemaError('"proofPoints" must be an array of up to 10 short strings');
  }
  return { offer: str(raw, "offer", 600), audience: str(raw, "audience", 600), tone: str(raw, "tone", 300), proofPoints: proof.map((p) => (p as string).trim()).filter(Boolean) };
}

/** Hard cap is twice the Meta limit so only absurd output is rejected; ordinary overruns are surfaced by the policy check instead. */
export function parseCopy(raw: unknown, placements: Placement[]): CopyVariant[] {
  const list = isObj(raw) ? raw.variants : raw;
  if (!Array.isArray(list)) throw new SchemaError('expected {"variants": [...]}');
  const out = list.map((item, i) => {
    if (!isObj(item)) throw new SchemaError(`variant ${i + 1} is not an object`);
    const placement = item.placement;
    if (typeof placement !== "string" || !(PLACEMENTS as readonly string[]).includes(placement)) throw new SchemaError(`variant ${i + 1} has an unknown placement`);
    const limits = COPY_LIMITS[placement as Placement];
    return {
      placement: placement as Placement,
      headline: str(item, "headline", limits.headline * 2),
      primaryText: str(item, "primaryText", limits.primaryText * 2),
      description: str(item, "description", limits.description * 2, true),
    };
  });
  for (const p of placements) if (!out.some((v) => v.placement === p)) throw new SchemaError(`no variant for placement ${p}`);
  return out.filter((v) => placements.includes(v.placement));
}
