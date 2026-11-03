/**
 * Smart defaults of a new promotion (docs/IG-PAGE-ADS-SPEC.md 3.1, 3.1a, D3, D6, D8, D9, D11, D31; PRM-09).
 *
 * Every screen arrives pre-filled. smartDefaults() is pure (facts in, defaults out) and fills the 3.1 table:
 *
 * | Setting | Default |
 * |---|---|
 * | Ad account | The Phase 0 spending account (SpendControl.spendingAdAccountAssetId). None: owners get "Choose a spending ad account", admins "Ask {owner} to choose a spending ad account" |
 * | Page and Instagram account | The only one, else the last used, else ask |
 * | Goal | From the request; else whatsapp_chats when the WhatsApp number is linked to the Page; else lead_form when the workspace has forms; else website_visits when the post has a link; else engagement |
 * | Placements | Automatic, or "Instagram only" / "Facebook only" when the request names one app |
 * | Audience | "Let Meta find people": advantage audience, the workspace country, 18+; "near my shop" uses the stored shop (5 km in a city, 15 km elsewhere) |
 * | Budget per day | min(₹300 or its Phase 0 FX equivalent, maxFittingDaily), rounded down to the step, never below the account minimum |
 * | Days | From the request, else 7; at least 2 (D31), with the chip "Meta needs at least 2 days. Run for 2 days?" |
 * | Start | Now |
 * | Name | Automatic, for example "Boost · Reel 'Diwali offer…' · 28 Oct" |
 * | Special ad category | From the brand kit |
 * | Enhancements | All OPT_OUT (enhancementsOptIn false) |
 * | Call to action, welcome | By goal (4.3); the localized first message, quick-question presets as chips |
 *
 * loadDefaultFacts() reads the facts: the spending account and its currency, zone and Meta minimum, the Page and Instagram
 * accounts, the last promotion's identity, the WhatsApp number, forms, the brand kit, Promote settings, Phase 0's headroom and
 * the FX table. Each read that fails reads as "not known", so a default is never blocked by an optional fact.
 */
import type { Role } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { adsHeadroomDetail } from "@/lib/spend/book";
import { convertFromInr, readFx } from "@/lib/spend/fx";
import type { Actor } from "@/lib/tenancy";
import { CTA_BY_GOAL } from "./catalog/cta";
import { goalRow } from "./catalog/goals";
import { formatDay, formatMoney, promoteText } from "./copy";
import { budgetStep, defaultDailyMinor, majorUnit, maxFittingDaily, type FromInr } from "./cost";
import { DEFAULT_RUN_DAYS, MAX_RUN_DAYS, MIN_RUN_DAYS, runDates } from "./dates";
import { shopLocation } from "./geo";
import { getPromoteSettings } from "./settings";
import { isGoalKey, type GoalKey, type IceBreaker, type PlacementMode, type PromoteLang, type ShopLocation, type SourceKind } from "./types";
import { isCategory, type SpecialAdCategory } from "@/lib/ads/types";

// =====================================================================================================================
// Shapes
// =====================================================================================================================

export type DefaultAsset = { assetId: string; externalId: string; name: string | null };
export type DefaultPage = DefaultAsset & { whatsappLinked: boolean };
export type DefaultInstagram = DefaultAsset & { pageId: string | null };

export type DefaultFacts = {
  role: Role;
  /** The owner's name, for "Ask {owner} …". */
  ownerName: string | null;
  /** The Phase 0 spending account, with what Meta reported for it. Null when the owner has not chosen one. */
  spendingAccount: { assetId: string; externalId: string; currency: string; timezone: string; minDailyMinor: bigint | null } | null;
  pages: DefaultPage[];
  instagram: DefaultInstagram[];
  /** The Page and Instagram account of this workspace's last promotion. */
  lastUsed: { pageExternalId: string | null; instagramExternalId: string | null };
  /** The connected WhatsApp number (PhoneNumber row id), if any. */
  whatsappNumberId: string | null;
  /** The workspace has lead forms it can use. */
  hasForms: boolean;
  /** The workspace country (ISO 3166 alpha-2). */
  country: string;
  /** The stored shop (Promote settings), for "near my shop". */
  shop: { lat: number | null; lng: number | null; label: string | null; pincode: string | null } | null;
  /** The welcome message saved in Promote settings, per language. */
  welcome: Partial<Record<PromoteLang, string | null>>;
  /** The brand kit's special ad category (D9). */
  brandCategory: SpecialAdCategory;
  /** Phase 0 headroom before this run (null today: no daily limit, so nothing is known to fit). */
  headroom: { leftTodayMinor: bigint | null; leftMonthMinor: bigint | null } | null;
  /** Phase 0's convertFromInr with a fresh rate, or null without one (3.1a). */
  fromInr: FromInr | null;
  /**
   * The goals this member is offered: PROMOTE_GOALS and the D22 verify states, the catalog route's filter (service.offeredGoals).
   * Default: every goal. The default goal is always one of these when any is offered.
   */
  allowedGoals?: readonly GoalKey[];
  now: Date;
};

export type DefaultRequest = {
  /** The goal the member asked for (Eddy: from the sentence). */
  goal?: GoalKey | null;
  /** Days the member asked for. */
  days?: number | null;
  /** "on Instagram" or "on Facebook" in the sentence. */
  placements?: "auto" | "instagram" | "facebook" | null;
  /** "near my shop". */
  nearShop?: boolean;
  /** What is promoted: a new ad, or a post (with its first caption line and whether it has a link, for the name and goal). */
  source?: { kind: SourceKind; ref?: string | null; caption?: string | null; postKind?: "reel" | "post" | "story" | "video" | null; hasLink?: boolean } | null;
  /** The Page or Instagram account the member chose. */
  pageAssetId?: string | null;
  igAssetId?: string | null;
  lang?: PromoteLang;
};

export type DefaultChipKey =
  | "choose_spending_account"
  | "ask_owner_spending_account"
  | "choose_page"
  | "connect_page"
  | "choose_instagram"
  | "min_days"
  | "max_days"
  | "add_shop"
  | "type_amount";
export type DefaultChip = { key: DefaultChipKey; text: string; href?: string };

export type SmartDefaults = {
  adAccount: { assetId: string; externalId: string; currency: string; timezone: string } | null;
  page: DefaultPage | null;
  instagram: DefaultInstagram | null;
  goal: GoalKey;
  placementMode: Extract<PlacementMode, "auto" | "instagram" | "facebook">;
  audience: { mode: "meta_finds" | "near_shop"; countries: string[]; ageMin: number; advantageAudience: boolean; nearShop: ShopLocation | null };
  /** The default daily budget in the account currency, and the stepper step. dailyMinor is a placeholder of one unit when nothing is known (chip type_amount). */
  budget: { dailyMinor: bigint; stepMinor: bigint; known: boolean };
  run: { runDays: number; startMode: "now" };
  name: string;
  specialAdCategory: SpecialAdCategory;
  enhancementsOptIn: false;
  /** null: the goal's own call to action (4.3). */
  ctaType: string | null;
  welcome: { message: string; iceBreakers: IceBreaker[] };
  /** Quick questions offered as chips (3.6); none is added by default. */
  quickQuestionPresets: string[];
  whatsappNumberId: string | null;
  chips: DefaultChip[];
};

/** Where the owner chooses the spending account and the limits (Settings > Spending limits). */
export const SPENDING_LIMITS_PATH = "/app/settings/spending";
/** The workspace country when nothing says otherwise. */
export const DEFAULT_COUNTRY = "IN";
/** The youngest age a promotion targets (3.1, D9). */
export const DEFAULT_AGE_MIN = 18;

const DEFAULT_COPY = {
  choosePage: "Choose the Facebook Page your ad runs from.",
  connectPage: "Connect a Facebook Page first. Ads run from a Page.",
  chooseInstagram: "Choose the Instagram account your ad shows from, or run it on Facebook only.",
  maxDays: `Ads can run for at most ${MAX_RUN_DAYS} days, so this runs for ${MAX_RUN_DAYS}.`,
  addShop: "Add your shop on the map in Promote settings to reach people near it.",
  boost: "Boost",
} as const;

// =====================================================================================================================
// Pure rules
// =====================================================================================================================

/** The account, or the owner's and admin's chips when there is none (D3, 3.1). */
export function spendingAccountChip(role: Role, ownerName: string | null, lang: PromoteLang = "en"): DefaultChip {
  if (role === "owner") return { key: "choose_spending_account", text: promoteText("readiness.choose_account", {}, lang), href: SPENDING_LIMITS_PATH };
  return { key: "ask_owner_spending_account", text: promoteText("readiness.ask_owner_account", { owner: ownerName?.trim() || "the owner" }, lang) };
}

/** The only one, else the last used, else the one the member named; null asks. */
function pick<T extends DefaultAsset>(list: readonly T[], chosenAssetId: string | null | undefined, lastExternalId: string | null): T | null {
  if (chosenAssetId) return list.find((a) => a.assetId === chosenAssetId) ?? null;
  if (list.length === 1) return list[0];
  if (lastExternalId) return list.find((a) => a.externalId === lastExternalId) ?? null;
  return null;
}

/** The goal: as asked, else the first of whatsapp_chats, lead_form, website_visits, engagement that applies and is offered. */
export function defaultGoal(i: { asked?: GoalKey | null; whatsappLinked: boolean; hasForms: boolean; postHasLink: boolean; allowed?: readonly GoalKey[] }): GoalKey {
  const allowed = new Set<GoalKey>(i.allowed ?? []);
  const ok = (g: GoalKey) => !i.allowed || allowed.has(g);
  if (i.asked && isGoalKey(i.asked) && ok(i.asked)) return i.asked;
  if (i.whatsappLinked && ok("whatsapp_chats")) return "whatsapp_chats";
  if (i.hasForms && ok("lead_form")) return "lead_form";
  if (i.postHasLink && ok("website_visits")) return "website_visits";
  if (ok("engagement")) return "engagement";
  return i.allowed?.[0] ?? "engagement";
}

/** Days: as asked, else 7; at least 2 (D31) and at most 90 (D6), each correction with its chip. */
export function defaultRunDays(asked: number | null | undefined, lang: PromoteLang = "en"): { runDays: number; chip: DefaultChip | null } {
  if (asked === null || asked === undefined || !Number.isFinite(asked)) return { runDays: DEFAULT_RUN_DAYS, chip: null };
  const days = Math.floor(asked);
  if (days < MIN_RUN_DAYS) return { runDays: MIN_RUN_DAYS, chip: { key: "min_days", text: promoteText("fix.min_days_chip", {}, lang) } };
  if (days > MAX_RUN_DAYS) return { runDays: MAX_RUN_DAYS, chip: { key: "max_days", text: DEFAULT_COPY.maxDays } };
  return { runDays: days, chip: null };
}

export type DefaultBudgetInput = {
  currency: string;
  fromInr: FromInr | null;
  minDailyMinor: bigint | null;
  headroom: DefaultFacts["headroom"];
  runDays: number;
  tz: string;
  now: Date;
};

/**
 * The default daily budget (D8, 3.1a): min(₹300 or its FX equivalent, the largest amount that fits today and this month for
 * this run), rounded down to the step, never below Meta's minimum for the account. With no fresh FX rate and no known
 * minimum, one major unit as a placeholder and known false (the chip asks the member to type an amount).
 */
export function defaultBudget(i: DefaultBudgetInput): { dailyMinor: bigint; stepMinor: bigint; known: boolean } {
  const stepMinor = budgetStep(i.currency, i.fromInr);
  let maxFitting: bigint | null = null;
  if (i.headroom && i.headroom.leftTodayMinor !== null) {
    const dates = runDates({ runDays: i.runDays, startMode: "now", tz: i.tz, now: i.now });
    maxFitting = maxFittingDaily({
      startsAt: dates.startsAt,
      endsAt: dates.endsAt,
      tz: i.tz,
      now: i.now,
      leftTodayMinor: i.headroom.leftTodayMinor,
      leftMonthMinor: i.headroom.leftMonthMinor,
      stepMinor,
      currency: i.currency,
    });
  }
  const d = defaultDailyMinor({ currency: i.currency, fromInr: i.fromInr, maxFittingMinor: maxFitting, minDailyMinor: i.minDailyMinor });
  if (d === null) return { dailyMinor: majorUnit(i.currency), stepMinor, known: false };
  // Rounded down to the step in every currency (INR is already a multiple of ₹10), never below Meta's minimum.
  let out = d >= stepMinor ? (d / stepMinor) * stepMinor : d;
  if (i.minDailyMinor && out < i.minDailyMinor) out = i.minDailyMinor;
  return { dailyMinor: out, stepMinor, known: true };
}

/** Clipped to n characters at a word boundary when one is near, with an ellipsis. */
function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  const head = s.slice(0, n);
  const space = head.lastIndexOf(" ");
  return `${(space > n / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** The automatic name (3.1): "Boost · Reel 'Diwali offer…' · 28 Oct", or "Get WhatsApp chats · 28 Oct". */
export function defaultName(i: { goal: GoalKey; source?: DefaultRequest["source"]; now: Date; tz: string; lang?: PromoteLang }): string {
  const lang = i.lang ?? "en";
  const day = formatDay(i.now, i.tz, lang);
  const src = i.source;
  if (src && src.kind !== "new") {
    const kind = src.postKind ?? (src.kind === "ig_media" ? "post" : "post");
    const label = promoteText(`kind.${kind}` as "kind.post", {}, lang);
    const kindLabel = label.charAt(0).toUpperCase() + label.slice(1);
    const caption = (src.caption ?? "").replace(/\s+/g, " ").trim();
    const quoted = caption ? ` '${clip(caption, 20)}'` : "";
    return clip(`${DEFAULT_COPY.boost} · ${kindLabel}${quoted} · ${day}`, 120);
  }
  return clip(`${promoteText(goalRow(i.goal).copy.title, {}, lang)} · ${day}`, 120);
}

const QUICK_QUESTION_KEYS = ["chat.qq.price", "chat.qq.delivery", "chat.qq.timings"] as const;

/** Every default of 3.1 for one request. Pure. */
export function smartDefaults(facts: DefaultFacts, req: DefaultRequest = {}): SmartDefaults {
  const lang = req.lang ?? "en";
  const chips: DefaultChip[] = [];
  const account = facts.spendingAccount;
  if (!account) chips.push(spendingAccountChip(facts.role, facts.ownerName, lang));

  const page = pick(facts.pages, req.pageAssetId, facts.lastUsed.pageExternalId);
  if (!page) chips.push(facts.pages.length ? { key: "choose_page", text: DEFAULT_COPY.choosePage } : { key: "connect_page", text: DEFAULT_COPY.connectPage });
  let instagram = pick(facts.instagram, req.igAssetId, facts.lastUsed.instagramExternalId);
  if (!instagram && page && !req.igAssetId) {
    const onPage = facts.instagram.filter((i) => i.pageId === page.externalId);
    if (onPage.length === 1) instagram = onPage[0];
  }
  if (!instagram && facts.instagram.length > 1) chips.push({ key: "choose_instagram", text: DEFAULT_COPY.chooseInstagram });

  const postHasLink = req.source?.hasLink === true || /https?:\/\/\S/i.test(req.source?.caption ?? "");
  const goal = defaultGoal({ asked: req.goal ?? null, whatsappLinked: !!page?.whatsappLinked && !!facts.whatsappNumberId, hasForms: facts.hasForms, postHasLink, allowed: facts.allowedGoals });

  const days = defaultRunDays(req.days, lang);
  if (days.chip) chips.push(days.chip);

  const tz = account?.timezone ?? "Asia/Kolkata";
  const currency = account?.currency ?? "INR";
  const budget = defaultBudget({ currency, fromInr: facts.fromInr, minDailyMinor: account?.minDailyMinor ?? null, headroom: facts.headroom, runDays: days.runDays, tz, now: facts.now });
  if (!budget.known) chips.push({ key: "type_amount", text: promoteText("budget.type_amount", { example: formatMoney(budgetStep(currency, facts.fromInr) * 30n, currency) }, lang) });

  const category = facts.brandCategory;
  // Special categories never use Meta's audience expansion (D9): the flag goes out as 0 with restrictForCategory.
  const advantage = category === "none";
  let nearShop: ShopLocation | null = null;
  if (req.nearShop) {
    nearShop = shopLocation(facts.shop);
    if (!nearShop) chips.push({ key: "add_shop", text: DEFAULT_COPY.addShop });
  }

  const placementMode = req.placements === "instagram" || req.placements === "facebook" ? req.placements : "auto";
  const chat = CTA_BY_GOAL[goal].welcomeMessage;
  const message = chat ? facts.welcome[lang]?.trim() || facts.welcome.en?.trim() || promoteText("chat.first_message_default", {}, lang) : "";

  return {
    adAccount: account ? { assetId: account.assetId, externalId: account.externalId, currency: account.currency, timezone: account.timezone } : null,
    page,
    instagram,
    goal,
    placementMode,
    audience: {
      mode: nearShop ? "near_shop" : "meta_finds",
      countries: [facts.country || DEFAULT_COUNTRY],
      ageMin: DEFAULT_AGE_MIN,
      advantageAudience: advantage && !nearShop,
      nearShop,
    },
    budget,
    run: { runDays: days.runDays, startMode: "now" },
    name: defaultName({ goal, source: req.source, now: facts.now, tz, lang }),
    specialAdCategory: category,
    enhancementsOptIn: false,
    ctaType: null,
    welcome: { message, iceBreakers: [] },
    quickQuestionPresets: chat ? QUICK_QUESTION_KEYS.map((k) => promoteText(k, {}, lang)) : [],
    whatsappNumberId: goalRow(goal).needsWhatsApp ? facts.whatsappNumberId : null,
    chips,
  };
}

// =====================================================================================================================
// Facts from the database
// =====================================================================================================================

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const digits = (v: unknown): string => (typeof v === "string" ? v.replace(/\D/g, "") : "");

/** Calling codes of the countries Edwyz serves first; anything else reads as India (the product default). */
const CALLING_CODES: readonly [string, string][] = [
  ["971", "AE"],
  ["966", "SA"],
  ["974", "QA"],
  ["965", "KW"],
  ["968", "OM"],
  ["973", "BH"],
  ["880", "BD"],
  ["977", "NP"],
  ["94", "LK"],
  ["65", "SG"],
  ["60", "MY"],
  ["44", "GB"],
  ["61", "AU"],
  ["91", "IN"],
  ["1", "US"],
];

/** The workspace country from its WhatsApp number's calling code; India when unknown. */
export function countryOfPhone(phone: string | null | undefined): string {
  const d = digits(phone ?? "");
  if (!d) return DEFAULT_COUNTRY;
  return CALLING_CODES.find(([code]) => d.startsWith(code))?.[1] ?? DEFAULT_COUNTRY;
}

const minorOf = (v: unknown): bigint | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? BigInt(v) : null);

/** Reads every fact smartDefaults needs. Never throws for an optional fact. `allowedGoals`: the goals offered (DefaultFacts). */
export async function loadDefaultFacts(actor: Actor, opts: { allowedGoals?: readonly GoalKey[]; now?: Date } = {}): Promise<DefaultFacts> {
  const tenantId = actor.tenantId;
  const now = opts.now ?? new Date();
  const [control, assets, owner, phone, forms, brand, settings, last] = await Promise.all([
    prisma.spendControl.findUnique({ where: { tenantId }, select: { spendingAdAccountAssetId: true, timezone: true } }),
    prisma.metaAsset.findMany({ where: { tenantId, status: "active", type: { in: ["ad_account", "page", "instagram"] } }, select: { id: true, type: true, externalId: true, name: true, meta: true }, orderBy: [{ type: "asc" }, { name: "asc" }], take: 500 }),
    prisma.membership.findFirst({ where: { tenantId, role: "owner" }, select: { user: { select: { name: true } } }, orderBy: { createdAt: "asc" } }),
    prisma.phoneNumber.findFirst({ where: { tenantId, status: "connected" }, select: { id: true, displayPhone: true }, orderBy: { createdAt: "asc" } }),
    prisma.leadForm.count({ where: { tenantId, hiddenAt: null } }).catch(() => 0),
    prisma.brand.findFirst({ where: { tenantId, specialAdCategory: { not: "none" } }, select: { specialAdCategory: true } }).catch(() => null),
    getPromoteSettings(tenantId).catch(() => null),
    prisma.adCampaign
      .findFirst({ where: { tenantId, surface: { in: ["promote", "eddy"] } }, orderBy: { createdAt: "desc" }, select: { adSets: { take: 1, select: { ads: { take: 1, select: { creative: true } } } } } })
      .catch(() => null),
  ]);
  const rows = (assets ?? []) as { id: string; type: string; externalId: string; name: string | null; meta: unknown }[];
  const accountRow = control?.spendingAdAccountAssetId ? rows.find((a) => a.type === "ad_account" && a.id === control.spendingAdAccountAssetId) : undefined;
  const am = obj(accountRow?.meta);
  const currency = str(am.currency)?.toUpperCase() ?? null;
  const phoneDigits = digits(phone?.displayPhone);

  const pages: DefaultPage[] = rows
    .filter((a) => a.type === "page")
    .map((a) => {
      const pm = obj(a.meta);
      const linkedNumber = digits(pm.whatsappNumber);
      return { assetId: a.id, externalId: a.externalId, name: a.name, whatsappLinked: pm.whatsappLinkState === "ok" || (!!phoneDigits && !!linkedNumber && linkedNumber === phoneDigits) };
    });
  const instagram: DefaultInstagram[] = rows.filter((a) => a.type === "instagram").map((a) => ({ assetId: a.id, externalId: a.externalId, name: str(obj(a.meta).username) ?? a.name, pageId: str(obj(a.meta).pageId) }));

  const lastCreative = obj(last?.adSets?.[0]?.ads?.[0]?.creative);

  let headroom: DefaultFacts["headroom"] = null;
  let fromInr: FromInr | null = null;
  if (accountRow && currency) {
    try {
      const detail = await adsHeadroomDetail(tenantId, { currency, now });
      headroom = { leftTodayMinor: detail.headroom.today.left, leftMonthMinor: detail.headroom.month.left };
    } catch {
      headroom = null;
    }
    if (currency !== "INR") {
      try {
        const table = await readFx();
        fromInr = (inr: bigint) => convertFromInr(inr, currency, table, now);
      } catch {
        fromInr = null;
      }
    }
  }

  const category = brand?.specialAdCategory;
  return {
    role: actor.role,
    ownerName: str(owner?.user?.name),
    spendingAccount:
      accountRow && currency
        ? { assetId: accountRow.id, externalId: accountRow.externalId, currency, timezone: str(am.timezone) ?? control?.timezone ?? "Asia/Kolkata", minDailyMinor: minorOf(am.minDailyBudgetMinor) }
        : null,
    pages,
    instagram,
    lastUsed: { pageExternalId: str(lastCreative.pageId), instagramExternalId: str(lastCreative.instagramId) },
    whatsappNumberId: phone?.id ?? null,
    hasForms: (forms ?? 0) > 0,
    country: countryOfPhone(phone?.displayPhone),
    shop: settings?.shop ?? null,
    welcome: settings?.welcome ?? {},
    brandCategory: isCategory(category) ? category : "none",
    headroom,
    fromInr,
    allowedGoals: opts.allowedGoals,
    now,
  };
}
