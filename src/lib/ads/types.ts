export const TEMPLATES = ["lead_generation", "click_to_whatsapp", "traffic", "boost_post"] as const;
export type AdTemplate = (typeof TEMPLATES)[number];

export const SPECIAL_CATEGORIES = ["none", "housing", "employment", "credit", "social_issues"] as const;
export type SpecialAdCategory = (typeof SPECIAL_CATEGORIES)[number];

export type GeoCity = { key: string; name?: string; radiusKm: number };
export type Interest = { id: string; name: string };
export type Gender = "male" | "female";

export const PLACEMENTS = ["facebook_feed", "facebook_stories", "facebook_reels", "instagram_feed", "instagram_stories", "instagram_reels", "messenger_inbox", "audience_network"] as const;
export type Placement = (typeof PLACEMENTS)[number];

export type Targeting = {
  geo: { countries: string[]; cities: GeoCity[] };
  ageMin: number;
  ageMax: number;
  /** Empty means all genders. */
  genders: Gender[];
  interests: Interest[];
  /** Empty means automatic placements. */
  placements: Placement[];
  lookalikeAudienceIds: string[];
};

export type CreativeInput = {
  pageId: string;
  instagramId?: string;
  message: string;
  headline?: string;
  link?: string;
  cta?: string;
  leadFormId?: string;
  whatsappNumberId?: string;
  welcomeMessage?: string;
  postId?: string;
  imageUrl?: string;
  imageHash?: string;
  /** Set by the server when the admin acknowledged housing, employment or credit terms in a campaign declared as category none. */
  categoryTermsAck?: boolean;
};

export const isTemplate = (v: unknown): v is AdTemplate => typeof v === "string" && (TEMPLATES as readonly string[]).includes(v);
export const isCategory = (v: unknown): v is SpecialAdCategory => typeof v === "string" && (SPECIAL_CATEGORIES as readonly string[]).includes(v);
