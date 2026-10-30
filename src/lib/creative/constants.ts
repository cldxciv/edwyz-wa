export const PLACEMENTS = ["feed", "square", "story", "reel"] as const;
export type Placement = (typeof PLACEMENTS)[number];

export const GOALS = ["leads", "messages", "traffic", "awareness"] as const;
export type Goal = (typeof GOALS)[number];

export const SPECIAL_CATEGORIES = ["none", "housing", "employment", "credit", "social_issues"] as const;
export type SpecialCategory = (typeof SPECIAL_CATEGORIES)[number];

export type CopyLimits = { headline: number; primaryText: number; description: number };

/** VERIFY: Meta's recommended (truncation) lengths change over time; confirm against current Ads Manager specs before relying on them. */
export const COPY_LIMITS: Record<Placement, CopyLimits> = {
  feed: { headline: 40, primaryText: 125, description: 30 },
  square: { headline: 40, primaryText: 125, description: 30 },
  story: { headline: 40, primaryText: 72, description: 30 },
  reel: { headline: 40, primaryText: 72, description: 30 },
};

/** VERIFY: pixel sizes per placement. */
export const PLACEMENT_SIZES: Record<Placement, { width: number; height: number }> = {
  feed: { width: 1080, height: 1350 },
  square: { width: 1080, height: 1080 },
  story: { width: 1080, height: 1920 },
  reel: { width: 1080, height: 1920 },
};

export const POLICY_DISCLAIMER =
  "This is an automated helper that looks for common problems. It is not Meta's decision. Meta reviews every ad and its decision is final.";

const CATEGORY_KEYWORDS: [SpecialCategory, RegExp][] = [
  ["housing", /real[\s-]?estate|propert(y|ies)|apartment|housing|mortgage|realt(y|or)|rental|builder|home\s?loan|plots?\b|villa/i],
  ["credit", /\bloans?\b|credit|lending|nbfc|finance|financial services|emi\b/i],
  ["employment", /recruit|staffing|hiring|\bjobs?\b|careers?|employment|placement agency/i],
  ["social_issues", /politic|election|advocacy|campaign for|civic|social cause/i],
];

/** Suggestion only. The user confirms the final category. */
export function suggestSpecialAdCategory(industry: string | null | undefined): SpecialCategory {
  if (!industry) return "none";
  for (const [category, re] of CATEGORY_KEYWORDS) if (re.test(industry)) return category;
  return "none";
}

export const CATEGORY_NOTICES: Record<Exclude<SpecialCategory, "none">, string> = {
  housing: "Housing ads must be declared as a special ad category and have restricted targeting. VERIFY the current rules for your country.",
  employment: "Employment ads must be declared as a special ad category and have restricted targeting. VERIFY the current rules for your country.",
  credit: "Credit and financial product ads must be declared as a special ad category and have restricted targeting. VERIFY the current rules for your country.",
  social_issues: "Ads about social issues, elections or politics need a special ad category declaration and may need advertiser authorisation. VERIFY the current rules.",
};
