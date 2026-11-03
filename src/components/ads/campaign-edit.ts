/*
 * Pure helpers for changing a campaign that is already on Meta (budget and end date) and for editing a draft in the
 * wizard. Client-safe: no server imports.
 */
import { campaignEditProblem, wizardPlacements } from "./helpers";

/** A Date as the value of an <input type="datetime-local"> in this browser's time zone. */
export function toDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export type ChangeKind = "raise" | "cut" | "same";

/** A higher daily budget is a raise (checked against the limits); a lower one is a cut (always goes ahead). */
export function budgetChangeKind(currentMinor: number, nextMinor: number): ChangeKind {
  return nextMinor > currentMinor ? "raise" : nextMinor < currentMinor ? "cut" : "same";
}

export type EndKind = "later" | "earlier" | "same";

/** A later end extends spending (checked against the limits); an earlier end, or a first end date, always goes ahead. */
export function endChangeKind(current: Date | null, next: Date): EndKind {
  if (current && current.getTime() === next.getTime()) return "same";
  return current !== null && next.getTime() > current.getTime() ? "later" : "earlier";
}

/** What is wrong with the new end date a person typed, or null. The server checks the same rules. */
export function endProblem(text: string, now: Date, startsAt: Date | null): string | null {
  if (!text.trim()) return "Choose the new end date.";
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return "Choose a date and time.";
  if (d.getTime() < now.getTime() + 3_600_000) return "Choose an end at least an hour from now.";
  if (startsAt && d.getTime() <= startsAt.getTime()) return "The end must be after the start.";
  return null;
}

type DraftAd = { creativeAssetId: string | null; creative: Record<string, unknown> | null };
type DraftCampaign = {
  id: string;
  name: string;
  template: string;
  status: string;
  adAccountAssetId: string;
  currency: string;
  dailyBudgetMinor: number;
  startsAt: string | null;
  endsAt: string | null;
  specialAdCategory: string;
  editable?: boolean;
  adSets: { targeting: unknown; dailyBudgetMinor: number | null; ads: DraftAd[] }[];
};

/** The wizard's answers rebuilt from a saved draft, so "Edit draft" opens the wizard where the person left it. */
export type DraftForm = {
  template: string;
  name: string;
  accountId: string;
  budgetMinor: number;
  startsAt: string;
  endsAt: string;
  noEnd: boolean;
  category: string;
  countries: string;
  cities: { key: string; name: string; radiusKm: number }[];
  ageMin: string;
  ageMax: string;
  gender: string;
  interests: { id: string; name: string }[];
  placements: string[];
  creativeIds: string[];
  pageId: string;
  instagramId: string;
  message: string;
  headline: string;
  link: string;
  imageUrl: string;
  mediaKey: string;
  leadFormId: string;
  whatsappNumberId: string;
  welcomeMessage: string;
  postId: string;
  instagramMediaId: string;
  /** What changed while reopening (a dropped Messenger placement), for the member to see. */
  notes: string[];
};

const s =(v: unknown) => (typeof v === "string" ? v : "");
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Null when the campaign is not an editable draft, or holds choices the wizard can't show (helpers.ts draftEditProblem;
 * helpers.ts draftBlockedText says which). A signed picture link from the library is not kept: the key is.
 */
export function draftToForm(c: DraftCampaign): DraftForm | null {
  if (c.editable === false || (c.status !== "draft" && c.status !== "error")) return null;
  if (campaignEditProblem(c)) return null;
  const set = c.adSets[0];
  const t = isObj(set?.targeting) ? set!.targeting : {};
  const geo = isObj(t.geo) ? t.geo : {};
  const ads = set?.ads ?? [];
  const first = isObj(ads[0]?.creative) ? (ads[0]!.creative as Record<string, unknown>) : {};
  const genders = Array.isArray(t.genders) ? t.genders.filter((g): g is string => typeof g === "string") : [];
  const mediaKey = s(first.mediaKey);
  const abTest = ads.length > 1;
  // Only keys the wizard can untick: a stored messenger_inbox is dropped with a note instead of failing every launch.
  const placed = wizardPlacements(t.placements);
  return {
    template: c.template,
    name: c.name,
    accountId: c.adAccountAssetId,
    budgetMinor: set?.dailyBudgetMinor ?? c.dailyBudgetMinor,
    startsAt: c.startsAt ? toDateTimeLocal(new Date(c.startsAt)) : "",
    endsAt: c.endsAt ? toDateTimeLocal(new Date(c.endsAt)) : "",
    noEnd: !c.endsAt,
    category: c.specialAdCategory,
    countries: Array.isArray(geo.countries) ? geo.countries.filter((x): x is string => typeof x === "string").join(", ") : "",
    cities: Array.isArray(geo.cities) ? geo.cities.filter(isObj).map((x) => ({ key: s(x.key), name: s(x.name) || s(x.key), radiusKm: Number(x.radiusKm) || 25 })).filter((x) => x.key) : [],
    ageMin: String(typeof t.ageMin === "number" ? t.ageMin : 18),
    ageMax: String(typeof t.ageMax === "number" ? t.ageMax : 65),
    gender: genders.length === 1 ? genders[0] : "all",
    interests: Array.isArray(t.interests) ? t.interests.filter(isObj).map((i) => ({ id: s(i.id), name: s(i.name) || s(i.id) })).filter((i) => i.id) : [],
    placements: placed.placements,
    creativeIds: ads.map((a) => a.creativeAssetId).filter((v): v is string => !!v),
    pageId: s(first.pageId),
    instagramId: s(first.instagramId),
    // In an A/B test each creative brings its own text: the shared fields were sent empty for those.
    message: abTest ? "" : s(first.message),
    headline: abTest ? "" : s(first.headline),
    link: s(first.link),
    // A saved creative's own picture link is signed again at launch, so it is not shown as a typed link.
    imageUrl: mediaKey || s(first.imageUrl).includes("/api/creative/public/") ? "" : s(first.imageUrl),
    mediaKey,
    leadFormId: s(first.leadFormId),
    whatsappNumberId: s(first.whatsappNumberId),
    welcomeMessage: s(first.welcomeMessage),
    postId: s(first.postId),
    instagramMediaId: s(first.instagramMediaId),
    notes: placed.notes,
  };
}
