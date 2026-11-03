import type { Tone } from "@/components/ui/status";
import { isLegacyTemplate, PLACEMENTS as PLACEMENT_KEYS, type Placement } from "@/lib/ads/types";

export type StatusView = { label: string; tone: Tone };

export function campaignStatusView(status: string): StatusView {
  switch (status) {
    case "draft":
      return { label: "Draft", tone: "neutral" };
    case "launching":
      return { label: "Setting up on Meta", tone: "info" };
    case "paused":
      return { label: "Paused", tone: "warn" };
    case "active":
      return { label: "Active", tone: "good" };
    case "archived":
      return { label: "Archived", tone: "neutral" };
    default:
      return { label: "Needs attention", tone: "bad" };
  }
}

export const TEMPLATE_LABELS: Record<string, { title: string; body: string }> = {
  lead_generation: { title: "Collect leads", body: "People fill in a short form on Facebook or Instagram, and you get their details." },
  click_to_whatsapp: { title: "Start WhatsApp chats", body: "The ad opens a WhatsApp chat with your business number and a welcome message." },
  traffic: { title: "Visit your website", body: "Send people to your website or landing page." },
  boost_post: { title: "Boost a post", body: "Show a post from your Facebook Page to more people." },
};

export const CATEGORY_LABELS: Record<string, string> = {
  none: "None of these apply",
  housing: "Housing: real estate, rentals, home loans",
  employment: "Jobs: hiring, recruitment",
  credit: "Credit: loans, credit cards, financing",
  social_issues: "Social issues, elections or politics",
};

export const CATEGORY_SHORT: Record<string, string> = {
  none: "None",
  housing: "Housing",
  employment: "Jobs",
  credit: "Credit",
  social_issues: "Social issues, elections or politics",
};

export function categoryName(key: string): string {
  return CATEGORY_SHORT[key] ?? key.replace(/_/g, " ");
}

export const CATEGORY_RULES =
  "Meta treats these ads as sensitive. To protect people, it limits who you can aim at: no narrowing by age or gender, no detailed interests and no lookalike audiences, and you target a wider area around a place. We apply these limits for you in the next step.";

/**
 * The old wizard's placement choices: exactly the valid simple keys of docs/IG-PAGE-ADS-SPEC.md 4.5 (a test compares them
 * with promote/catalog/placements.ts). messenger_inbox is not offered: Meta changed Messenger placements (D10).
 */
export const PLACEMENTS: { key: Placement; label: string }[] = [
  { key: "facebook_feed", label: "Facebook feed" },
  { key: "facebook_stories", label: "Facebook stories" },
  { key: "facebook_reels", label: "Facebook reels" },
  { key: "instagram_feed", label: "Instagram feed" },
  { key: "instagram_stories", label: "Instagram stories" },
  { key: "instagram_reels", label: "Instagram reels" },
];

/** A saved messenger_inbox, as the member sees it when the draft reopens (the words of lib/ads/targeting MESSENGER_CHANGED; a test checks). */
export const MESSENGER_PLACEMENT_NOTE = "Pick where your ad shows again: Meta changed Messenger placements";
export const UNKNOWN_PLACEMENT_NOTE = "A place your ad showed in no longer exists, so we removed it. Check where your ad appears.";

const OFFERED: ReadonlySet<string> = new Set(PLACEMENTS.map((p) => p.key));
const isPlacementKey = (v: string) => (PLACEMENT_KEYS as readonly string[]).includes(v);

/**
 * A saved draft's placements as the wizard can show them, so every stored key can be unticked: messenger_inbox (never
 * valid again, D10) and keys Meta no longer has are dropped, each with a note the member sees. Valid keys the wizard
 * doesn't offer are kept, and draftEditProblem stops the wizard from opening such a draft instead.
 */
export function wizardPlacements(stored: unknown): { placements: string[]; notes: string[] } {
  const placements: string[] = [];
  const notes: string[] = [];
  for (const raw of Array.isArray(stored) ? stored : []) {
    if (typeof raw !== "string") continue;
    if (raw !== "messenger_inbox" && isPlacementKey(raw)) {
      if (!placements.includes(raw)) placements.push(raw);
      continue;
    }
    const note = raw === "messenger_inbox" ? MESSENGER_PLACEMENT_NOTE : UNKNOWN_PLACEMENT_NOTE;
    if (!notes.includes(note)) notes.push(note);
  }
  return { placements, notes };
}

/** The reopened draft's notes as one message, with where to fix them. */
export function draftNotesText(notes: readonly string[]): string {
  const sentences = notes.map((n) => (/[.!?]$/.test(n) ? n : `${n}.`));
  return [...sentences, "Change it in step 3, Who should see it, under More targeting options."].join(" ");
}

export const DRAFT_ON_META = "This campaign is already on Meta, so it cannot be edited here. Change its budget or end date on its own page.";
export const DRAFT_NEW_CHOICES =
  "This draft uses choices this page can't show, like a newer goal, a place on the map, postal codes, saved audiences or more places for your ad. Saving it here would lose them, so create it on Meta from its campaign page instead.";

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const someItems = (v: unknown) => Array.isArray(v) && v.length > 0;

/**
 * Why the old wizard can't edit a saved draft without losing or widening what it can't show, or null when it can: a goal
 * other than its four, a pin, a postal code, an audience to include or leave out (lookalikes too), "Let Meta find people",
 * or a valid place it doesn't offer. Its save rebuilds targeting from its own fields, so a draft aimed only at a pin would
 * otherwise be saved as all of India.
 */
export function draftEditProblem(c: { template: string; targeting: unknown }): string | null {
  if (!isLegacyTemplate(c.template)) return DRAFT_NEW_CHOICES;
  const t = isRecord(c.targeting) ? c.targeting : {};
  const geo = isRecord(t.geo) ? t.geo : {};
  if (someItems(geo.customLocations) || someItems(geo.zips)) return DRAFT_NEW_CHOICES;
  if (someItems(t.customAudienceIds) || someItems(t.excludedAudienceIds) || someItems(t.lookalikeAudienceIds) || t.advantageAudience === true) return DRAFT_NEW_CHOICES;
  if (wizardPlacements(t.placements).placements.some((p) => !OFFERED.has(p))) return DRAFT_NEW_CHOICES;
  return null;
}

/** draftEditProblem over every ad set of a campaign. */
export function campaignEditProblem(c: { template: string; adSets: { targeting: unknown }[] }): string | null {
  for (const s of c.adSets.length ? c.adSets : [{ targeting: null }]) {
    const problem = draftEditProblem({ template: c.template, targeting: s.targeting });
    if (problem) return problem;
  }
  return null;
}

/** The note shown when "Edit draft" can't open a campaign in the wizard (campaign-edit.ts draftToForm returned null). */
export function draftBlockedText(c: { status: string; editable?: boolean; template: string; adSets: { targeting: unknown }[] }): string {
  if (c.editable === false || (c.status !== "draft" && c.status !== "error")) return DRAFT_ON_META;
  return campaignEditProblem(c) ?? DRAFT_ON_META;
}

function fractionDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export function formatMinor(minor: number, currency: string): string {
  const digits = fractionDigits(currency);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 10 ** digits);
  } catch {
    return `${(minor / 10 ** digits).toFixed(digits)} ${currency}`;
  }
}

/** Converts what a person typed ("500" or "499.50") to whole minor units, or null when invalid. */
export function toMinor(text: string, currency: string): number | null {
  const value = Number(text.replace(/,/g, "").trim());
  if (!text.trim() || !Number.isFinite(value) || value <= 0) return null;
  const minor = Math.round(value * 10 ** fractionDigits(currency));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

/** Minor units back to the plain number a person would type ("50000" becomes "500"). */
export function minorToText(minor: number, currency: string): string {
  const digits = fractionDigits(currency);
  const value = minor / 10 ** digits;
  return Number.isInteger(value) ? String(value) : value.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

/** True when the text a person typed is exactly the total daily budget they are about to commit to. */
export function typedTotalMatches(text: string, totalMinor: number, currency: string): boolean {
  const typed = toMinor(text, currency.length === 3 ? currency : "INR");
  return typed !== null && typed === totalMinor;
}

export function parseInterests(text: string): { id: string; name: string }[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, ...rest] = line.split(",");
      return { id: id.trim(), name: rest.join(",").trim() || id.trim() };
    });
}

/** Splits "IN, ae" into valid upper-case codes and the entries that are not two letters. */
export function parseCountries(text: string): { codes: string[]; invalid: string[] } {
  const parts = text.split(/[,\s]+/).map((c) => c.trim()).filter(Boolean);
  const codes: string[] = [];
  const invalid: string[] = [];
  for (const part of parts) {
    if (/^[A-Za-z]{2}$/.test(part)) {
      const code = part.toUpperCase();
      if (!codes.includes(code)) codes.push(code);
    } else invalid.push(part);
  }
  return { codes, invalid };
}

export type BudgetCheck = { state: "empty" | "invalid" | "over" | "ok"; message: string | null };

/** Plain-language verdict on the daily budget a person typed, against the workspace limit. */
export function checkBudget(text: string, currency: string, capMinor: number | null): BudgetCheck {
  if (!text.trim()) return { state: "empty", message: null };
  const minor = toMinor(text, currency);
  if (minor === null) return { state: "invalid", message: "Enter an amount above zero, like 500 or 499.50." };
  if (capMinor !== null && minor > capMinor) return { state: "over", message: `This is more than your daily limit of ${formatMinor(capMinor, currency)}. Lower the amount.` };
  return { state: "ok", message: null };
}

/** Share of the workspace limit this campaign would use, 0 to 100, or null when no limit is set. */
export function capUsagePercent(budgetMinor: number | null, capMinor: number | null): number | null {
  if (budgetMinor === null || capMinor === null || capMinor <= 0) return null;
  return Math.min(100, Math.round((budgetMinor / capMinor) * 100));
}

/** Total daily budget already committed by campaigns that are active now, in one currency. */
export function activeBudgetElsewhere(campaigns: { status: string; currency: string; totalDailyBudgetMinor: number }[], currency: string): number {
  return campaigns.filter((c) => c.status === "active" && c.currency === currency).reduce((sum, c) => sum + c.totalDailyBudgetMinor, 0);
}

/** What is left of the workspace limit once other active campaigns are counted, and whether this budget fits in it. */
export function budgetRoom(budgetMinor: number | null, capMinor: number | null, usedMinor: number | null): { leftMinor: number; fits: boolean } | null {
  if (capMinor === null || usedMinor === null) return null;
  const leftMinor = Math.max(0, capMinor - usedMinor);
  return { leftMinor, fits: budgetMinor === null || budgetMinor <= leftMinor };
}

const TERMS_MISMATCH = /suggest the .* special ad category, but you declared none/i;

/** The server noticed housing, jobs or credit wording in an ad that was declared as having no special category. */
export function isCategoryTermsMismatch(message: string): boolean {
  return TERMS_MISMATCH.test(message);
}

const META_LOGIN = /oauth|access token|session has (been invalidated|expired)|error validating access token|\(#190\)/i;

/** Meta refused the saved Facebook login (expired, revoked or unreadable token). Trying again fails the same way; reconnecting fixes it. */
export function isMetaLoginProblem(message: string | null | undefined): boolean {
  return META_LOGIN.test(message ?? "");
}

export const META_LOGIN_FIX = "Meta no longer accepts the saved Facebook login. Reconnect under Meta connections and try again.";

/**
 * The server's 404 answer for a record ("Campaign not found.", "Brief not found."): it was deleted, belongs to another
 * workspace, or the link is wrong. Trying again cannot help, so pages show a not-found state with a way back instead.
 */
export function isNotFoundError(message: string | null | undefined): boolean {
  return /\bnot found\.?$/i.test((message ?? "").trim());
}

/** Rewrites the few server messages that mention internal field names or units into words a shop owner can act on. */
export function friendlyAdsError(message: string | null | undefined): string {
  const text = (message ?? "").trim();
  if (!text) return "Something went wrong. Please try again.";
  if (isMetaLoginProblem(text)) return META_LOGIN_FIX;
  if (TERMS_MISMATCH.test(text)) {
    const kind = /suggest the (.*?) special ad category/i.exec(text)?.[1] ?? "sensitive";
    return `Your ad wording looks like it is about ${kind}. Choose the matching special category, or confirm that it does not apply.`;
  }
  if (/dailyBudgetMinor|minor units/i.test(text) && /positive whole number/i.test(text)) return "Enter a daily budget above zero.";
  if (/No daily budget cap is set/i.test(text)) return "No daily spending limit is set yet. An owner needs to set one on the Ad campaigns page first.";
  if (/endsAt must be after startsAt/i.test(text)) return "The end date must be after the start date.";
  if (/Provide 1 to 10 ads/i.test(text)) return "Add at least one ad.";
  if (/Add an image \(imageUrl or imageHash\)/i.test(text)) return "Add a picture link for your ad.";
  if (/Set confirm to true/i.test(text)) return "Please confirm the daily budget to start spending.";
  if (/confirm that exact amount/i.test(text)) return "The amount you confirmed does not match the campaign's total daily budget. Reload the page and try again.";
  if (/adAccountAssetId is required/i.test(text)) return "Choose an ad account.";
  const workspaceCap = /workspace daily budget cap is (.+?)\. Active campaigns already use (.+?), so this campaign \((.+?)\) would exceed the cap/i.exec(text);
  if (workspaceCap) return `Your daily limit is ${workspaceCap[1]} across all campaigns. Your other active campaigns already use ${workspaceCap[2]}, so this campaign's ${workspaceCap[3]} does not fit. Lower its budget, pause another campaign, or ask an owner to raise the limit.`;
  const singleCap = /daily budget (.+?) exceeds the cap of (.+?)\.?\s*$/i.exec(text);
  if (singleCap) return `This campaign's daily budget of ${singleCap[1]} is more than your daily limit of ${singleCap[2]}. Lower the budget, or ask an owner to raise the limit.`;
  const currencies = /budget cap is set in (\w+) but this campaign uses (\w+)/i.exec(text);
  if (currencies) return `Your daily limit is set in ${currencies[1]}, but this campaign uses ${currencies[2]}. Ask an owner to set the limit in ${currencies[2]}.`;
  if (/budget cap has no currency/i.test(text)) return "Your daily limit needs a currency. Ask an owner to save it again on the Ad campaigns page.";
  return text;
}

export function campaignNotice(status: string): { tone: Tone; title: string; body: string } | null {
  switch (status) {
    case "draft":
      return { tone: "neutral", title: "Saved here, not on Meta yet", body: "Create it on Meta when you are ready. It is created paused, so nothing is spent." };
    case "launching":
      return { tone: "info", title: "Setting up on Meta", body: "This page refreshes by itself. It usually takes under a minute." };
    case "paused":
      return { tone: "warn", title: "Paused, nothing is being spent", body: "Activate the campaign when you are ready for it to start showing." };
    case "active":
      return { tone: "good", title: "Running", body: "This campaign is showing now and spending daily, up to its daily budget." };
    case "archived":
      return { tone: "neutral", title: "Archived", body: "This campaign has stopped and cannot be restarted. Create a new one to run these ads again." };
    default:
      return null;
  }
}

export type PickedCreative = { id: string; headline: string | null; body: string | null; hasImage?: boolean };
export type SharedAdFields = { pageId: string; instagramId: string; link: string; imageUrl: string; leadFormId: string; whatsappNumberId: string; welcomeMessage: string; postId: string };

/** The launcher accepts 1 to 10 ads per ad set. */
export const MAX_ADS = 10;

export const variantLetter = (i: number) => String.fromCharCode(65 + (i % 26));

/**
 * The ads for the draft. No chosen creative: one ad from the typed text. One chosen: one ad, text as typed (it was prefilled from the
 * creative). Two or more: one ad per creative in the same ad set, and a creative's own text and headline win over the shared fields,
 * which only fill in for creatives that have none (the server takes the creative's text when the ad sends an empty one).
 */
export function buildAdList(input: { campaignName: string; picked: PickedCreative[]; shared: SharedAdFields; message: string; headline: string }) {
  const { campaignName, picked, shared, message, headline } = input;
  if (picked.length === 0) return [{ name: `${campaignName} ad`, creativeAssetId: null as string | null, creative: { ...shared, message, headline } }];
  const test = picked.length > 1;
  return picked.slice(0, MAX_ADS).map((a, i) => ({
    name: test ? `${campaignName} - ad ${variantLetter(i)}` : `${campaignName} ad`,
    creativeAssetId: a.id as string | null,
    creative: { ...shared, message: test && a.body ? "" : message, headline: test && a.headline ? "" : headline },
  }));
}

const PICTURE_LINK = /^https:\/\/\S+$/;

/** The picture link is a web address on https, unless every chosen saved creative already brings its own picture. */
export function pictureCovered(picked: PickedCreative[]): boolean {
  return picked.length > 0 && picked.every((a) => a.hasImage);
}

export function pictureLinkError(imageUrl: string): string | null {
  const v = imageUrl.trim();
  return v && !PICTURE_LINK.test(v) ? "Use a web address that starts with https://." : null;
}

export function pictureReady(imageUrl: string, picked: PickedCreative[]): boolean {
  return pictureCovered(picked) || PICTURE_LINK.test(imageUrl.trim());
}

/** Ready to continue: the typed text, or every chosen creative brings its own. */
export function adTextReady(message: string, picked: PickedCreative[]): boolean {
  return !!message.trim() || (picked.length > 1 && picked.every((a) => !!a.body));
}
