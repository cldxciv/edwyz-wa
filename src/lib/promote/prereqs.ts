/**
 * The readiness checklist (docs/IG-PAGE-ADS-SPEC.md 3.1a, 3.2, 3.6, 8.3, 8.3a; Eddy's check_promotion_setup). Shown inline on
 * the goal cards and on the Review card.
 *
 * Each row is ok, missing or unknown, and carries exactly one fix (`fix`), plus, where the spec offers one, other ways out
 * (`more`): [Run on Facebook only] on every Instagram row, and the Opens Meta page_advertise_task after the in-app reconnect.
 * - Fixes are in Edwyz first: reconnect (the popup), create the ads-only Instagram identity (C8), create a pixel (C9), the
 *   inline privacy link and shop location. Opens Meta only for the screens in src/lib/meta-connect/meta-screens.ts, with the
 *   address resolved here on the server.
 * - Owners and admins get different fixes where only the owner can act (the spending account, the limits and their currency):
 *   the owner goes to Settings > Spending limits; an admin gets "Ask {owner}".
 * - Rows that wait on a VERIFY step (V-P4 Instagram messages, V-P11 Instagram from the ad account, V-P12 the Page's WhatsApp
 *   number) are warnings: unknown (or missing) but never blocking.
 * - `blocks` is true only for a missing row that isn't a warning. Unknown never blocks: Phase 0 and Meta still decide at Start.
 *
 * evaluatePrereqs() is pure (facts in, rows out). loadPrereqFacts() reads the facts: the stored discovery blocks (5.4 MetaAsset
 * meta), Phase 0's spending account and ads limit, the workspace's WhatsApp number, Promote settings, and the pixel (C7).
 */
import { t as eddyText } from "@/lib/eddy/i18n";
import type { CoreKey } from "@/lib/eddy/copy/en";
import { metaScreenHref, META_SCREENS } from "@/lib/meta-connect/meta-screens";
import { HttpError, type Actor } from "@/lib/tenancy";
import { goalRow } from "./catalog/goals";
import { isPromoteCopyKey, promoteText, type CopyVars, type PromoteCopyKey } from "./copy";
import { pixelStatus, type PixelDeps, type PixelStatus } from "./pixel";
import { chooseIdentity, type SourceAsset } from "./sources";
import { isGoalKey, type GoalKey, type MetaScreenKey, type PromoteLang, type ReadinessCheck, type ReadinessStatus } from "./types";

// =====================================================================================================================
// Shapes
// =====================================================================================================================

/** In-app fixes. Each is an action the page or Eddy can run without leaving Edwyz. */
export const IN_APP_FIXES = [
  "create_instagram_identity",
  "choose_instagram",
  "use_page",
  "facebook_only",
  "recheck_leadgen_terms",
  "create_pixel",
  "pixel_install_code",
  "privacy_link",
  "shop_location",
  "instagram_app_setting",
] as const;
export type InAppFix = (typeof IN_APP_FIXES)[number];

export type PrereqFix =
  | { kind: "opens_meta"; key: MetaScreenKey; label: string; href: string | null }
  | { kind: "reconnect"; key: "connect_facebook"; label: string }
  | { kind: "in_app"; key: InAppFix; label: string }
  | { kind: "settings"; key: "spending_limits" | "connect_whatsapp"; label: string; href: string }
  | { kind: "ask_owner"; key: "ask_owner"; label: string };

/** The 8.3a Instagram states. */
export const IG_STATES = ["linked", "no_account", "personal", "other_page", "ads_only", "not_usable", "no_picture", "restricted", "token_lost"] as const;
export type IgState = (typeof IG_STATES)[number];

export type PrereqRow = {
  check: ReadinessCheck;
  status: ReadinessStatus;
  /** The row's line ("Facebook is connected"). */
  label: string;
  /** What is wrong, in plain words, when the label alone doesn't say it. */
  detail: string | null;
  igState?: IgState;
  /** Exactly one fix. */
  fix: PrereqFix;
  /** Other ways out ([Run on Facebook only], the Opens Meta second choice). */
  more: PrereqFix[];
  /** A warning: shown, never blocking. */
  warningOnly: boolean;
  /** Missing and not a warning: Start waits for this row. */
  blocks: boolean;
};

export type PrereqFacts = {
  role: Actor["role"];
  /** The owner's name for "Ask {owner}". */
  ownerName: string | null;
  /** A Meta connection with a usable token. */
  facebookConnected: boolean;
  spendingAccount: {
    assetId: string;
    externalId: string;
    name: string | null;
    currency: string | null;
    accountStatus: number | null;
    disableReason: number | null;
    fundingPresent: boolean | null;
    customAudienceTos: boolean | null;
    userTosAccepted: boolean | null;
  } | null;
  adsLimit: { currency: string; dailyLimitMinor: bigint | null } | null;
  page: {
    assetId: string;
    externalId: string;
    name: string | null;
    canAdvertise: boolean | null;
    leadgenTosAccepted: boolean | null;
    whatsappLinkState: "ok" | "missing" | "unknown" | null;
  } | null;
  instagram: {
    assetId: string;
    externalId: string;
    username: string | null;
    pageId: string | null;
    pageBacked: boolean;
    profilePictureUrl: string | null;
    /** Ad accounts Meta lists as able to run ads as this account (C6); null when never read. */
    authorizedAdAccountIds: string[] | null;
    restricted?: boolean;
  } | null;
  /** The Page the Instagram account is connected to, when it isn't the chosen Page. */
  instagramPage: { assetId: string; name: string | null } | null;
  /** The member says they have an Instagram account although discovery found none (8.3a: personal account). */
  saysHasInstagram?: boolean;
  whatsappConnected: boolean;
  pixel: PixelStatus | null;
  settings: { privacyUrl: string | null; shop: boolean };
  /** Lead Access Manager: known only after a lead read was refused (missing) or worked (ok). */
  leadAccess: "ok" | "missing" | "unknown";
};

export type PrereqOptions = {
  goal: GoalKey;
  /** Automatic (default), Instagram only, or Facebook only. */
  placements?: "auto" | "instagram" | "facebook";
  /** "near my shop" is the audience. */
  nearShop?: boolean;
  /** The draft uses a customer list or another custom audience. */
  customAudience?: boolean;
  /** The draft makes or uses a website audience (it needs a pixel). */
  websiteAudience?: boolean;
  lang?: PromoteLang;
};

// =====================================================================================================================
// Which rows a goal shows
// =====================================================================================================================

const IG_ROWS: readonly ReadinessCheck[] = ["instagram_identity", "instagram_page_link", "instagram_ad_account"];
/** Rows that wait on a VERIFY step (V-P4, V-P11, V-P12): warnings, never blocks. */
export const WARNING_ONLY: ReadonlySet<ReadinessCheck> = new Set<ReadinessCheck>(["instagram_ad_account", "instagram_messages_access", "whatsapp_page_link"]);

/** The checks for a goal, in display order, and whether the Instagram rows are required (else they warn). */
export function checksFor(opts: Omit<PrereqOptions, "lang">): { checks: ReadinessCheck[]; instagramRequired: boolean } {
  const row = goalRow(opts.goal);
  const placements = opts.placements ?? "auto";
  const required = new Set<ReadinessCheck>(row.prerequisites);
  const checks = [...row.prerequisites];
  const igOnly = !row.platforms.includes("facebook");
  const instagramRequired = IG_ROWS.some((c) => required.has(c)) || placements === "instagram" || igOnly;
  const usesInstagram = row.platforms.includes("instagram") && (placements !== "facebook" || igOnly);
  if (usesInstagram) for (const c of IG_ROWS) if (!checks.includes(c)) checks.push(c);
  const out = usesInstagram ? checks : checks.filter((c) => !IG_ROWS.includes(c) && c !== "instagram_messages_access");
  if (opts.nearShop && !out.includes("shop_location")) out.push("shop_location");
  if (opts.customAudience && !out.includes("custom_audience_tos")) out.push("custom_audience_tos");
  if (opts.websiteAudience && !out.includes("pixel")) out.push("pixel");
  return { checks: out, instagramRequired };
}

// =====================================================================================================================
// Copy and fixes
// =====================================================================================================================

/** Promote copy, else Eddy's core catalogue (for the screens and buttons Eddy owns). */
export function copyText(key: string, vars: CopyVars = {}, lang: PromoteLang = "en"): string {
  if (isPromoteCopyKey(key)) return promoteText(key, vars, lang);
  if (eddyText.has(key)) return eddyText(lang, key as CoreKey, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "string" || typeof v === "number" ? v : v == null ? v : String(v)])) as Record<string, string | number | null | undefined>);
  return key;
}

/** Where the readiness fixes go inside Edwyz. */
export const PREREQ_PATHS = { spendingLimits: "/app/settings/spending", connectWhatsApp: "/app/settings/connect" } as const;

/** The Opens Meta keys this checklist can show (the two-way test checks them against meta-screens.ts). */
export const PREREQ_OPENS_META: readonly MetaScreenKey[] = [
  "payment_method",
  "business_verification",
  "account_quality",
  "page_advertise_task",
  "link_instagram_to_page",
  "leadgen_tos",
  "link_whatsapp_to_page",
  "custom_audience_tos",
  "lead_access_manager",
];

/** Goals that send people to the Instagram profile or its inbox, which an ads-only identity doesn't have. */
const NEEDS_REAL_PROFILE: ReadonlySet<GoalKey> = new Set<GoalKey>(["instagram_dms", "profile_visits"]);

/** Meta's account_status values that mean a payment problem (3 unsettled, 8 pending settlement, 9 grace period). */
const PAYMENT_STATUSES = new Set([3, 8, 9]);
/** disable_reason 3: a payment risk. 6: a business integrity review, which asks for business verification. */
const PAYMENT_DISABLE = 3;
const VERIFY_DISABLE = 6;

const actNumber = (v: string | null | undefined) => (v ?? "").replace(/^act_/, "");

// =====================================================================================================================
// The rows
// =====================================================================================================================

/** Every row of the goal's checklist, in order. Pure. */
export function evaluatePrereqs(facts: PrereqFacts, opts: PrereqOptions): PrereqRow[] {
  const lang = opts.lang ?? "en";
  const { checks, instagramRequired } = checksFor(opts);
  const text = (key: string, vars: CopyVars = {}) => copyText(key, vars, lang);
  const owner = facts.ownerName?.trim() || "the owner";
  const isOwner = facts.role === "owner";
  const goal = goalRow(opts.goal);
  const canFacebookOnly = goal.platforms.includes("facebook");
  const params = { pageId: facts.page?.externalId ?? null, act: facts.spendingAccount ? actNumber(facts.spendingAccount.externalId) : null };

  const opensMeta = (key: MetaScreenKey): PrereqFix => ({ kind: "opens_meta", key, label: text(META_SCREENS[key].labelKey), href: metaScreenHref(key, params) });
  const reconnect = (labelKey: PromoteCopyKey = "readiness.reconnect"): PrereqFix => ({ kind: "reconnect", key: "connect_facebook", label: text(labelKey) });
  const inApp = (key: InAppFix, labelKey: string, vars: CopyVars = {}): PrereqFix => ({ kind: "in_app", key, label: text(labelKey, vars) });
  const spendingLimits = (labelKey: PromoteCopyKey): PrereqFix => ({ kind: "settings", key: "spending_limits", label: text(labelKey), href: PREREQ_PATHS.spendingLimits });
  const askOwner = (labelKey: PromoteCopyKey): PrereqFix => ({ kind: "ask_owner", key: "ask_owner", label: text(labelKey, { owner }) });
  const facebookOnly = (): PrereqFix[] => (canFacebookOnly ? [inApp("facebook_only", "fix.facebook_only")] : []);

  const row = (check: ReadinessCheck, status: ReadinessStatus, fix: PrereqFix, extra: Partial<Pick<PrereqRow, "detail" | "igState" | "more" | "warningOnly">> = {}): PrereqRow => {
    const warningOnly = extra.warningOnly ?? WARNING_ONLY.has(check);
    return {
      check,
      status,
      label: text(`readiness.${check}`),
      detail: extra.detail ?? null,
      ...(extra.igState ? { igState: extra.igState } : {}),
      fix,
      more: extra.more ?? [],
      warningOnly,
      blocks: status === "missing" && !warningOnly,
    };
  };
  const bool = (v: boolean | null | undefined): ReadinessStatus => (v === true ? "ok" : v === false ? "missing" : "unknown");

  const account = facts.spendingAccount;
  const page = facts.page;
  const ig = facts.instagram;
  const igSoft = !instagramRequired;
  const igName = ig?.username ?? ig?.externalId ?? "";

  const evaluate = (check: ReadinessCheck): PrereqRow => {
    switch (check) {
      case "facebook_connected":
        return row(check, facts.facebookConnected ? "ok" : "missing", reconnect());
      case "spending_account":
        return row(check, account ? "ok" : "missing", isOwner ? spendingLimits("readiness.choose_account") : askOwner("readiness.ask_owner_account"));
      case "daily_limit": {
        const set = facts.adsLimit?.dailyLimitMinor !== null && facts.adsLimit?.dailyLimitMinor !== undefined;
        return row(check, set ? "ok" : "missing", isOwner ? spendingLimits("fix.spending_limits") : askOwner("readiness.ask_owner"), { detail: set ? null : text("spend.no_limit") });
      }
      case "account_active": {
        if (!account) return row(check, "unknown", opensMeta("account_quality"));
        const s = account.accountStatus;
        const payment = (s !== null && PAYMENT_STATUSES.has(s)) || account.disableReason === PAYMENT_DISABLE;
        const fix = payment ? opensMeta("payment_method") : account.disableReason === VERIFY_DISABLE ? opensMeta("business_verification") : opensMeta("account_quality");
        if (s === 1) return row(check, "ok", fix);
        if (s === null) return row(check, "unknown", fix);
        return row(check, "missing", fix, { detail: payment ? null : text("error.account_restricted", { account: account.name ?? account.externalId }) });
      }
      case "payment_method":
        return row(check, account ? bool(account.fundingPresent) : "unknown", opensMeta("payment_method"));
      case "page_advertise":
        return row(check, page ? bool(page.canAdvertise) : "missing", reconnect("readiness.page_advertise.fix"), { more: page ? [opensMeta("page_advertise_task")] : [] });
      case "currency_match": {
        const limit = facts.adsLimit?.currency?.toUpperCase() ?? null;
        const acct = account?.currency?.toUpperCase() ?? null;
        const status: ReadinessStatus = !limit || !acct ? "unknown" : limit === acct ? "ok" : "missing";
        return row(check, status, isOwner ? spendingLimits("fix.spending_limits") : askOwner("readiness.ask_owner"));
      }
      case "instagram_identity":
        return instagramIdentity();
      case "instagram_page_link": {
        if (!ig || !page) return row(check, "unknown", inApp("choose_instagram", "readiness.instagram_choose"), { warningOnly: igSoft, more: facebookOnly() });
        if (ig.pageId === null || ig.pageId === page.externalId) return row(check, "ok", inApp("choose_instagram", "readiness.instagram_choose"), { warningOnly: igSoft, more: facebookOnly() });
        const other = facts.instagramPage?.name ?? "";
        return row(check, "missing", inApp("use_page", "ig.fix.use_page", { page: other }), {
          detail: text("ig.state.other_page", { username: igName, page: other }),
          igState: "other_page",
          warningOnly: igSoft,
          more: facebookOnly(),
        });
      }
      case "instagram_ad_account": {
        const fix = reconnect("ig.fix.connect_both");
        if (!ig || !account) return row(check, "unknown", fix, { more: facebookOnly() });
        if (ig.authorizedAdAccountIds?.some((a) => actNumber(a) === actNumber(account.externalId))) return row(check, "ok", fix, { more: facebookOnly() });
        // V-P11: Meta's answer isn't trusted to block yet, so it stays a warning.
        return row(check, "unknown", fix, { detail: text("ig.state.not_usable", { username: igName }), igState: "not_usable", more: facebookOnly() });
      }
      case "instagram_messages_access":
        return row(check, "unknown", inApp("instagram_app_setting", "readiness.instagram_messages_access"));
      case "whatsapp_connected":
        return row(check, facts.whatsappConnected ? "ok" : "missing", { kind: "settings", key: "connect_whatsapp", label: text("btn.connect_whatsapp"), href: PREREQ_PATHS.connectWhatsApp });
      case "whatsapp_page_link": {
        const state = page?.whatsappLinkState ?? null;
        const status: ReadinessStatus = state === "ok" ? "ok" : state === "missing" ? "missing" : "unknown";
        return row(check, status, opensMeta("link_whatsapp_to_page"), { detail: status === "ok" ? null : text("readiness.whatsapp_page_link.hint") });
      }
      case "leadgen_tos":
        return row(check, page ? bool(page.leadgenTosAccepted) : "unknown", opensMeta("leadgen_tos"), { more: [inApp("recheck_leadgen_terms", "readiness.leadgen_tos.done")] });
      case "pixel":
        return pixelRow();
      case "custom_audience_tos": {
        const status: ReadinessStatus = !account
          ? "unknown"
          : account.customAudienceTos === false || account.userTosAccepted === false
            ? "missing"
            : account.customAudienceTos === true && account.userTosAccepted === true
              ? "ok"
              : "unknown";
        return row(check, status, opensMeta("custom_audience_tos"));
      }
      case "privacy_link":
        return row(check, facts.settings.privacyUrl ? "ok" : "missing", inApp("privacy_link", "form.privacy_label"));
      case "shop_location":
        return row(check, facts.settings.shop ? "ok" : "missing", inApp("shop_location", "readiness.shop_location"));
      case "lead_access":
        return row(check, facts.leadAccess, opensMeta("lead_access_manager"));
    }
  };

  /** 8.3a: one state, its words, one fix, and [Run on Facebook only] whenever the goal can run there. */
  function instagramIdentity(): PrereqRow {
    const check: ReadinessCheck = "instagram_identity";
    const more = facebookOnly();
    const base = { warningOnly: igSoft };
    if (!ig) {
      if (facts.saysHasInstagram) return row(check, "missing", reconnect("ig.fix.connect_again"), { ...base, igState: "personal", detail: text("ig.state.personal"), more });
      return row(check, "missing", inApp("create_instagram_identity", "ig.fix.page_backed"), {
        ...base,
        igState: "no_account",
        detail: text("ig.state.no_account"),
        more: [opensMeta("link_instagram_to_page"), ...more],
      });
    }
    if (!facts.facebookConnected) return row(check, "missing", reconnect("ig.fix.connect_again"), { ...base, igState: "token_lost", detail: text("ig.state.token_lost", { username: igName }), more });
    if (ig.restricted) return row(check, "missing", opensMeta("account_quality"), { ...base, igState: "restricted", detail: text("ig.state.restricted", { username: igName }), more });
    // An ads-only identity has no profile and no inbox: fine for ads in Instagram places, not for profile visits or DMs.
    if (ig.pageBacked) return row(check, NEEDS_REAL_PROFILE.has(opts.goal) ? "missing" : "ok", opensMeta("link_instagram_to_page"), { ...base, igState: "ads_only", detail: text("ig.state.ads_only"), more });
    if (!ig.profilePictureUrl) return row(check, "missing", reconnect(), { igState: "no_picture", detail: text("ig.state.no_picture"), warningOnly: true, more });
    return row(check, "ok", inApp("choose_instagram", "readiness.instagram_choose"), { ...base, igState: "linked", more });
  }

  /** In Edwyz: [Create a pixel] (C9) with the install code, or the stale-pixel line with [Copy code]. */
  function pixelRow(): PrereqRow {
    const check: ReadinessCheck = "pixel";
    const p = facts.pixel;
    if (!p || p.state === "no_account") return row(check, "unknown", inApp("create_pixel", "readiness.pixel_create"));
    if (p.state === "none") return row(check, "missing", inApp("create_pixel", "readiness.pixel_create"), { detail: text("readiness.pixel_install") });
    if (p.state === "ok") return row(check, "ok", inApp("pixel_install_code", "readiness.copy_code"));
    if (p.state === "stale") return row(check, "missing", inApp("pixel_install_code", "readiness.copy_code"), { detail: text("readiness.pixel_stale") });
    return row(check, "unknown", inApp("pixel_install_code", "readiness.copy_code"));
  }

  return checks.map(evaluate);
}

/** True when nothing blocks Start. */
export const prereqsReady = (rows: readonly PrereqRow[]): boolean => !rows.some((r) => r.blocks);

// =====================================================================================================================
// Facts from the database (and C7 for the pixel)
// =====================================================================================================================

export type PrereqLoadOptions = {
  pageAssetId?: string | null;
  igAssetId?: string | null;
  saysHasInstagram?: boolean;
  /** Read the pixel (C7): only goals and audiences that need it. */
  withPixel?: boolean;
  pixel?: Partial<PixelDeps>;
  now?: number;
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strOr = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const numOr = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const boolOr = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const LIVE = new Set(["active", "expiring"]);

/** The privacy link counts only as an https address (3.5). */
export function httpsUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2000) return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

export async function loadPrereqFacts(actor: Actor, opts: PrereqLoadOptions = {}): Promise<PrereqFacts> {
  const { prisma } = await import("@/lib/db");
  const tenantId = actor.tenantId;
  const now = opts.now ?? Date.now();
  const [connections, assets, control, allowance, whatsapp, settingsRow, ownerRow] = await Promise.all([
    prisma.metaConnection.findMany({ where: { tenantId }, select: { status: true, tokenExpiresAt: true } }),
    prisma.metaAsset.findMany({
      where: { tenantId, status: "active", type: { in: ["page", "instagram", "ad_account"] } },
      select: { id: true, type: true, externalId: true, name: true, meta: true },
      orderBy: [{ type: "asc" }, { name: "asc" }],
      take: 500,
    }),
    prisma.spendControl.findUnique({ where: { tenantId }, select: { spendingAdAccountAssetId: true } }),
    prisma.spendAllowance.findUnique({ where: { tenantId_pot: { tenantId, pot: "ads" } }, select: { currency: true, dailyLimitMinor: true } }),
    prisma.phoneNumber.count({ where: { tenantId, status: "connected" } }),
    prisma.platformSetting.findUnique({ where: { key: `promote:settings:${tenantId}` }, select: { value: true } }),
    prisma.membership.findFirst({ where: { tenantId, role: "owner" }, select: { user: { select: { name: true } } }, orderBy: { createdAt: "asc" } }),
  ]);

  const facebookConnected = (connections ?? []).some((c) => LIVE.has(c.status) && (!c.tokenExpiresAt || c.tokenExpiresAt.getTime() > now));
  const rows = (assets ?? []) as SourceAsset[];
  const accountRow = control?.spendingAdAccountAssetId ? rows.find((a) => a.type === "ad_account" && a.id === control.spendingAdAccountAssetId) : undefined;
  const am = obj(accountRow?.meta);
  const { identity } = chooseIdentity(rows.filter((a) => a.type !== "ad_account"), { pageAssetId: opts.pageAssetId, igAssetId: opts.igAssetId });
  const pageRow = identity.page ? rows.find((a) => a.id === identity.page!.assetId) : undefined;
  const igRow = identity.instagram ? rows.find((a) => a.id === identity.instagram!.assetId) : undefined;
  const pm = obj(pageRow?.meta);
  const im = obj(igRow?.meta);
  const igPageId = strOr(im.pageId);
  const igPage = igPageId && pageRow && igPageId !== pageRow.externalId ? rows.find((a) => a.type === "page" && a.externalId === igPageId) : undefined;
  const settings = obj(settingsRow?.value);
  const linkState = pm.whatsappLinkState;

  const pixel = opts.withPixel ? await pixelStatus(tenantId, { now: () => now, ...opts.pixel }).catch((): PixelStatus | null => null) : null;

  return {
    role: actor.role,
    ownerName: strOr(ownerRow?.user?.name),
    facebookConnected,
    spendingAccount: accountRow
      ? {
          assetId: accountRow.id,
          externalId: accountRow.externalId,
          name: accountRow.name,
          currency: strOr(am.currency),
          accountStatus: numOr(am.accountStatus),
          disableReason: numOr(am.disableReason),
          fundingPresent: boolOr(am.fundingPresent),
          customAudienceTos: boolOr(am.customAudienceTos),
          userTosAccepted: boolOr(am.userTosAccepted),
        }
      : null,
    adsLimit: allowance ? { currency: allowance.currency, dailyLimitMinor: allowance.dailyLimitMinor ?? null } : null,
    page: pageRow
      ? {
          assetId: pageRow.id,
          externalId: pageRow.externalId,
          name: pageRow.name,
          canAdvertise: boolOr(pm.canAdvertise),
          leadgenTosAccepted: boolOr(pm.leadgenTosAccepted),
          whatsappLinkState: linkState === "ok" || linkState === "missing" || linkState === "unknown" ? linkState : null,
        }
      : null,
    instagram: igRow
      ? {
          assetId: igRow.id,
          externalId: igRow.externalId,
          username: strOr(im.username) ?? igRow.name,
          pageId: igPageId,
          pageBacked: im.pageBacked === true,
          profilePictureUrl: strOr(im.profilePictureUrl),
          authorizedAdAccountIds: Array.isArray(im.authorizedAdAccountIds) ? (im.authorizedAdAccountIds as unknown[]).filter((v): v is string => typeof v === "string") : null,
        }
      : null,
    instagramPage: igPage ? { assetId: igPage.id, name: igPage.name } : null,
    saysHasInstagram: opts.saysHasInstagram === true,
    whatsappConnected: (whatsapp ?? 0) > 0,
    pixel,
    settings: { privacyUrl: httpsUrl(settings.privacyUrl), shop: Object.keys(obj(settings.shop)).length > 0 && numOr(obj(settings.shop).lat) !== null },
    // What the last lead read of this Page said (leads/backfill.ts records it; a refusal counts for 24 hours). Unknown when unread.
    leadAccess: pageRow ? await import("@/lib/leads/backfill").then((m) => m.leadAccessState(tenantId, pageRow.id, now), () => "unknown" as const) : "unknown",
  };
}

export type PrereqsResult = {
  goal: GoalKey;
  rows: PrereqRow[];
  /** Nothing blocks Start. */
  ready: boolean;
  identity: { pageAssetId: string | null; igAssetId: string | null };
};

/** check_promotion_setup: the goal's checklist for this member. */
export async function checkPromotionSetup(actor: Actor, input: { goal: unknown } & Omit<PrereqOptions, "goal"> & PrereqLoadOptions): Promise<PrereqsResult> {
  if (!isGoalKey(input.goal)) throw new HttpError(400, "Choose what the ad should do first.");
  const goal = input.goal;
  const opts: PrereqOptions = { goal, placements: input.placements, nearShop: input.nearShop, customAudience: input.customAudience, websiteAudience: input.websiteAudience, lang: input.lang };
  const facts = await loadPrereqFacts(actor, { ...input, withPixel: checksFor(opts).checks.includes("pixel") });
  const rows = evaluatePrereqs(facts, opts);
  return { goal, rows, ready: prereqsReady(rows), identity: { pageAssetId: facts.page?.assetId ?? null, igAssetId: facts.instagram?.assetId ?? null } };
}
