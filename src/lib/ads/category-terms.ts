import type { SpecialAdCategory } from "./types";

type Detectable = Exclude<SpecialAdCategory, "none" | "social_issues">;

/*
 * VERIFY against Meta's current Special Ad Categories policy. These are deliberately broad keyword lists, English plus the common
 * Indian real-estate and credit phrasing (BHK, plots, villas, payday, pre-approved, CIBIL): a false positive costs one acknowledgement,
 * a miss costs a rejected or penalised ad account. Other languages are not covered; the brand industry and the declared category are the backstop.
 */
const COPY_TERMS: Record<Detectable, RegExp> = {
  housing:
    /\b(?:mortgages?|real[\s-]?estate|realtors?|realty|homes? for (?:sale|rent)|house for (?:sale|rent)|apartments?|flats?|villas?|plots?|penthouses?|townships?|gated communit(?:y|ies)|housing society|builders?|home ?buyers?|condos?|condominiums?|rentals?|for rent|to[\s-]?let|rent(?:ing)? (?:a |an |your )?(?:flat|house|home|room|apartment|pg)|pg accommodation|landlords?|home ?loans?|housing|propert(?:y|ies)|new ?builds?|open house|\d+\s*-?\s*bhk|bhk|sq\.?\s?ft|sqft|square feet|down ?payment)\b/i,
  employment:
    /\b(?:jobs?|hiring|we(?:'|’)re hiring|we are hiring|vacanc(?:y|ies)|careers?|recruit(?:ing|ment|er|ers)?|job openings?|staffing|employment|apply for (?:a |the )?(?:job|position|role)|work from home|earn from home|internships?|freshers?|walk[\s-]?in (?:interview|drive)|placement (?:drive|assistance|support)|part[\s-]?time (?:jobs?|work|roles?)|full[\s-]?time (?:jobs?|roles?)|salary|naukri)\b/i,
  credit:
    /\b(?:loans?|credit|credit cards?|credit score|credit limit|cibil|lending|lenders?|mortgages?|financing|instal?lments?|emi|no[\s-]?cost emi|buy now,? pay later|bnpl|payday|pre[\s-]?approved|instant (?:cash|approval|credit)|cash advance|borrow(?:ing|ers?)?|debt consolidation|line of credit|overdraft|interest rates?|gold loans?)\b/i,
};

const INDUSTRY_TERMS: Record<Detectable, RegExp> = {
  housing: /\b(real[\s-]?estate|propert(?:y|ies)|housing|realty|rental|mortgage|builders?)\b/i,
  employment: /\b(recruit(?:ing|ment|er|ers)?|staffing|manpower|human resources|hr services|employment|talent|job|placement)\b/i,
  credit: /\b(bank(?:ing)?|lending|loans?|credit|financ(?:e|ial)|nbfc|fintech|mortgage|microfinance)\b/i,
};

/** Words of a URL (path, query, file name) as plain text so "/home-loan-offer.html" reads like copy. */
export function urlWords(url: string | undefined | null): string {
  if (typeof url !== "string" || !url) return "";
  let text = url;
  try {
    text = decodeURIComponent(url);
  } catch {
    // keep the raw string
  }
  return text.replace(/^[a-z]+:\/\//i, "").replace(/[^a-z0-9]+/gi, " ").trim();
}

export type CategoryHit = { category: Detectable; source: "copy" | "industry" };

/** Which special ad categories the text or brand industry suggests. Empty means nothing was detected. */
export function detectSpecialCategoryTerms(copy: (string | undefined | null)[], industry?: string | null): CategoryHit[] {
  const text = copy.filter((s): s is string => typeof s === "string" && s.length > 0).join(" \n ");
  const hits: CategoryHit[] = [];
  for (const category of Object.keys(COPY_TERMS) as Detectable[]) {
    if (text && COPY_TERMS[category].test(text)) hits.push({ category, source: "copy" });
    else if (industry && INDUSTRY_TERMS[category].test(industry)) hits.push({ category, source: "industry" });
  }
  return hits;
}

export function describeHits(hits: CategoryHit[]): string {
  return [...new Set(hits.map((h) => h.category))].join(", ");
}
