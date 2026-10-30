import { KNOWN_COUNTRIES } from "@/lib/broadcasts/country";
import {
  type Condition,
  FIELDS,
  type Filter,
  MAX_CONDITIONS,
  type Op,
  OP_LABELS,
  attributeField,
  attributeKey,
  describeCondition,
  isAttributeField,
  kindOf,
  needsValue,
  opsFor,
} from "@/lib/segments/filter";

export { MAX_CONDITIONS, OP_LABELS, describeCondition, needsValue, opsFor };

export type Match = "all" | "any";
export type Draft = { match: Match; rules: Condition[] };

export const OTHER_ATTRIBUTE = "__other";

export const blankRule = (): Condition => ({ field: "tag", op: "has", value: "" });
export const emptyDraft = (): Draft => ({ match: "all", rules: [blankRule()] });

/** The filter stored with a segment: the rules sit under all or any. Rules still being filled in are left out. */
export function draftToFilter(draft: Draft): Filter {
  const rules = draft.rules.filter((r) => !ruleProblem(r));
  return rules.length ? { [draft.match]: rules } : {};
}

export function filterToDraft(filter: Filter | null | undefined): Draft {
  if (filter?.any?.length && !filter.all?.length) return { match: "any", rules: filter.any };
  const rules = [...(filter?.all ?? []), ...(filter?.any ?? [])];
  return { match: "all", rules: rules.length ? rules : [blankRule()] };
}

export function ruleProblem(c: Condition): string | null {
  const kind = kindOf(c.field);
  if (!kind) return isAttributeField(c.field) ? "Name the attribute." : "Choose what to filter on.";
  if (!opsFor(c.field).includes(c.op)) return "Choose a test.";
  if (!needsValue(c.op)) return null;
  const value = (c.value ?? "").trim();
  if (!value) return "Fill in a value.";
  if ((c.op === "within_days" || c.op === "older_than_days") && !/^\d{1,4}$/.test(value)) return "Use a whole number of days.";
  if ((c.op === "before" || c.op === "after") && Number.isNaN(Date.parse(value))) return "Pick a date.";
  if ((c.op === "greater_than" || c.op === "less_than") && !Number.isFinite(Number(value))) return "Use a number.";
  return null;
}

export const draftProblems = (draft: Draft): string[] => draft.rules.map(ruleProblem).filter((p): p is string => !!p);
export const draftIsEmpty = (draft: Draft) => draft.rules.length === 0 || draft.rules.every((r) => ruleProblem(r) !== null && !(r.value ?? "").trim() && needsValue(r.op));

export type FieldOption = { value: string; label: string; group: string };

export function fieldOptions(attributeKeys: readonly string[]): FieldOption[] {
  const details = Object.entries(FIELDS).map(([value, def]) => ({ value, label: def.label, group: "Contact details" }));
  const attrs = attributeKeys.map((key) => ({ value: attributeField(key), label: key, group: "Contact attributes" }));
  return [...details, ...attrs, { value: OTHER_ATTRIBUTE, label: "Another attribute...", group: "Contact attributes" }];
}

/** What the field select shows for a rule: attributes that are not in the known list are shown as "Another attribute". */
export function selectValueFor(field: string, attributeKeys: readonly string[]): string {
  if (!isAttributeField(field)) return field;
  return attributeKeys.includes(attributeKey(field)) ? field : OTHER_ATTRIBUTE;
}

/** Switching the field resets the test and value when the old test does not fit the new field. */
export function changeField(rule: Condition, next: string): Condition {
  const field = next === OTHER_ATTRIBUTE ? "attr:" : next;
  const ops = opsFor(field);
  const op: Op = ops.includes(rule.op) ? rule.op : ops[0];
  const keepValue = ops.includes(rule.op) && kindOf(field) === kindOf(rule.field);
  return { field, op, value: keepValue ? rule.value : "" };
}

export function changeOp(rule: Condition, op: Op): Condition {
  return { ...rule, op, value: needsValue(op) ? rule.value : undefined };
}

let displayNames: Intl.DisplayNames | null | undefined;
export function countryName(code: string): string {
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      displayNames = null;
    }
  }
  try {
    return displayNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

export const countryOptions = (): { value: string; label: string }[] =>
  KNOWN_COUNTRIES.map((c) => ({ value: c, label: `${countryName(c)} (${c})` })).sort((a, b) => a.label.localeCompare(b.label));

/** One sentence for a whole filter, for lists and the broadcast review: "Tag is tagged vip and Country is India". */
export function summarizeFilter(filter: Filter | null | undefined): string {
  if (!filter) return "Everyone who opted in";
  const all = (filter.all ?? []).map(describeCondition);
  const any = (filter.any ?? []).map(describeCondition);
  const parts = [all.join(" and "), any.length ? (any.length > 1 ? `any of: ${any.join(" or ")}` : any[0]) : ""].filter(Boolean);
  return parts.length ? parts.join(", and ") : "Everyone who opted in";
}

export type Preview = { count: number; eligible?: number; sample: { id: string; name: string | null; phone: string | null; bsuid?: string | null; username?: string | null }[]; truncated: boolean };

export function previewSentence(p: Preview, kind: "segment" | "broadcast"): string {
  const people = (n: number) => `${n.toLocaleString()} ${n === 1 ? "person" : "people"}`;
  const more = p.truncated ? " (counted from your most recent contacts)" : "";
  if (kind === "broadcast") return p.count === 0 ? "No one matches yet." : `${people(p.count)} will get this message${more}. Contacts who opted out are always left out.`;
  const base = p.count === 0 ? "No contacts match these rules." : `${people(p.count)} match these rules${more}.`;
  return p.eligible !== undefined && p.count > 0 ? `${base} ${p.eligible.toLocaleString()} of them can receive marketing messages.` : base;
}
