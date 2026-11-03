"use client";

/**
 * usePromoteCopy (docs/IG-PAGE-ADS-SPEC.md 7.3 hooks, 7.6 language, D23): a thin hook over promoteText, so every string on
 * the ads pages comes from src/lib/promote/copy. Pages pass the language pageLang() allows (English until
 * PROMOTE_PAGE_LANGS includes more); the returned function is stable for a language.
 */
import { useCallback } from "react";
import { promoteText, type CopyVars, type PromoteCopyKey } from "@/lib/promote/copy";
import type { PromoteLang } from "@/lib/promote/types";

export type PromoteCopy = (key: PromoteCopyKey, vars?: CopyVars) => string;

export function usePromoteCopy(lang: PromoteLang = "en"): PromoteCopy {
  return useCallback<PromoteCopy>((key, vars) => promoteText(key, vars ?? {}, lang), [lang]);
}
