/**
 * Shared setup for the Instagram and Facebook Page ads end-to-end specs (docs/IG-PAGE-ADS-SPEC.md 9.3, 9.4; PRM-16).
 *
 * How these specs run (9.4, critic row 32):
 * - The Next.js server under test calls Graph for the post picker, readiness, previews, forms and the connect callback, which
 *   page.route cannot reach. So it runs against the fake Meta HTTP server that e2e/global-setup.ts starts on 127.0.0.1, through
 *   GRAPH_BASE_URL. context.route is used only for the browser-side facebook.com popup (promote-connect-popup.spec.ts).
 * - Playwright starts the app itself (playwright.config.ts webServer, with E2E_BASE_URL unset), so the runner owns the app's
 *   environment: NODE_ENV=test (or development), GRAPH_BASE_URL at the fake, SPEND_DRY_RUN=1 (every spending ads write is faked
 *   before it leaves the app), PROMOTE_ENABLED=on, PROMOTE_AUDIENCES=all, EDDY_FAKE_MODEL=scripted. It records what it passed in
 *   E2E_APP_ENV.
 * - Loading this file throws, and so fails the run, unless E2E_APP_ENV is there (the app was started by this runner, not by
 *   hand), its NODE_ENV is not production, its GRAPH_BASE_URL is a loopback address on the fake's port, SPEND_DRY_RUN=1 and
 *   PROMOTE_ENABLED=on. The runner's own shell and .env are never read for these: they say nothing about the app.
 * - Each spec also checks, per test, that the app really reads Graph from the fake (expectAppReadsFake: the post picker answers
 *   with the fake's media, which only the fake gives for the fake tokens, and the fake saw that read since the test's marker),
 *   and that no promote call reached a spend class there (expectNoSpendViolations).
 *
 * Run: `npm run build`, then `npx playwright test` with E2E_BASE_URL unset (or E2E_APP_MODE=dev to use `next dev`, no build).
 *
 * Meta assets are seeded with growth-helpers' seedMeta and then pointed at the fake's ad account, Page and Instagram account
 * (and their fake tokens), so the server's Graph calls find them; the ads limits are set with growth-helpers' setCap.
 * Scenarios on the fake (POST /__fake/scenario) are shared by every spec that runs at the same time: a spec turns one on only
 * for as long as it needs it (withFakeScenario).
 */
import { createHmac } from "node:crypto";
import { deflateSync } from "node:zlib";
import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { isLoopbackGraphBaseUrl } from "../src/lib/env-rules.mjs";
import { en } from "../src/lib/promote/copy/en";
import { FAKE_ACT, FAKE_IG_ID, FAKE_PAGE_ID, FAKE_PAGE_TOKEN, FAKE_USER_TOKEN, type PromoteScenario } from "../tests/helpers/fake-meta-promote";
import { joinWorkspace, skipWelcome } from "./auth-onboarding-util";
import { axeSerious, overflowsX, seal, seedMeta, setCap } from "./growth-helpers";
import { BASE, connectFakeNumber, db, ORIGIN, signupUser, stamp, type TestUser } from "./helpers";
import { APP_ENV_KEY, recordedAppEnv } from "./global-setup";
import { liftNewWorkspaceLimits, seedSpendControl } from "./spend-kit";

type Env = Record<string, string | undefined>;

export type PromoteE2EEnv = {
  /** The app's GRAPH_BASE_URL, without a trailing slash. */
  graphBaseUrl: string;
  /** Where the fake Meta server listens (FAKE_META_URL from the global setup, else GRAPH_BASE_URL). */
  fakeUrl: string;
  /** Everything playwright.config.ts started the app with (E2E_APP_ENV). */
  app: Readonly<Record<string, string>>;
};

const ON = new Set(["1", "true", "yes", "on"]);
const portOf = (u: URL) => u.port || (u.protocol === "https:" ? "443" : "80");

/**
 * The guard of 9.4: throws unless the app was started by this Playwright run (so its settings are known), not with
 * NODE_ENV=production, with its Graph calls going to the fake on a loopback address, spending writes as dry runs and promote on.
 * Reads the app's settings from E2E_APP_ENV only, never from the runner's shell or .env. Never echoes a full address: a
 * mistyped value could be someone's real host.
 */
export function assertPromoteEnv(env: Env = process.env): PromoteE2EEnv {
  const app = recordedAppEnv(env);
  if (!app) {
    throw new Error(
      `The promote specs run only against the app Playwright starts itself (playwright.config.ts webServer), because only then are the app's GRAPH_BASE_URL, SPEND_DRY_RUN and PROMOTE_ENABLED known (${APP_ENV_KEY} is missing). Unset E2E_BASE_URL, stop anything on port 3500, and run npx playwright test again.`,
    );
  }
  if ((app.NODE_ENV ?? "").trim() === "production") {
    throw new Error("The app was started with NODE_ENV=production, where it ignores GRAPH_BASE_URL and SPEND_DRY_RUN and would call the real Graph API. Use E2E_APP_MODE=start (NODE_ENV=test) or dev.");
  }
  const graph = (app.GRAPH_BASE_URL ?? "").trim();
  if (!graph) {
    throw new Error("The app was started without GRAPH_BASE_URL, so it would call the real Graph API. Run the promote specs through playwright.config.ts, which points it at the fake Meta server.");
  }
  if (!isLoopbackGraphBaseUrl(graph)) {
    throw new Error("GRAPH_BASE_URL must be an http address on 127.0.0.1, localhost or [::1] (the fake Meta server). The promote specs never call the real Graph API.");
  }
  const fake = (env.FAKE_META_URL ?? "").trim() || graph;
  if (!isLoopbackGraphBaseUrl(fake)) throw new Error("FAKE_META_URL must be a loopback address (it is set by e2e/global-setup.ts).");
  if (portOf(new URL(fake)) !== portOf(new URL(graph))) {
    throw new Error(`The app's GRAPH_BASE_URL uses port ${portOf(new URL(graph))}, but the fake Meta server listens on port ${portOf(new URL(fake))}. Use the same port for both.`);
  }
  if (!ON.has((app.SPEND_DRY_RUN ?? "").trim().toLowerCase())) {
    throw new Error("SPEND_DRY_RUN must be 1 for the promote specs, so every spending ads write is faked before it leaves the app.");
  }
  if ((app.PROMOTE_ENABLED ?? "").trim().toLowerCase() !== "on") {
    throw new Error("PROMOTE_ENABLED must be on for the promote specs.");
  }
  return { graphBaseUrl: graph.replace(/\/+$/, ""), fakeUrl: fake.replace(/\/+$/, ""), app };
}

// E2E_APP_ENV is set by playwright.config.ts in the runner, and the workers inherit it.
export const PROMOTE_ENV: PromoteE2EEnv = assertPromoteEnv(process.env);

/** A setting the app under test was started with (not the runner's own value), lower-cased; "" when Playwright did not set it. */
export const appSetting = (name: string): string => (PROMOTE_ENV.app[name] ?? "").trim().toLowerCase();

// =====================================================================================================================
// Copy
// =====================================================================================================================

export type CopyKey = keyof typeof en;

/** The English template with its {placeholders} filled (amounts arrive formatted, like "₹2,625"). */
export function t(key: CopyKey, vars: Record<string, string | number> = {}): string {
  return en[key].replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** A RegExp that matches the template with any value in its placeholders. */
export function tPattern(key: CopyKey): RegExp {
  const parts = en[key].split(/\{[A-Za-z][A-Za-z0-9_]*\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(parts.join(".+"));
}

/** ₹ with Indian grouping, as the pages print it. */
export const rupees = (major: number) => `₹${new Intl.NumberFormat("en-IN").format(major)}`;

// =====================================================================================================================
// The fake Meta server
// =====================================================================================================================

export type FakeCall = { method: string; pattern: string; class: string; tokenKind: string; permitted: boolean; relayed: boolean; status: number };

async function fake<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${PROMOTE_ENV.fakeUrl}${path}`, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) throw new Error(`fake Meta ${path} answered ${res.status}`);
  return (await res.json()) as T;
}

export async function fakeCalls(): Promise<FakeCall[]> {
  return (await fake<{ calls: FakeCall[] }>("/__fake/calls")).calls;
}

/**
 * A per-test marker: how many Graph requests the fake has answered so far (all specs together). Take it at the start of a
 * test and pass it to expectAppUsedFake or expectAppReadsFake.
 */
export async function fakeMark(): Promise<number> {
  return (await fakeCalls()).length;
}

/**
 * Graph calls the specs send to the fake themselves, playing Meta's part (fakeMetaTestLead). They carry the fake's tokens
 * too, so they are never counted as the app's. With SPEND_DRY_RUN=1 the app never sends one of these itself.
 */
export const SPEC_OWN_CALLS: readonly { method: string; pattern: RegExp }[] = [{ method: "POST", pattern: /(^|\/)test_leads$/ }];
/** The token kinds the app's seeded assets carry (seedPromote seals the fake's user and Page tokens). */
const APP_TOKEN_KINDS = new Set(["user", "page"]);

/** A call the app made: it carries one of the fake's tokens and is not one of the calls a spec sends itself. */
export const isAppCall = (c: Pick<FakeCall, "method" | "pattern" | "tokenKind">): boolean =>
  APP_TOKEN_KINDS.has(c.tokenKind) && !SPEC_OWN_CALLS.some((s) => s.method === c.method && s.pattern.test(c.pattern));

/** The app's calls the fake answered after `mark` (fakeMark), optionally only those whose pattern matches. */
export async function appCallsSince(mark: number, match?: RegExp): Promise<FakeCall[]> {
  return (await fakeCalls()).slice(mark).filter((c) => isAppCall(c) && (!match || match.test(c.pattern)));
}

export async function fakeScenario(name: PromoteScenario, on = true): Promise<void> {
  await fake("/__fake/scenario", { method: "POST", body: { name, on } });
}

/** Runs `fn` with a scenario on, and turns it off again even when `fn` fails. */
export async function withFakeScenario<T>(name: PromoteScenario, fn: () => Promise<T>): Promise<T> {
  await fakeScenario(name, true);
  try {
    return await fn();
  } finally {
    await fakeScenario(name, false);
  }
}

/**
 * The fake answered at least one of the app's calls (the fake's tokens, not a spec's own call) since `mark`, optionally one
 * whose pattern matches. Specs share the fake, so with two workers another test's app calls can count here too: this is the
 * backstop. The per-test proof is expectAppReadsFake, and the guarantee is that Playwright starts the app (assertPromoteEnv).
 */
export async function expectAppUsedFake(mark: number, opts: { match?: RegExp } = {}): Promise<void> {
  await expect
    .poll(async () => (await appCallsSince(mark, opts.match)).length, { message: "the app's Graph calls should reach the fake Meta server (GRAPH_BASE_URL)", timeout: 20_000 })
    .toBeGreaterThan(0);
}

/** The newest reel on the fake's Instagram account (tests/helpers/fake-meta-promote.ts seeds media newest first). */
export const FAKE_LATEST_REEL = "17900000000000000";
/** The post picker's reads: Instagram media and stories, the Page's published and promotable posts. */
export const SOURCE_READS = /^\{id\}\/(media|stories|published_posts|promotable_posts)$/;

/**
 * Per test, and safe with parallel workers: asks the app under test (as the signed-in owner of `request`) for the workspace's
 * Instagram reels. Only the fake Meta server answers the fake Page token with the fake's media, so the answer itself shows
 * that this app reads Graph from the fake and not from Meta; the fake also saw that read after `mark`.
 */
export async function expectAppReadsFake(request: APIRequestContext, mark: number): Promise<void> {
  const res = await api<{ items?: { id?: string }[] }>(request, "GET", "/api/promote/sources?source=instagram&kind=reel");
  expect(res.status, `the post picker's read: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
  expect((res.body.items ?? []).map((i) => i.id), "the app's posts should come from the fake Meta server").toContain(FAKE_LATEST_REEL);
  await expectAppUsedFake(mark, { match: SOURCE_READS });
}

/**
 * For specs whose own flow makes no Graph call (the cancelled popup): seeds a throwaway promote workspace in a new context and
 * checks the same app reads Graph from the fake.
 */
export async function proveAppUsesFake(browser: Browser): Promise<void> {
  const context = await browser.newContext();
  try {
    const mark = await fakeMark();
    await promoteOwner(context, "prm-probe");
    await expectAppReadsFake(context.request, mark);
  } finally {
    await context.close();
  }
}

/**
 * A Meta test lead on one of the fake's forms (playing Meta's part, with the Page token Edwyz would use); returns its id. The
 * only Graph call a spec sends itself (SPEC_OWN_CALLS), so it never counts as the app's.
 */
export async function fakeMetaTestLead(formId: string, fieldData: { name: string; values: string[] }[]): Promise<string> {
  const res = await fetch(`${PROMOTE_ENV.fakeUrl}/v26.0/${formId}/test_leads`, {
    method: "POST",
    headers: { authorization: `Bearer ${FAKE_PAGE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ field_data: fieldData }),
  });
  expect(res.ok, "the fake Meta server takes the test lead").toBe(true);
  return ((await res.json()) as { id: string }).id;
}

/**
 * No request reached a spend class at the fake (9.3): with SPEND_DRY_RUN=1 the ads client fakes every create, raise and
 * lowering, and promote code never sends one itself. WhatsApp sends and Meta limit writes are relayed apart, not counted.
 */
export async function expectNoSpendViolations(): Promise<void> {
  const v = await fake<{ spend: { method: string; pattern: string; class: string }[]; bannedPreviews: number }>("/__fake/violations");
  expect(v.spend, `promote calls that reached a spend class: ${v.spend.map((c) => `${c.method} ${c.pattern} (${c.class})`).join(", ")}`).toEqual([]);
  expect(v.bannedPreviews, "calls to the unscoped preview edge").toBe(0);
}

/** WhatsApp sends relayed by the fake since `before` (msg_send rows). */
export async function relayedSendsSince(before: number): Promise<FakeCall[]> {
  return (await fakeCalls()).slice(before).filter((c) => c.relayed && c.class === "msg_send");
}

// =====================================================================================================================
// Workspaces and Meta assets
// =====================================================================================================================

export type PromoteSeed = {
  owner: TestUser;
  connId: string;
  adAccount: { id: string; externalId: string };
  page: { id: string; externalId: string };
  ig: { id: string; externalId: string } | null;
  whatsapp: { pnRef: string; wabaId: string; phoneNumberId: string; display: string } | null;
};

export type SeedOptions = {
  /** Connect a fake WhatsApp number (chat goals, lead follow-ups). Default true. */
  whatsapp?: boolean;
  /** Link that number to the Page in Edwyz's records (the readiness row). Default true. */
  linkWhatsApp?: boolean;
  /** An Instagram professional account on the Page. Default true. */
  instagram?: boolean;
  /** setCap's C: the most the daily budgets may add up to, in minor units. Default ₹1,000 (100000). */
  maxDailyBudgetMinor?: number;
  currency?: string;
};

const ALL_SCOPES = ["business_management", "ads_management", "ads_read", "pages_show_list", "pages_read_engagement", "pages_manage_ads", "pages_manage_metadata", "leads_retrieval", "instagram_basic"];
export const FAKE_WHATSAPP_DISPLAY = "+15550001";

/**
 * Seeds a workspace for the promote flows: seedMeta's connection and assets, re-pointed at the fake's ad account (act_1), Page
 * and Instagram account with the fake's user and Page tokens; the ad account as the spending account (Asia/Kolkata), the
 * new-workspace limits lifted and setCap's limit; and, by default, a WhatsApp number linked to the Page.
 */
export async function seedPromote(owner: TestUser, opts: SeedOptions = {}): Promise<PromoteSeed> {
  const d = await db();
  const currency = opts.currency ?? "INR";
  const wantIg = opts.instagram !== false;
  const seeded = await seedMeta(owner, { currency, withPage: true, ig: wantIg });
  await d.query(`update "MetaConnection" set "tokenEnc" = $2, scopes = $3, "updatedAt" = now() where id = $1`, [seeded.connId, seal(owner.tenantId, FAKE_USER_TOKEN), ALL_SCOPES]);
  await d.query(`update "MetaAsset" set "externalId" = $2, "tokenEnc" = $3, meta = $4, "updatedAt" = now() where id = $1`, [
    seeded.adAccount.id,
    FAKE_ACT,
    seal(owner.tenantId, FAKE_USER_TOKEN),
    // What discovery stores for a healthy account: active, a payment method, the Custom Audience terms accepted.
    JSON.stringify({ currency, timezone: "Asia/Kolkata", accountStatus: 1, disableReason: 0, fundingPresent: true, customAudienceTos: true, userTosAccepted: true }),
  ]);
  const page = seeded.page!;
  await d.query(`update "MetaAsset" set "externalId" = $2, "tokenEnc" = $3, name = 'Fake Shop', meta = $4, "updatedAt" = now() where id = $1`, [
    page.id,
    FAKE_PAGE_ID,
    seal(owner.tenantId, FAKE_PAGE_TOKEN),
    JSON.stringify({ canAdvertise: true, leadgenTosAccepted: true, whatsappLinkState: "missing" }),
  ]);
  if (seeded.ig) {
    await d.query(`update "MetaAsset" set "externalId" = $2, "tokenEnc" = $3, meta = $4, "updatedAt" = now() where id = $1`, [
      seeded.ig.id,
      FAKE_IG_ID,
      seal(owner.tenantId, FAKE_PAGE_TOKEN),
      JSON.stringify({ username: "fakeshop", pageId: FAKE_PAGE_ID, profilePictureUrl: "https://scontent.example.com/pic/fakeshop.jpg", authorizedAdAccountIds: [FAKE_ACT] }),
    ]);
  }
  await seedSpendControl(owner.tenantId, { spendingAdAccountAssetId: seeded.adAccount.id, timezone: "Asia/Kolkata" });
  await liftNewWorkspaceLimits(owner.tenantId);
  await setCap(owner, opts.maxDailyBudgetMinor ?? 100_000, currency);
  let whatsapp: PromoteSeed["whatsapp"] = null;
  if (opts.whatsapp !== false) {
    const fx = await connectFakeNumber(owner.tenantId);
    whatsapp = { pnRef: fx.pnRef, wabaId: fx.wabaId, phoneNumberId: fx.phoneNumberId, display: FAKE_WHATSAPP_DISPLAY };
    if (opts.linkWhatsApp !== false) await setPageWhatsAppLink(page.id, true);
  }
  return {
    owner,
    connId: seeded.connId,
    adAccount: { id: seeded.adAccount.id, externalId: FAKE_ACT },
    page: { id: page.id, externalId: FAKE_PAGE_ID },
    ig: seeded.ig ? { id: seeded.ig.id, externalId: FAKE_IG_ID } : null,
    whatsapp,
  };
}

/**
 * Records the WhatsApp number as linked to the Page, or not, the way discovery stores it on the Page asset (`whatsappLinkState`,
 * which the readiness row reads, and `whatsappNumber`, which the smart defaults compare with the connected number).
 */
export async function setPageWhatsAppLink(pageAssetId: string, linked: boolean): Promise<void> {
  const patch = linked ? { whatsappNumber: FAKE_WHATSAPP_DISPLAY, whatsappLinkState: "ok" } : { whatsappLinkState: "missing" };
  await (await db()).query(`update "MetaAsset" set meta = (coalesce(meta, '{}'::jsonb) - 'whatsappNumber') || $2::jsonb, "updatedAt" = now() where id = $1`, [pageAssetId, JSON.stringify(patch)]);
}

/** A new owner, signed in through the browser context, with a seeded promote workspace. */
export async function promoteOwner(context: BrowserContext, label: string, opts: SeedOptions = {}): Promise<PromoteSeed> {
  const owner = await signupUser(context, label);
  // The welcome tour would cover the flows on a phone.
  await skipWelcome(context, owner.userId);
  return seedPromote(owner, opts);
}

/** A second member of the owner's workspace with the given role, signed in and switched to it in a fresh context. */
export async function memberOf(browser: Browser, owner: TestUser, role: "admin" | "agent", label: string = role): Promise<{ user: TestUser; context: BrowserContext; page: Page }> {
  const { context, user } = await joinWorkspace(browser, owner.tenantId, role, `prm-${label}`);
  const page = await context.newPage();
  return { user: { ...user, tenantId: owner.tenantId }, context, page };
}

/** The workspace's newest campaign made through the promote or Eddy surface. */
export async function latestPromoteCampaign(tenantId: string): Promise<{ id: string; status: string; reviewState: string | null; runDays: number | null; goal: string | null; surface: string } | null> {
  const { rows } = await (await db()).query(
    `select id, status, "reviewState", "runDays", goal, surface from "AdCampaign" where "tenantId" = $1 and surface in ('promote','eddy') and "discardedAt" is null order by "createdAt" desc limit 1`,
    [tenantId],
  );
  return rows[0] ?? null;
}

/** Waits until the workspace has a promote campaign in the given status (draft, paused, active...). */
export async function waitForCampaignStatus(tenantId: string, status: string): Promise<string> {
  let id = "";
  await expect
    .poll(
      async () => {
        const c = await latestPromoteCampaign(tenantId);
        id = c?.id ?? "";
        return c?.status ?? null;
      },
      { timeout: 30_000, message: `a promote campaign in status ${status}` },
    )
    .toBe(status);
  return id;
}

// =====================================================================================================================
// The flows (PromoteShell test ids, src/components/promote/flow-helpers.ts PROMOTE_TEST_IDS)
// =====================================================================================================================

export const ids = {
  shell: "promote-shell",
  primary: "promote-primary",
  secondary: "promote-secondary",
  stepCount: "promote-step-count",
  postGrid: "post-picker-grid",
  postTile: "post-tile",
  goalCard: "goal-card",
  readiness: "readiness-list",
  readinessRow: "readiness-row",
  review: "review-card",
  reviewState: "review-state",
  worstCase: "review-worst-case",
  worstCaseMonths: "review-worst-case-months",
  fixChips: "fix-chips",
  fixChip: "fix-chip",
  typedConfirm: "typed-confirm",
  welcome: "welcome-editor",
} as const;

/** Taps the bottom bar's primary and waits for the next step's heading to take focus. */
export async function next(page: Page): Promise<void> {
  const primary = page.getByTestId(ids.primary);
  await expect(primary).toBeEnabled();
  await primary.click();
}

/** Boost: the newest Instagram reel (the picker's Reels tab, newest first). */
export async function pickLatestReel(page: Page): Promise<void> {
  const reels = page.getByRole("tab", { name: t("picker.tab.reels") });
  if (await reels.isVisible().catch(() => false)) await reels.click();
  const tile = page.getByTestId(ids.postGrid).getByTestId(ids.postTile).first();
  await expect(tile).toBeVisible();
  await tile.click();
  await expect(tile).toHaveAttribute("aria-checked", "true");
}

export async function chooseGoal(page: Page, goal: string): Promise<void> {
  const card = page.locator(`[data-testid="${ids.goalCard}"][data-goal="${goal}"]`);
  await expect(card).toBeVisible();
  await card.click();
}

/** Steps forward until the review card shows (at most `max` taps), and returns it. */
export async function toReview(page: Page, max = 5) {
  const review = page.getByTestId(ids.review);
  for (let i = 0; i < max && !(await review.isVisible().catch(() => false)); i++) await next(page);
  await expect(review).toBeVisible();
  return review;
}

/** The Start button on the review step: aria-disabled for 600 ms after the card shows (D5), then it starts. */
export async function tapStart(page: Page): Promise<void> {
  const start = page.getByTestId(ids.primary);
  await expect(start).toHaveText(/Start|Create form and start/);
  await expect(start).not.toHaveAttribute("aria-disabled", "true", { timeout: 5_000 });
  await start.click();
}

/** The review card after Start: sent to Meta (state `done`, "Meta is reviewing it") or already running. */
export async function expectStarted(page: Page): Promise<void> {
  const state = page.getByTestId(ids.reviewState);
  await expect(state).toHaveAttribute("data-state", /^(done|running)$/, { timeout: 45_000 });
  await expect(state).toContainText(/Meta|Running/);
}

export const readinessRow = (page: Page, check: string) => page.locator(`[data-testid="${ids.readinessRow}"][data-check="${check}"]`);

/** Who and how much: "Instagram only" (the places chip, aria-pressed). */
export async function instagramOnly(page: Page): Promise<void> {
  const chip = page.getByRole("button", { name: t("placement.instagram_only") });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
}

// ----- A picture for a new ad -----

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A valid one-colour RGB PNG of the given size (4:5 at 1080 x 1350 by default): what a phone photo looks like to the probe. */
export function solidPng(width = 1080, height = 1350, rgb: [number, number, number] = [37, 99, 235]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

/** The ad step: uploads a picture through the media picker and waits until it is ready on the ad account. */
export async function uploadAdImage(page: Page, nth = 0): Promise<void> {
  const picker = page.getByTestId("media-picker").nth(nth);
  await expect(picker).toBeVisible();
  const uploadTab = picker.getByRole("tab", { name: /upload/i });
  if (await uploadTab.isVisible().catch(() => false)) await uploadTab.click();
  await picker.locator('input[type="file"]').setInputFiles({ name: "offer.png", mimeType: "image/png", buffer: solidPng() });
  await expect(picker.getByTestId("media-picker-chosen")).toHaveAttribute("data-status", "ready", { timeout: 45_000 });
}

/** `count` contacts with a recorded marketing opt-in (customer-list audiences count only these). */
export async function seedConsentedContacts(tenantId: string, count: number, optedOut = 0): Promise<void> {
  const d = await db();
  const tag = stamp();
  for (let i = 0; i < count + optedOut; i++) {
    await d.query(
      `insert into "Contact" (id,"tenantId",phone,name,"optIn","optInSource","optInAt","optedOutAt") values ($1,$2,$3,$4,true,'e2e',now(),$5)`,
      [`ct_prm_${tag}_${i}`, tenantId, `9198${String(tag).slice(-4)}${String(i).padStart(4, "0")}`, `Customer ${i + 1}`, i >= count ? new Date() : null],
    );
  }
}

// ----- Eddy -----

/** Switches Eddy on and acknowledges first use for the signed-in member; answers whether the scripted Eddy is ready. */
export async function eddyReady(context: BrowserContext, asOwner = true): Promise<boolean> {
  if (asOwner) await context.request.put("/api/eddy/settings", { headers: { origin: ORIGIN }, data: { enabled: true } });
  await context.request.put("/api/eddy/prefs", { headers: { origin: ORIGIN }, data: { firstUseAck: true } });
  const status = (await (await context.request.get("/api/eddy/status")).json().catch(() => ({}))) as { state?: string };
  return status.state === "ready";
}

/** Eddy's panel, opened from the top bar. */
export async function openEddy(page: Page) {
  await page.getByRole("banner").getByRole("button", { name: /^Ask Eddy/ }).click();
  const panel = page.getByRole("complementary", { name: "Eddy" });
  await expect(panel).toBeVisible();
  return panel;
}

/** Sends one message to Eddy and returns the panel. */
export async function tellEddy(page: Page, text: string) {
  const panel = page.getByRole("complementary", { name: "Eddy" });
  const box = panel.getByRole("textbox", { name: "Message to Eddy" });
  await box.fill(text);
  await box.press("Enter");
  return panel;
}

/**
 * The scripted Eddy (e2e/fixtures/eddy/promote-e2e.json) names fixed campaign ids, because a scripted round cannot read the
 * id an earlier tool call returned. This gives the workspace's newest promote draft that fixed id (AdSet rows follow through
 * ON UPDATE CASCADE), after removing whatever an earlier run left under it.
 */
export async function pinDraftId(tenantId: string, fixedId: string): Promise<void> {
  const d = await db();
  await d.query(`delete from "AdCampaign" where id = $1`, [fixedId]);
  const draft = await latestPromoteCampaign(tenantId);
  if (!draft) throw new Error("No promote draft to pin");
  await d.query(`update "AdCampaign" set id = $2 where id = $1 and "tenantId" = $3`, [draft.id, fixedId, tenantId]);
}

/** The scripted-start slot of this test: one per spec, role and Playwright project, so parallel projects never share one. */
export const eddySlot = (spec: "eddy" | "limits", role: "owner" | "admin", project: string) => `e2e_prm_${spec}_${project === "mobile" ? "mobile" : "desktop"}_${role}`;

/** Eddy's v2 cards (start_promotion) need EDDY_PHASE=2 and Eddy train E5 (docs/IG-PAGE-ADS-SPEC.md 9.7 P5). */
export const eddyV2 = (env: Env = process.env) => (env.EDDY_PHASE ?? "").trim() === "2";

// =====================================================================================================================
// Quality checks every 9.4 spec makes
// =====================================================================================================================

/** True when the page's own background is dark (relative luminance under 0.4). */
async function backgroundIsDark(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const parse = (c: string) => (c.match(/\d+(\.\d+)?/g) ?? ["255", "255", "255"]).slice(0, 3).map(Number);
    const bg = getComputedStyle(document.body).backgroundColor;
    const [r, g, b] = parse(bg).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.4;
  });
}

/** Switches the page to the dark theme, checks it is dark, and attaches a full-page screenshot to the report. */
export async function darkScreenshot(page: Page, testInfo: TestInfo, label: string): Promise<void> {
  await page.emulateMedia({ colorScheme: "dark" });
  const before = await page.evaluate(() => document.documentElement.dataset.theme ?? null);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  expect(await backgroundIsDark(page), `${label}: the dark theme should give a dark background`).toBe(true);
  const shot = await page.screenshot({ fullPage: true, animations: "disabled" });
  await testInfo.attach(`${label}-dark.png`, { body: shot, contentType: "image/png" });
  await page.evaluate((theme) => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, before);
  await page.emulateMedia({ colorScheme: null });
}

/**
 * 9.4 for every scenario: axe with no serious or critical findings, no sideways scroll at 360, 390 and 1280 px, and a
 * dark-theme screenshot. The viewport is put back afterwards.
 */
export async function checkPromoteQuality(page: Page, testInfo: TestInfo, label: string, opts: { include?: string } = {}): Promise<void> {
  expect(await axeSerious(page, opts.include), `axe: ${label}`).toEqual([]);
  const original = page.viewportSize();
  for (const width of [360, 390, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await overflowsX(page), `${label}: the page scrolls sideways at ${width} px`).toBe(false);
  }
  if (original) await page.setViewportSize(original);
  await darkScreenshot(page, testInfo, label);
}

// =====================================================================================================================
// Webhooks Meta would send (signed with META_APP_SECRET, like e2e/helpers.ts deliverInbound)
// =====================================================================================================================

const sign = (body: string) => `sha256=${createHmac("sha256", process.env.META_APP_SECRET ?? "").update(body).digest("hex")}`;

/** Meta's leadgen webhook for one lead (the app then reads the lead from the fake with the Page token). */
export async function deliverLeadgen(request: APIRequestContext, lead: { leadgenId: string; formId: string; pageId?: string; adId?: string }): Promise<void> {
  const value = { leadgen_id: lead.leadgenId, page_id: lead.pageId ?? FAKE_PAGE_ID, form_id: lead.formId, ...(lead.adId ? { ad_id: lead.adId } : {}), created_time: Math.floor(Date.now() / 1000) };
  const body = JSON.stringify({ object: "page", entry: [{ id: lead.pageId ?? FAKE_PAGE_ID, time: Math.floor(Date.now() / 1000), changes: [{ field: "leadgen", value }] }] });
  const res = await request.post("/webhooks/leads", { headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) }, data: body });
  expect(res.status(), "leadgen webhook").toBe(200);
}

/** A WhatsApp message that came from a Click-to-WhatsApp ad (the `referral` block Meta adds). */
export async function deliverReferral(request: APIRequestContext, fx: { wabaId: string; phoneNumberId: string }, from: string, adMetaId: string, text = "Hi, I saw your ad"): Promise<void> {
  const value = {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "15550001", phone_number_id: fx.phoneNumberId },
    contacts: [{ profile: { name: "Ad Customer" }, wa_id: from }],
    messages: [
      {
        from,
        id: `wamid.prm${stamp()}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: "text",
        text: { body: text },
        referral: { source_url: "https://fb.me/prm-e2e", source_id: adMetaId, source_type: "ad", headline: "Fake Shop", body: "Chat with us", ctwa_clid: `clid_${stamp()}` },
      },
    ],
  };
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: fx.wabaId, changes: [{ field: "messages", value }] }] });
  const res = await request.post("/webhooks/whatsapp", { headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) }, data: body });
  expect(res.ok(), "WhatsApp webhook").toBe(true);
}

/** Same-origin JSON call as the signed-in member of `request`'s context. */
export async function api<T>(request: APIRequestContext, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, data?: unknown): Promise<{ status: number; body: T }> {
  const res = await request.fetch(path, { method, headers: { origin: ORIGIN, "content-type": "application/json" }, data: data === undefined ? undefined : JSON.stringify(data) });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status(), body: body as T };
}

export { BASE };
