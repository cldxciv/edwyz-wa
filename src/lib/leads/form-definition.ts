import { graphFetchAs } from "@/lib/graph";
import { consentKind } from "./fields";

type FormDefinition = {
  questions?: { key?: unknown; label?: unknown }[];
  legal_content?: { custom_disclaimer?: { checkboxes?: { key?: unknown; text?: unknown }[] } };
};

const TIMEOUT_MS = 8_000;
const MAX_KEYS = 100;
const TERMS_TEXT = /\b(terms|conditions|privacy|policy|gdpr|cookies?|tos|tnc|processing|storage|personal|profiling|data)\b/i;

/**
 * The key of the WhatsApp consent box on every form built in Edwyz (promote/catalog/lead-questions CONSENT_CHECKBOX, D35). Its
 * words say "opt in", so consentKind reads it as a consent question whatever the box's text or language.
 */
export const BUILT_CONSENT_KEY = "whatsapp_opt_in";

/** What a Meta lead form defines, reduced to the question names that matter for consent. Names are lower-cased like the keys of a lead's field_data. */
export type FormDefinitionKeys = {
  /** Every question name in the form. */
  questionKeys: string[];
  /** Consent questions: an opt-in phrase, or a consent verb with a messaging word, in the question's name or label (or a disclaimer checkbox's text). */
  consentKeys: string[];
  /** Questions tied to a messaging channel without a consent verb ("Receive WhatsApp updates"), and disclaimer checkboxes whose text says nothing either way. Counted only when answered yes or no, or when there is no other consent question. */
  channelKeys: string[];
};

type Item = { key?: unknown; label?: unknown; text?: unknown };

/**
 * Sorts a form's questions and disclaimer checkboxes by key and label. A disclaimer checkbox is a consent question only when its
 * key or text reads as one (consentKind): a terms, privacy or "agree to the policy" checkbox is not, one that says nothing either
 * way is a channel question, and a checkbox with no key of its own is skipped (its answer cannot be matched to a lead's fields).
 */
function sortDefinition(questions: readonly unknown[], checkboxes: readonly unknown[]): FormDefinitionKeys {
  const questionKeys = new Set<string>();
  const consentKeys = new Set<string>();
  const channelKeys = new Set<string>();
  const add = (key: string, label: string | null, strictTerms: boolean) => {
    const kind = consentKind(key, label);
    if (kind === "consent") consentKeys.add(key);
    else if (kind === "channel") channelKeys.add(key);
    else if (strictTerms && !TERMS_TEXT.test(`${key} ${label ?? ""}`.replace(/[_-]+/g, " "))) channelKeys.add(key);
  };
  for (const q of questions.slice(0, MAX_KEYS) as Item[]) {
    if (typeof q?.key !== "string" || !q.key) continue;
    const key = q.key.toLowerCase().slice(0, 100);
    questionKeys.add(key);
    add(key, typeof q.label === "string" ? q.label : null, false);
  }
  for (const box of checkboxes.slice(0, MAX_KEYS) as Item[]) {
    if (typeof box?.key !== "string" || !box.key) continue;
    const key = box.key.toLowerCase().slice(0, 100);
    questionKeys.add(key);
    add(key, typeof box.text === "string" ? box.text : null, true);
  }
  return { questionKeys: [...questionKeys], consentKeys: [...consentKeys], channelKeys: [...channelKeys] };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Reads the question list and the legal checkboxes of a Meta lead form and sorts them by their key and label (sortDefinition).
 * Returns null when Meta does not answer or the answer has no question list, so the caller never concludes "no consent question"
 * from a failure. Best effort and read-only.
 */
export async function fetchFormDefinitionKeys(pageToken: string, metaFormId: string): Promise<FormDefinitionKeys | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);
    });
    const res = await Promise.race([graphFetchAs<FormDefinition>(pageToken, { path: metaFormId, query: { fields: "questions,legal_content" } }), timeout]);
    if (!res || !Array.isArray(res.questions)) return null;
    const boxes = res.legal_content?.custom_disclaimer?.checkboxes;
    return sortDefinition(res.questions, Array.isArray(boxes) ? boxes : []);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What a form built in Edwyz defines, read from the spec it was built from (LeadForm.spec, 5.4) rather than from Meta: Edwyz
 * sent that spec, so it is known before the first lead and costs no Meta call. Its one consent question is the WhatsApp box
 * `whatsapp_opt_in` (D35), when the form has it: a lead who leaves it unticked (Meta then leaves it out, or sends it empty) is not
 * opted in. Every other box the owner added ("Send me email offers") and every question is data, never WhatsApp consent, so an
 * unticked email box cannot undo a ticked WhatsApp box. Only the owner's own questions carry a key in the spec; Meta names the
 * preset ones (full name, phone) itself. Null when the spec is not a built form's (an imported form's spec has no disclaimer, and an
 * old row may have no spec at all).
 */
export function builtFormDefinitionKeys(spec: unknown): FormDefinitionKeys | null {
  if (!isObject(spec) || !Array.isArray(spec.questions)) return null;
  const disclaimer = spec.disclaimer;
  if (disclaimer !== null && !isObject(disclaimer)) return null;
  const boxes = isObject(disclaimer) && Array.isArray(disclaimer.checkboxes) ? disclaimer.checkboxes : [];
  const own = (spec.questions as unknown[]).filter((q) => isObject(q) && q.type === "CUSTOM");
  const { questionKeys } = sortDefinition(own, boxes);
  const hasBox = (boxes as unknown[]).some((b) => isObject(b) && typeof b.key === "string" && b.key.toLowerCase() === BUILT_CONSENT_KEY);
  return { questionKeys, consentKeys: hasBox ? [BUILT_CONSENT_KEY] : [], channelKeys: [] };
}

/** Consent questions only; null when the definition could not be read. */
export async function fetchFormConsentKeys(pageToken: string, metaFormId: string): Promise<string[] | null> {
  const def = await fetchFormDefinitionKeys(pageToken, metaFormId);
  return def ? [...def.consentKeys, ...def.channelKeys] : null;
}
