import { graphFetchAs } from "@/lib/graph";
import { consentKind } from "./fields";

type FormDefinition = {
  questions?: { key?: unknown; label?: unknown }[];
  legal_content?: { custom_disclaimer?: { checkboxes?: { key?: unknown; text?: unknown }[] } };
};

const TIMEOUT_MS = 8_000;
const MAX_KEYS = 100;
const TERMS_TEXT = /\b(terms|conditions|privacy|policy|gdpr|cookies?|tos|tnc|processing|storage|personal|profiling|data)\b/i;

/** What a Meta lead form defines, reduced to the question names that matter for consent. Names are lower-cased like the keys of a lead's field_data. */
export type FormDefinitionKeys = {
  /** Every question name in the form. */
  questionKeys: string[];
  /** Consent questions: an opt-in phrase, or a consent verb with a messaging word, in the question's name or label (or a disclaimer checkbox's text). */
  consentKeys: string[];
  /** Questions tied to a messaging channel without a consent verb ("Receive WhatsApp updates"), and disclaimer checkboxes whose text says nothing either way. Counted only when answered yes or no, or when there is no other consent question. */
  channelKeys: string[];
};

/**
 * Reads the question list and the legal checkboxes of a Meta lead form and sorts them by their key and label. A disclaimer checkbox
 * is a consent question only when its key or text reads as one: a terms, privacy or "agree to the policy" checkbox is not, and a
 * checkbox with no key of its own is skipped (its answer cannot be matched to a lead's fields). Returns null when Meta does not
 * answer or the answer has no question list, so the caller never concludes "no consent question" from a failure. Best effort and read-only.
 */
export async function fetchFormDefinitionKeys(pageToken: string, metaFormId: string): Promise<FormDefinitionKeys | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);
    });
    const res = await Promise.race([graphFetchAs<FormDefinition>(pageToken, { path: metaFormId, query: { fields: "questions,legal_content" } }), timeout]);
    if (!res || !Array.isArray(res.questions)) return null;
    const questionKeys = new Set<string>();
    const consentKeys = new Set<string>();
    const channelKeys = new Set<string>();
    const add = (key: string, label: string | null, strictTerms: boolean) => {
      const kind = consentKind(key, label);
      if (kind === "consent") consentKeys.add(key);
      else if (kind === "channel") channelKeys.add(key);
      else if (strictTerms && !TERMS_TEXT.test(`${key} ${label ?? ""}`.replace(/[_-]+/g, " "))) channelKeys.add(key);
    };
    for (const q of res.questions.slice(0, MAX_KEYS)) {
      if (typeof q?.key !== "string" || !q.key) continue;
      const key = q.key.toLowerCase().slice(0, 100);
      questionKeys.add(key);
      add(key, typeof q.label === "string" ? q.label : null, false);
    }
    const boxes = res.legal_content?.custom_disclaimer?.checkboxes;
    for (const box of (Array.isArray(boxes) ? boxes : []).slice(0, MAX_KEYS)) {
      if (typeof box?.key !== "string" || !box.key) continue;
      const key = box.key.toLowerCase().slice(0, 100);
      questionKeys.add(key);
      add(key, typeof box.text === "string" ? box.text : null, true);
    }
    return { questionKeys: [...questionKeys], consentKeys: [...consentKeys], channelKeys: [...channelKeys] };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Consent questions only; null when the definition could not be read. */
export async function fetchFormConsentKeys(pageToken: string, metaFormId: string): Promise<string[] | null> {
  const def = await fetchFormDefinitionKeys(pageToken, metaFormId);
  return def ? [...def.consentKeys, ...def.channelKeys] : null;
}
