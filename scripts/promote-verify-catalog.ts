/**
 * The sandbox verification runbook's script (docs/IG-PAGE-ADS-SPEC.md 9.6, 8.1 item 5, 11.1a decision 6, PRM-16; the steps,
 * commands and pass criteria are in docs/promote-verification-runbook.md).
 *
 * It runs the V-P steps that a Meta sandbox ad account can answer, against MetaAsset.sandbox only:
 * - Every object it makes is named with the "PRM-VERIFY " prefix. Campaigns, ad sets and ads are created PAUSED through
 *   Phase 0's ads client under permitForPausedCreate's create permit, read back, and archived through recordLowering. Creatives
 *   carry no status (erratum 12.1b) and are deleted; audiences and videos are deleted. Lead forms are archived with the Page
 *   token under the Book's lead-form lowering when it has one (BookPort.lowerLeadForm), and never through an ad-level ledger
 *   row; until Phase 0's Book offers that call they are kept and listed. Pixels, images and the Page-backed Instagram identity
 *   cannot be deleted through the API, so they stay, named and listed in the report.
 * - It never activates anything and never raises a budget: every request is classified first (src/lib/spend/classify.ts), and
 *   only reads, PAUSED creates (ads_create), archives (ads_lowering) and not-spend writes are sent. Anything else is refused
 *   before it leaves the process.
 * - It refuses an ad account that is not a Meta sandbox account (MetaAsset.sandbox), and any run alongside Phase 0's runbook:
 *   the shared sandbox lock (PlatformSetting `sandbox:runbook-lock`) held by anyone else, including another promote run (each
 *   run holds it under its own name, `promote:<run id>:<nonce>@<host>`); SPEND_SIM=1 in this shell; or, in any workspace that
 *   has the same sandbox ad account connected, Phase 0 sim rows or Spend Book rows for the sandbox from anyone but this script
 *   in the last 2 hours.
 * - V-P16 (a person opens each Opens Meta link) and V-P17 (the owner-present live check on a real INR account) are manual:
 *   the script lists them and never runs them.
 *
 * With --write it records what passed: one pinned fake-Meta fixture per step and run for the checks that passed
 * (tests/fixtures/promote-verified/<step>.<run id>.json), the run report (run-report-<run id>.json), and
 * src/lib/promote/catalog/verified.ts regenerated so that only the catalog rows whose every runbook step passed move from `docs`
 * to `sandbox` (rows never move down; `live` waits for V-P17). A failed row stays at `docs`, so its goal stays out of
 * PROMOTE_GOALS. Each run writes its own files, so a later partial run never replaces the evidence of an earlier one.
 *
 * --dry-run answers every Graph call from the in-process fake Meta (tests/helpers/fake-meta-promote.ts) with the fake's ids and
 * tokens, so the runbook can be rehearsed without Meta. It still checks the account is marked sandbox and still takes the lock.
 * Its Spend Book reads the database but writes nothing (readOnlyDb). It writes only to the paths given explicitly, refuses any
 * path inside a project or repository checkout, and stamps the verified.ts it writes as dry-run output.
 *
 * Run (the esbuild pattern of scripts/spend-sim.ts):
 *   npx esbuild scripts/promote-verify-catalog.ts --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/edwyz-verify/promote-verify.mjs
 *   node node_modules/.cache/edwyz-verify/promote-verify.mjs --tenant <tenantId> --account <ad account MetaAsset id> --page <Page MetaAsset id>
 *        [--instagram <Instagram MetaAsset id>] [--whatsapp-number <E.164 digits, linked to the Page>]
 *        [--unlinked-whatsapp-number <E.164 digits, same portfolio, not linked>] [--video-url <https url>] [--steps V-P0,V-P1,...]
 *        [--operator "<name>"] [--write] [--dry-run --verified-path <file> --fixtures-dir <dir> --report <file>]
 * A flag given twice counts once, with its last value.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { adsClient } from "@/lib/ads/client";
import { GraphError, graphFetchAs } from "@/lib/graph";
import { AUDIENCE_EVENTS } from "@/lib/promote/catalog/audience-events";
import { CTA_BY_GOAL, LEAD_FORM_LINK, WHATSAPP_LINK } from "@/lib/promote/catalog/cta";
import { GOALS, type GoalRow } from "@/lib/promote/catalog/goals";
import { LEAD_QUESTIONS } from "@/lib/promote/catalog/lead-questions";
import { PLACEMENTS, type PlacementRow } from "@/lib/promote/catalog/placements";
import { META_PREVIEW_FORMATS } from "@/lib/promote/catalog/preview-formats";
import { OPTED_OUT_FEATURES, optOutSpec } from "@/lib/promote/creative-shapes";
import { classify, type CreateKind } from "@/lib/spend/classify";
import type { AdsGuard, AdsLoweringIntent, CreatePermit, GraphSpendClass, LoweringPermit, SpendActor } from "@/lib/spend/types";
import type { FakeMetaPromote } from "../tests/helpers/fake-meta-promote";

type Json = Record<string, unknown>;
type Env = Record<string, string | undefined>;

// =====================================================================================================================
// Steps, rows and names
// =====================================================================================================================

/** Every object this script makes starts with this name, so Phase 0's runbook and people can tell them apart (9.6). */
export const VERIFY_PREFIX = "PRM-VERIFY ";

/** The runbook steps (9.6). The addenda are written V-P1+, V-P7+ and V-P12+. */
export const STEP_IDS = [
  "V-P0", "V-P1", "V-P1+", "V-P2", "V-P3", "V-P4", "V-P5", "V-P6", "V-P7", "V-P7+", "V-P8", "V-P9", "V-P10",
  "V-P11", "V-P12", "V-P12+", "V-P13", "V-P14", "V-P15", "V-P16", "V-P17", "V-P18",
] as const;
export type StepId = (typeof STEP_IDS)[number];

/** Run by people, never by this script. */
export const MANUAL_STEPS: Readonly<Partial<Record<StepId, string>>> = {
  "V-P16": "A person opens every Opens Meta link in src/lib/meta-connect/meta-screens.ts while signed in to Meta and records that each lands on the right screen.",
  "V-P17": "The owner-present live check on one real INR ad account (Rs 100 a day for 2 days). Never run by this script, which only touches sandbox accounts.",
};

/** The order the automated steps run in: V-P18 first, so later steps can use its pixel; V-P7 before V-P3's lead-form button. */
const RUN_ORDER: readonly StepId[] = ["V-P0", "V-P18", "V-P1", "V-P1+", "V-P2", "V-P7", "V-P7+", "V-P3", "V-P4", "V-P5", "V-P6", "V-P8", "V-P9", "V-P10", "V-P11", "V-P12", "V-P12+", "V-P13", "V-P14", "V-P15"];

const STEP_TITLES: Readonly<Record<StepId, string>> = {
  "V-P0": "act_X/adcreatives accepts a body without status",
  "V-P1": "Each goal's campaign and ad set pairing, and special_ad_category_country",
  "V-P1+": "A daily-budget ad set of 24 hours or less is refused (D31)",
  "V-P2": "The Instagram media boost and the Facebook promotable post boost; is_instagram_eligible",
  "V-P3": "A WhatsApp, website, form or profile button on boosted posts",
  "V-P4": "The Click-to-Instagram button, the Instagram profile destination, ice breakers",
  "V-P5": "generatepreviews for each ad_format on unsaved specs; the iframe host",
  "V-P6": "adimages with bytes, carousels, advideos with file_url and thumbnails",
  "V-P7": "leadgen_forms create, test_leads, and the lead fields platform, is_organic and adset_id",
  "V-P7+": "The test_leads answer, the optional unticked consent box",
  "V-P8": "customaudiences: a customer list with a users session, a lookalike, every engagement and website rule",
  "V-P9": "creative_features_spec feature names",
  "V-P10": "reachestimate, PIN code search, minimum_budgets",
  "V-P11": "connected_instagram_accounts",
  "V-P12": "The Page's WhatsApp number field",
  "V-P12+": "A portfolio WhatsApp number not linked to the Page as promoted_object.whatsapp_phone_number",
  "V-P13": "page_backed_instagram_accounts and its use in a creative",
  "V-P14": "Effective placements read back",
  "V-P15": "asset_feed_spec placement customization",
  "V-P16": "The Opens Meta URL templates",
  "V-P17": "Owner-present live check",
  "V-P18": "A pixel through the API, and its code",
};

const ROW_STEPS_FIXED: Readonly<Record<string, readonly string[]>> = {
  "shape.fb_post_boost": ["V-P2"],
  "shape.ig_media_boost": ["V-P2"],
  "shape.single_image": ["V-P0", "V-P6"],
  "shape.single_video": ["V-P6"],
  "shape.carousel": ["V-P6"],
  "shape.placement_assets": ["V-P15"],
  "feature.enhancements": ["V-P9"],
  "feature.ice_breakers": ["V-P4"],
  "feature.page_backed_instagram": ["V-P13"],
  "feature.previews": ["V-P5"],
};

/** The runbook steps a verified.ts row needs, from the catalog itself (goal, placement and question rows carry verifyRefs). */
export function rowRefs(key: string): readonly string[] | null {
  const dot = key.indexOf(".");
  const kind = key.slice(0, dot);
  const id = key.slice(dot + 1);
  if (kind === "goal") return GOALS.find((g) => g.key === id)?.verifyRefs ?? null;
  if (kind === "placement") return PLACEMENTS.find((p) => p.key === id)?.verifyRefs ?? null;
  if (kind === "question") return LEAD_QUESTIONS.find((q) => q.type === id)?.verifyRefs ?? null;
  if (kind === "audience_event") return AUDIENCE_EVENTS.some((e) => e.id === id) ? ["V-P8"] : null;
  if (kind === "boost_cta") return id in CTA_BY_GOAL ? ["V-P3"] : null;
  return ROW_STEPS_FIXED[key] ?? null;
}

// =====================================================================================================================
// Results
// =====================================================================================================================

export type CheckResult = { id: string; passed: boolean; rows: string[]; evidence: Json; error?: Json; skipped?: string };
export type CallRecord = { step: StepId; check: string; method: string; pattern: string; class: GraphSpendClass; ok: boolean; request?: unknown; response?: unknown; error?: Json };
export type StepStatus = "passed" | "failed" | "skipped" | "manual";
export type StepResult = { step: StepId; title: string; status: StepStatus; checks: CheckResult[]; calls: CallRecord[]; leftBehind: string[]; kept: string[]; note?: string };

/** A step passes when it ran at least one check and every check passed. */
export const stepPassed = (r: StepResult | undefined): boolean => !!r && r.status === "passed";

/**
 * The rows that may move to `sandbox`: every runbook step of the row ran; when a check names the row, all such checks passed,
 * otherwise the whole step passed. A row whose steps include a manual one (V-P16, V-P17) never moves here.
 */
export function passedRows(results: readonly StepResult[], keys: readonly string[]): Set<string> {
  const byStep = new Map(results.map((r) => [r.step as string, r]));
  const out = new Set<string>();
  for (const key of keys) {
    const refs = rowRefs(key);
    if (!refs || refs.length === 0) continue;
    const ok = refs.every((s) => {
      const r = byStep.get(s);
      if (!r || r.status === "manual" || r.status === "skipped") return false;
      const own = r.checks.filter((c) => c.rows.includes(key));
      return own.length > 0 ? own.every((c) => c.passed) : stepPassed(r);
    });
    if (ok) out.add(key);
  }
  return out;
}

const ROW_LINE = /^(\s*)"([a-z_]+\.[A-Za-z0-9_]+)": "(docs|sandbox|live)",\s*$/;

/** The rows and states of a verified.ts source. */
export function readVerifiedRows(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of source.split(/\r?\n/)) {
    const m = ROW_LINE.exec(line);
    if (m) out.set(m[2], m[3]);
  }
  return out;
}

/** Every verified.ts a dry run writes carries this tag; the committed file never may (tests/promote-verify-script.test.ts). */
export const DRY_RUN_TAG = "PRM-VERIFY DRY RUN";
export const DRY_RUN_MARKER = `// ${DRY_RUN_TAG}: written by scripts/promote-verify-catalog.ts --dry-run from fake-Meta answers. It proves nothing. Never commit it.`;

/**
 * verified.ts with the given rows moved from `docs` to `sandbox` (never down, never to `live`), the header and
 * VERIFIED_GENERATED_AT stamped, and VERIFIED_RUNBOOK_STEPS the union of what was there and the steps that passed now.
 * A dry run's text starts with DRY_RUN_MARKER; a sandbox run refuses a source that carries it.
 * Throws when the source is not the generated file's shape, so nothing half-written is saved.
 */
export function regenerateVerified(source: string, rows: ReadonlySet<string>, steps: readonly string[], at: Date, opts: { dryRun?: boolean } = {}): { text: string; moved: string[] } {
  if (!/export const VERIFIED: Readonly<Record<string, VerifyState>> = \{/.test(source) || !/export const VERIFIED_RUNBOOK_STEPS: readonly string\[\] = \[[^\]]*\];/.test(source) || !/export const VERIFIED_GENERATED_AT: string \| null = [^;]+;/.test(source)) {
    throw new Error("verified.ts is not in the generated shape; it was not changed.");
  }
  if (!opts.dryRun && source.includes(DRY_RUN_TAG)) {
    throw new Error("verified.ts holds a dry run's output (fake-Meta answers). Restore it from the repository before a sandbox run; it was not changed.");
  }
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const moved: string[] = [];
  const lines = source.split(/\r?\n/).map((line) => {
    const m = ROW_LINE.exec(line);
    if (!m || m[3] !== "docs" || !rows.has(m[2])) return line;
    moved.push(m[2]);
    return `${m[1]}"${m[2]}": "sandbox",`;
  });
  const previous = /export const VERIFIED_RUNBOOK_STEPS: readonly string\[\] = \[([^\]]*)\];/.exec(source)![1];
  const had = [...previous.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const union = STEP_IDS.filter((s) => had.includes(s) || steps.includes(s));
  const stamp = at.toISOString();
  let text = lines.join(eol);
  text = text.replace(/^\/\/ generatedAt: .*$/m, `// generatedAt: ${stamp} (scripts/promote-verify-catalog.ts)`);
  text = text.replace(/^\/\/ runbook steps passed: .*$/m, `// runbook steps passed: ${union.length ? union.join(", ") : "none"}`);
  text = text.replace(/export const VERIFIED_GENERATED_AT: string \| null = [^;]+;/, `export const VERIFIED_GENERATED_AT: string | null = ${JSON.stringify(stamp)};`);
  text = text.replace(/export const VERIFIED_RUNBOOK_STEPS: readonly string\[\] = \[[^\]]*\];/, `export const VERIFIED_RUNBOOK_STEPS: readonly string[] = [${union.map((s) => JSON.stringify(s)).join(", ")}];`);
  if (opts.dryRun && !text.includes(DRY_RUN_TAG)) text = `${DRY_RUN_MARKER}${eol}${text}`;
  return { text, moved };
}

// =====================================================================================================================
// Refusals and the guarded ports
// =====================================================================================================================

/** The script will not do this; nothing was sent. */
export class VerifyRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyRefusal";
  }
}

class CheckFailed extends Error {
  constructor(message: string, public evidence: Json = {}) {
    super(message);
  }
}
class CheckSkipped extends Error {}

/** Classes this script never sends: an activation, a raise or an unknown write, Meta's limit, a WhatsApp message. */
export const FORBIDDEN_CLASSES: ReadonlySet<GraphSpendClass> = new Set<GraphSpendClass>(["ads_raise_or_unknown", "meta_cap", "msg_send"]);
/** Not-spend creates that make a named object: the name must carry the prefix too. */
const NAMED_EDGES = new Set(["leadgen_forms", "customaudiences", "adspixels", "advideos", "adimages"]);

export type Token = "user" | "page";

/** What the steps can do. Each implementation classifies first and refuses anything else. */
export type VerifyPorts = {
  get<T = Json>(path: string, query?: Record<string, string>, token?: Token): Promise<T>;
  /** A PAUSED campaign, ad set or ad, or a creative without a status, through Phase 0's ads client and a create permit. */
  createPaused(kind: CreateKind, body: Json): Promise<string>;
  /** A write classify() calls not_spend (forms, test leads, images, videos, audiences and their rows, pixels, identities). */
  post<T = Json>(path: string, body: Json, token?: Token): Promise<T>;
  remove(path: string, token?: Token): Promise<void>;
  /** A campaign, ad set or ad, set to ARCHIVED: a lowering, ledgered through recordLowering. */
  archive(metaId: string): Promise<void>;
  /**
   * A lead form set to ARCHIVED with the Page token (Meta manages forms with the Page token), under the Book's lead-form
   * lowering and never through an ad-level ledger row. False, and nothing sent, when the Book has no lead-form lowering yet:
   * the form is then kept and listed (a form cannot spend).
   */
  archiveForm(formId: string): Promise<boolean>;
};

/** The Spend Book calls the ports use (src/lib/spend/book.ts). */
export type BookPort = {
  permitForPausedCreate(tenantId: string, adAccountExternalId: string, objectCount: number, actor: SpendActor): Promise<CreatePermit>;
  recordLowering(tenantId: string, intent: AdsLoweringIntent, actor: SpendActor, reason: string, run: (permit: LoweringPermit) => Promise<void>, opts?: { reasonCodes?: string[] }): Promise<unknown>;
  /**
   * A lowering permit for archiving a lead form (targetType lead_form), with no ads ledger row. Phase 0's Book has no such call
   * yet (handed to the Phase 0 owner); without it the script keeps its forms rather than log an ad archive for a form id.
   */
  lowerLeadForm?(tenantId: string, formId: string, actor: SpendActor, run: (permit: LoweringPermit) => Promise<void>): Promise<unknown>;
};

export const VERIFY_JOB = "promote-verify-catalog";
/** Stored in the Spend Book as actorType system, actorId promote-verify-catalog. */
export const VERIFY_ACTOR: SpendActor = { type: "system", job: VERIFY_JOB };

/** Checks a create body before anything else: the prefix, PAUSED for campaigns, ad sets and ads, no status on a creative. */
export function assertVerifyBody(kind: CreateKind, body: Json): void {
  if (typeof body.name !== "string" || !body.name.startsWith(VERIFY_PREFIX)) throw new VerifyRefusal(`Every object needs a name starting with "${VERIFY_PREFIX}".`);
  if (kind === "adcreatives") {
    if ("status" in body) throw new VerifyRefusal("A creative carries no status (erratum 12.1b).");
    return;
  }
  if (body.status !== "PAUSED") throw new VerifyRefusal("Campaigns, ad sets and ads are created PAUSED, never ACTIVE.");
  for (const k of ["configured_status", "effective_status", "status_option"]) if (k in body && body[k] !== "PAUSED") throw new VerifyRefusal("Campaigns, ad sets and ads are created PAUSED, never ACTIVE.");
}

const SECRET_KEY = /token|secret|appsecret_proof|password/i;

/** A copy safe to pin in a fixture: no credentials, short strings, large uploads and hash lists summarised. */
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 12) return "<deep>";
  if (typeof value === "string") return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
  if (Array.isArray(value)) return value.length > 50 ? [...value.slice(0, 5).map((v) => sanitize(v, depth + 1)), `<${value.length - 5} more>`] : value.map((v) => sanitize(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Json = {};
    for (const [k, v] of Object.entries(value as Json)) {
      if (SECRET_KEY.test(k)) continue;
      out[k] = k === "bytes" && typeof v === "string" ? `<${v.length} base64 characters>` : sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

function errorOf(e: unknown): Json {
  if (e instanceof GraphError) return { status: e.status, code: e.code ?? null, subcode: e.subcode ?? null, message: e.message };
  if (e instanceof Error) return { message: e.message };
  return { message: String(e) };
}

export type PortsInput = {
  tenantId: string;
  adAccountAssetId: string;
  /** act_<id> */
  act: string;
  userToken: string;
  pageToken: string;
  book: BookPort;
  /** Records each call made (the fixture). */
  record: (r: Omit<CallRecord, "step" | "check">) => void;
};

/** The ports over Phase 0's ads client and the Graph client: classified, recorded and refused when outside the four kinds. */
export function guardedPorts(input: PortsInput): VerifyPorts {
  const { tenantId, act, book } = input;
  const guard: AdsGuard = { tenantId, adAccountAssetId: input.adAccountAssetId, actor: VERIFY_ACTOR, sandbox: true };
  // An empty environment: SPEND_DRY_RUN or SPEND_SIM must never turn these writes into local fakes, or nothing is verified.
  const client = adsClient(input.userToken, act, guard, { env: {} });
  // Lead forms belong to the Page: their status changes go with the Page token, under the permit the Book gives.
  const pageClient = adsClient(input.pageToken, act, guard, { env: {} });
  const tokenOf = (t?: Token) => (t === "page" ? input.pageToken : input.userToken);

  async function send<T>(method: "GET" | "POST" | "DELETE", p: string, body: Json | undefined, query: Record<string, string> | undefined, allowed: readonly GraphSpendClass[], run: () => Promise<T>): Promise<T> {
    const c = classify({ method, path: p, query: query ?? null, body });
    if (FORBIDDEN_CLASSES.has(c.class) || !allowed.includes(c.class)) {
      throw new VerifyRefusal(`${method} ${c.pattern} is ${c.class}. This script only reads, creates PAUSED, archives and makes not-spend writes.`);
    }
    try {
      const out = await run();
      input.record({ method, pattern: c.pattern, class: c.class, ok: true, request: sanitize(body ?? query ?? null), response: sanitize(out) });
      return out;
    } catch (e) {
      input.record({ method, pattern: c.pattern, class: c.class, ok: false, request: sanitize(body ?? query ?? null), error: errorOf(e) });
      throw e;
    }
  }

  return {
    get: (p, query, token) => send("GET", p, undefined, query, ["not_spend"], () => graphFetchAs(tokenOf(token), { path: p, method: "GET", query })),
    async createPaused(kind, body) {
      assertVerifyBody(kind, body);
      const permit = await book.permitForPausedCreate(tenantId, act, 1, VERIFY_ACTOR);
      return send("POST", `${act}/${kind}`, body, undefined, ["ads_create"], () => {
        if (kind === "campaigns") return client.createCampaign(body, permit);
        if (kind === "adsets") return client.createAdSet(body, permit);
        if (kind === "ads") return client.createAd(body, permit);
        return client.createCreative(body, permit);
      });
    },
    async post(p, body, token) {
      const edge = p.split("/").pop() ?? "";
      if (NAMED_EDGES.has(edge) && (typeof body.name !== "string" || !body.name.startsWith(VERIFY_PREFIX))) throw new VerifyRefusal(`Every object needs a name starting with "${VERIFY_PREFIX}".`);
      return send("POST", p, body, undefined, ["not_spend"], () => graphFetchAs(tokenOf(token), { path: p, method: "POST", body }));
    },
    async remove(p, token) {
      await send("DELETE", p, undefined, undefined, ["not_spend"], () => graphFetchAs(tokenOf(token), { path: p, method: "DELETE" }));
    },
    async archive(metaId) {
      await send("POST", metaId, { status: "ARCHIVED" }, undefined, ["ads_lowering"], async () => {
        await book.recordLowering(tenantId, { kind: "archive", metaObjectId: metaId }, VERIFY_ACTOR, "PRM-VERIFY: archived a sandbox runbook object.", (permit) => client.setStatus(metaId, "ARCHIVED", permit), { reasonCodes: ["prm_verify", "sandbox"] });
        return { archived: true };
      });
    },
    async archiveForm(formId) {
      const lower = book.lowerLeadForm?.bind(book);
      if (!lower) return false;
      await send("POST", formId, { status: "ARCHIVED" }, undefined, ["ads_lowering"], async () => {
        await lower(tenantId, formId, VERIFY_ACTOR, (permit) => pageClient.setStatus(formId, "ARCHIVED", permit));
        return { archived: true };
      });
      return true;
    },
  };
}

// =====================================================================================================================
// The steps
// =====================================================================================================================

type TrackKind = "campaign" | "adset" | "ad" | "creative" | "form" | "audience" | "video";
const ARCHIVED_KINDS = new Set<TrackKind>(["ad", "adset", "campaign"]);
const CLEANUP_ORDER: readonly TrackKind[] = ["ad", "creative", "adset", "campaign", "form", "audience", "video"];

type Ctx = {
  ports: VerifyPorts;
  act: string;
  pageId: string;
  igId: string | null;
  /** The test WhatsApp number linked to the Page (V-P1's chat goals, V-P12). */
  whatsappNumber: string | null;
  /** A number in the same business portfolio that is not linked to the Page (V-P12+). */
  unlinkedWhatsappNumber: string | null;
  videoUrl: string | null;
  pixelId: string | null;
  runId: string;
  now: Date;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  /** Set while a step runs. */
  tracked: { kind: TrackKind; id: string }[];
  kept: string[];
  checks: CheckResult[];
  check: string;
  /** Shared between steps of one run. */
  memo: { reel?: Json | null; post?: Json | null; images?: string[]; testLead?: Json; pixelLooked?: boolean };
};

const TEST_LINK = "https://example.com/prm-verify";
const TEST_PRIVACY = "https://example.com/privacy";
const TEST_TEXT = "PRM-VERIFY sandbox check. This ad never runs.";
const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "+0000");
const digitsOf = (v: unknown) => String(v ?? "").replace(/\D/g, "");
const name = (ctx: Ctx, label: string) => `${VERIFY_PREFIX}${ctx.runId} ${label}`;

/** Creates through the ports, tracks the object for cleanup, and reads a campaign, ad set or ad back PAUSED at once. */
async function create(ctx: Ctx, kind: CreateKind, body: Json): Promise<string> {
  const id = await ctx.ports.createPaused(kind, body);
  ctx.tracked.push({ kind: kind === "campaigns" ? "campaign" : kind === "adsets" ? "adset" : kind === "ads" ? "ad" : "creative", id });
  if (kind !== "adcreatives") await readBack(ctx, id, ["id", "name", "status"], { name: body.name });
  return id;
}

async function check(ctx: Ctx, id: string, rows: string[], fn: () => Promise<Json>): Promise<boolean> {
  ctx.check = id;
  try {
    const evidence = await fn();
    ctx.checks.push({ id, passed: true, rows, evidence: sanitize(evidence) as Json });
    return true;
  } catch (e) {
    if (e instanceof VerifyRefusal) throw e;
    if (e instanceof CheckSkipped) ctx.checks.push({ id, passed: false, rows, evidence: {}, skipped: e.message });
    else ctx.checks.push({ id, passed: false, rows, evidence: e instanceof CheckFailed ? (sanitize(e.evidence) as Json) : {}, error: errorOf(e) });
    return false;
  } finally {
    ctx.check = "setup";
  }
}

/** Reads an object back. PAUSED objects must read back PAUSED; each expected field that comes back must match. */
async function readBack(ctx: Ctx, id: string, fields: readonly string[], expected: Json = {}, opts: { paused?: boolean; token?: Token } = {}): Promise<Json> {
  const got = await ctx.ports.get<Json>(id, { fields: fields.join(",") }, opts.token);
  const mismatches: string[] = [];
  if (got?.id !== undefined && String(got.id) !== String(id)) mismatches.push("id");
  if (opts.paused !== false && got?.status !== undefined && got.status !== "PAUSED") mismatches.push(`status ${String(got.status)}`);
  for (const [k, v] of Object.entries(expected)) if (got && k in got && JSON.stringify(got[k]) !== JSON.stringify(v)) mismatches.push(k);
  if (!got || got.id === undefined) throw new CheckFailed("Meta did not read the object back.", { got });
  if (mismatches.length) throw new CheckFailed(`Read back differs: ${mismatches.join(", ")}.`, { got, expected });
  return got;
}

const campaignBody = (ctx: Ctx, label: string, objective: string, extra: Json = {}): Json => ({
  name: name(ctx, label),
  objective,
  status: "PAUSED",
  special_ad_categories: [],
  is_adset_budget_sharing_enabled: false,
  buying_type: "AUCTION",
  ...extra,
});

const BASE_TARGETING: Json = { geo_locations: { countries: ["IN"] }, age_min: 18, targeting_automation: { advantage_audience: 1 } };

function adSetBody(ctx: Ctx, label: string, campaignId: string, opts: { optimization: string; destination?: string | null; promoted?: Json | null; hours?: number; targeting?: Json }): Json {
  const start = new Date(ctx.now.getTime() + 3_600_000);
  return {
    name: name(ctx, label),
    campaign_id: campaignId,
    status: "PAUSED",
    daily_budget: 20_000,
    billing_event: "IMPRESSIONS",
    optimization_goal: opts.optimization,
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    ...(opts.destination ? { destination_type: opts.destination } : {}),
    ...(opts.promoted ? { promoted_object: opts.promoted } : {}),
    targeting: opts.targeting ?? BASE_TARGETING,
    start_time: iso(start),
    end_time: iso(new Date(start.getTime() + (opts.hours ?? 72) * 3_600_000)),
  };
}

function promotedObject(ctx: Ctx, g: GoalRow): Json {
  const out: Json = { ...(g.promotedObjectFixed ?? {}) };
  for (const key of g.promotedObject) {
    if (key === "page_id") out.page_id = ctx.pageId;
    else if (key === "whatsapp_phone_number") {
      if (!ctx.whatsappNumber) throw new CheckSkipped("Needs --whatsapp-number (the test WhatsApp number linked to the Page).");
      out.whatsapp_phone_number = ctx.whatsappNumber;
    } else if (key === "pixel_id") {
      if (!ctx.pixelId) throw new CheckSkipped("Needs a pixel on the ad account (V-P18 makes one).");
      out.pixel_id = ctx.pixelId;
    } else if (key === "custom_event_type" && out.custom_event_type === undefined) out.custom_event_type = "PURCHASE";
  }
  return out;
}

function linkCreative(ctx: Ctx, label: string, extra: Json = {}, linkData: Json = {}): Json {
  return {
    name: name(ctx, label),
    object_story_spec: {
      page_id: ctx.pageId,
      ...(ctx.igId ? { instagram_user_id: ctx.igId } : {}),
      link_data: { link: TEST_LINK, message: TEST_TEXT, ...(ctx.memo.images?.[0] ? { image_hash: ctx.memo.images[0] } : {}), ...linkData },
    },
    degrees_of_freedom_spec: optOutSpec(),
    ...extra,
  };
}

const CREATIVE_FIELDS = ["id", "name", "object_story_spec", "call_to_action_type"] as const;

async function latestReel(ctx: Ctx): Promise<Json> {
  if (ctx.memo.reel === undefined) {
    if (!ctx.igId) ctx.memo.reel = null;
    else {
      const res = await ctx.ports.get<{ data?: Json[] }>(`${ctx.igId}/media`, { fields: "id,media_type,media_product_type,boost_eligibility_info", limit: "10" }, "page");
      const rows = Array.isArray(res?.data) ? res.data : [];
      ctx.memo.reel = rows.find((m) => m.media_product_type === "REELS") ?? rows[0] ?? null;
    }
  }
  if (!ctx.memo.reel) throw new CheckSkipped("Needs an Instagram account with at least one post (--instagram).");
  return ctx.memo.reel;
}

async function latestPost(ctx: Ctx): Promise<Json> {
  if (ctx.memo.post === undefined) {
    const res = await ctx.ports.get<{ data?: Json[] }>(`${ctx.pageId}/published_posts`, { fields: "id,is_eligible_for_promotion,promotable_id", limit: "10" }, "page");
    const rows = Array.isArray(res?.data) ? res.data : [];
    ctx.memo.post = rows.find((p) => p.is_eligible_for_promotion !== false) ?? null;
  }
  if (!ctx.memo.post) throw new CheckSkipped("Needs a published post on the test Page that can be promoted.");
  return ctx.memo.post;
}

/** A one-colour RGB PNG (the probe and Meta only need a real image). */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function uploadImage(ctx: Ctx, label: string, w: number, h: number, rgb: [number, number, number]): Promise<string> {
  const res = await ctx.ports.post<{ images?: Record<string, { hash?: string }> }>(`${ctx.act}/adimages`, { name: name(ctx, label), bytes: solidPng(w, h, rgb).toString("base64") });
  const hash = Object.values(res?.images ?? {})[0]?.hash;
  if (typeof hash !== "string" || !hash) throw new CheckFailed("adimages answered without an image hash.", { res });
  ctx.memo.images = [...(ctx.memo.images ?? []), hash];
  return hash;
}

const CTA_VALUE = (ctx: Ctx, goal: string, formId: string | null): Json | null => {
  const spec = CTA_BY_GOAL[goal as keyof typeof CTA_BY_GOAL];
  if (spec.valueFrom === "lead_form") return formId ? { lead_gen_form_id: formId, link: LEAD_FORM_LINK } : null;
  if (spec.valueFrom === "page") return { page: ctx.pageId };
  if (spec.fixedLink === WHATSAPP_LINK) return { ...spec.value, link: WHATSAPP_LINK };
  return { ...spec.value, link: TEST_LINK };
};

function leadForm(ctx: Ctx, label: string, questions: Json[], extra: Json = {}): Json {
  return { name: name(ctx, label), questions, privacy_policy: { url: TEST_PRIVACY, link_text: "Privacy policy" }, follow_up_action_url: TEST_LINK, locale: "en_US", ...extra };
}

async function makeForm(ctx: Ctx, label: string, questions: Json[], extra: Json = {}): Promise<string> {
  const res = await ctx.ports.post<{ id?: string }>(`${ctx.pageId}/leadgen_forms`, leadForm(ctx, label, questions, extra), "page");
  if (typeof res?.id !== "string") throw new CheckFailed("leadgen_forms answered without an id.", { res });
  ctx.tracked.push({ kind: "form", id: res.id });
  return res.id;
}

const questionOf = (type: string): Json =>
  type === "CUSTOM" ? { type: "CUSTOM", key: "prm_verify_service", label: "Which service?", options: [{ key: "a", value: "Haircut" }, { key: "b", value: "Facial" }] } : { type };
const FORM_A = ["FULL_NAME", "EMAIL", "PHONE", "WHATSAPP_NUMBER", "CITY", "STATE", "ZIP", "COUNTRY", "STREET_ADDRESS", "DOB", "GENDER", "CUSTOM"];
const FORM_B = LEAD_QUESTIONS.map((q) => q.type as string).filter((t) => !FORM_A.includes(t));

function positionsOf(rows: readonly PlacementRow[]): Json {
  const out: Json = { publisher_platforms: [...new Set(rows.map((r) => r.platform))] };
  for (const r of rows) {
    const key = `${r.platform}_positions`;
    out[key] = [...new Set([...((out[key] as string[] | undefined) ?? []), r.position])];
  }
  if (rows.some((r) => r.mobileOnly) && !rows.some((r) => r.key === "facebook_feed")) out.device_platforms = ["mobile"];
  return out;
}

function companions(row: PlacementRow): PlacementRow[] {
  const req = row.requires;
  if (!req) return [];
  if ("anyOther" in req) return PLACEMENTS.filter((p) => p.key === "facebook_feed");
  return PLACEMENTS.filter((p) => p.key === req.anyOf[0]);
}

type StepFn = (ctx: Ctx) => Promise<void>;

const STEPS: Readonly<Partial<Record<StepId, StepFn>>> = {
  async "V-P0"(ctx) {
    let creativeId: string | null = null;
    await check(ctx, "creative_without_status", ["shape.single_image"], async () => {
      creativeId = await create(ctx, "adcreatives", linkCreative(ctx, "V-P0 creative"));
      const back = await readBack(ctx, creativeId, CREATIVE_FIELDS, {}, { paused: false });
      return { creativeId, readBack: back, withStatus: "Not sent: the ads client refuses a creative body that carries status (P0-1). Record Meta's own answer with the runbook's curl." };
    });
    // The whole PAUSED chain a launch makes: campaign, ad set and an ad that uses the creative, each read back PAUSED.
    await check(ctx, "paused_ad_from_creative", [], async () => {
      if (!creativeId) throw new CheckSkipped("Needs the creative.");
      const campaignId = await create(ctx, "campaigns", campaignBody(ctx, "V-P0 campaign", "OUTCOME_TRAFFIC"));
      const adSetId = await create(ctx, "adsets", adSetBody(ctx, "V-P0 ad set", campaignId, { optimization: "LINK_CLICKS", destination: "WEBSITE" }));
      const adId = await create(ctx, "ads", { name: name(ctx, "V-P0 ad"), adset_id: adSetId, creative: { creative_id: creativeId }, status: "PAUSED" });
      return { ad: await readBack(ctx, adId, ["id", "name", "status"]) };
    });
  },

  async "V-P18"(ctx) {
    await check(ctx, "pixel_create", [], async () => {
      const res = await ctx.ports.post<{ id?: string }>(`${ctx.act}/adspixels`, { name: name(ctx, "pixel") });
      if (typeof res?.id !== "string") throw new CheckFailed("adspixels answered without an id.", { res });
      ctx.kept.push(`pixel ${res.id} (Meta has no API to delete a pixel)`);
      const code = await ctx.ports.get<{ code?: unknown }>(res.id, { fields: "id,name,code" });
      if (typeof code?.code !== "string" || !code.code.includes("fbq(")) throw new CheckFailed("The pixel's code did not come back.", { code });
      ctx.pixelId ??= res.id;
      return { pixelId: res.id, codeReturned: true };
    });
  },

  async "V-P1"(ctx) {
    for (const g of GOALS) {
      await check(ctx, `goal:${g.key}`, [`goal.${g.key}`], async () => {
        const promoted = promotedObject(ctx, g);
        const campaignId = await create(ctx, "campaigns", campaignBody(ctx, `V-P1 ${g.key}`, g.objective));
        const adSetId = await create(ctx, "adsets", adSetBody(ctx, `V-P1 ${g.key}`, campaignId, { optimization: g.optimizationGoal, destination: g.destinationType, promoted }));
        const campaign = await readBack(ctx, campaignId, ["id", "name", "status", "objective"], { objective: g.objective });
        const adSet = await readBack(ctx, adSetId, ["id", "name", "status", "optimization_goal", "destination_type", "promoted_object"], {
          optimization_goal: g.optimizationGoal,
          ...(g.destinationType ? { destination_type: g.destinationType } : {}),
        });
        return { campaign, adSet };
      });
    }
    await check(ctx, "special_ad_category_country", [], async () => {
      const id = await create(ctx, "campaigns", campaignBody(ctx, "V-P1 special category", "OUTCOME_LEADS", { special_ad_categories: ["EMPLOYMENT"], special_ad_category_country: ["IN"] }));
      return { campaign: await readBack(ctx, id, ["id", "name", "status", "special_ad_categories", "special_ad_category_country"]) };
    });
  },

  async "V-P1+"(ctx) {
    await check(ctx, "daily_budget_24h_refused", [], async () => {
      const campaignId = await create(ctx, "campaigns", campaignBody(ctx, "V-P1+ short run", "OUTCOME_ENGAGEMENT"));
      try {
        const id = await create(ctx, "adsets", adSetBody(ctx, "V-P1+ 23 hours", campaignId, { optimization: "POST_ENGAGEMENT", hours: 23 }));
        throw new CheckFailed("Meta accepted a daily-budget ad set of 23 hours; the D31 copy needs Meta's refusal.", { adSetId: id });
      } catch (e) {
        if (!(e instanceof GraphError)) throw e;
        return { refused: errorOf(e) };
      }
    });
  },

  async "V-P2"(ctx) {
    await check(ctx, "ig_media_boost", ["shape.ig_media_boost"], async () => {
      const reel = await latestReel(ctx);
      const id = await create(ctx, "adcreatives", { name: name(ctx, "V-P2 Instagram boost"), object_id: ctx.pageId, instagram_user_id: ctx.igId, source_instagram_media_id: reel.id, degrees_of_freedom_spec: optOutSpec() });
      return { media: reel, readBack: await readBack(ctx, id, CREATIVE_FIELDS, {}, { paused: false }) };
    });
    await check(ctx, "fb_post_boost", ["shape.fb_post_boost"], async () => {
      const post = await latestPost(ctx);
      const id = await create(ctx, "adcreatives", { name: name(ctx, "V-P2 Facebook boost"), object_story_id: post.promotable_id ?? post.id, degrees_of_freedom_spec: optOutSpec() });
      return { post, readBack: await readBack(ctx, id, ["id", "name", "object_story_id"], {}, { paused: false }) };
    });
    await check(ctx, "is_instagram_eligible", [], async () => {
      const post = await latestPost(ctx);
      const got = await ctx.ports.get<Json>(String(post.id), { fields: "id,is_instagram_eligible" }, "page");
      if (typeof got?.is_instagram_eligible !== "boolean") throw new CheckFailed("is_instagram_eligible did not come back.", { got });
      return { got, creatorAccounts: "Record by hand whether a Creator account boosts the same way." };
    });
  },

  async "V-P7"(ctx) {
    let formA: string | null = null;
    await check(ctx, "form_questions_a", FORM_A.map((q) => `question.${q}`), async () => {
      formA = await makeForm(ctx, "V-P7 form A", FORM_A.map(questionOf));
      return { form: await readBack(ctx, formA, ["id", "name", "status", "questions"], {}, { paused: false, token: "page" }) };
    });
    await check(ctx, "form_questions_b", FORM_B.map((q) => `question.${q}`), async () => {
      const id = await makeForm(ctx, "V-P7 form B", FORM_B.map(questionOf));
      return { form: await readBack(ctx, id, ["id", "name", "status", "questions"], {}, { paused: false, token: "page" }) };
    });
    await check(ctx, "test_lead_fields", [], async () => {
      if (!formA) throw new CheckSkipped("Needs form A.");
      const sent = await ctx.ports.post<Json>(`${formA}/test_leads`, { field_data: [{ name: "full_name", values: ["PRM-VERIFY test lead"] }, { name: "email", values: ["prm.verify@example.com"] }, { name: "phone_number", values: ["+12025550142"] }] }, "page");
      ctx.memo.testLead = sent;
      let leadId = typeof sent?.id === "string" ? sent.id : null;
      if (!leadId) {
        const list = await ctx.ports.get<{ data?: Json[] }>(`${formA}/leads`, { fields: "id,created_time", limit: "1" }, "page");
        leadId = typeof list?.data?.[0]?.id === "string" ? (list.data[0].id as string) : null;
      }
      if (!leadId) throw new CheckFailed("The test lead could not be found.", { sent });
      const lead = await ctx.ports.get<Json>(leadId, { fields: "id,created_time,field_data,platform,is_organic,adset_id" }, "page");
      return { testLeadAnswer: sent, lead, fields: { platform: "platform" in lead, is_organic: "is_organic" in lead, adset_id: "adset_id" in lead }, webhook: "Watch the leadgen webhook deliver it to Leads > All leads, tagged Test." };
    });
  },

  async "V-P7+"(ctx) {
    await check(ctx, "test_leads_answer_shape", [], async () => {
      if (!ctx.memo.testLead) throw new CheckSkipped("Run V-P7 in the same run.");
      return { answer: ctx.memo.testLead, returnsLeadId: typeof ctx.memo.testLead.id === "string", capi: "Record by hand the CAPI fields Meta expects for conversion leads (event_source, lead_event_source)." };
    });
    await check(ctx, "optional_unticked_consent", [], async () => {
      const id = await makeForm(ctx, "V-P7+ consent", [questionOf("FULL_NAME"), questionOf("PHONE")], {
        legal_content: { custom_disclaimer: { title: "WhatsApp messages", body: { text: "We may send you WhatsApp messages about your enquiry." }, checkboxes: [{ key: "whatsapp_opt_in", text: "I agree to get WhatsApp messages", is_required: false, is_checked_by_default: false }] } },
      });
      return { form: await readBack(ctx, id, ["id", "name", "legal_content"], {}, { paused: false, token: "page" }) };
    });
  },

  async "V-P3"(ctx) {
    for (const [goal, spec] of Object.entries(CTA_BY_GOAL)) {
      if (goal === "engagement" || spec.types.length === 0) continue;
      const goalRow = GOALS.find((g) => g.key === goal);
      const rows = [`boost_cta.${goal}`, ...(goalRow?.verifyRefs.includes("V-P3") ? [`goal.${goal}`] : [])];
      await check(ctx, `boost_cta:${goal}`, rows, async () => {
        const post = await latestPost(ctx);
        const formId = spec.valueFrom === "lead_form" ? await makeForm(ctx, `V-P3 ${goal} form`, [questionOf("FULL_NAME"), questionOf("PHONE")]) : null;
        const value = CTA_VALUE(ctx, goal, formId);
        const id = await create(ctx, "adcreatives", { name: name(ctx, `V-P3 ${goal}`), object_story_id: post.promotable_id ?? post.id, call_to_action: { type: spec.types[0], value }, degrees_of_freedom_spec: optOutSpec() });
        return { cta: spec.types[0], readBack: await readBack(ctx, id, ["id", "name", "call_to_action_type"], {}, { paused: false }) };
      });
    }
  },

  async "V-P4"(ctx) {
    await check(ctx, "instagram_direct_cta", ["boost_cta.instagram_dms", "goal.instagram_dms"], async () => {
      if (!ctx.igId) throw new CheckSkipped("Needs --instagram.");
      const tried: Json[] = [];
      for (const type of ["INSTAGRAM_MESSAGE", "MESSAGE_PAGE"]) {
        let id: string;
        try {
          id = await create(ctx, "adcreatives", linkCreative(ctx, `V-P4 ${type}`, {}, { call_to_action: { type, value: { app_destination: "INSTAGRAM_DIRECT" } } }));
        } catch (e) {
          if (!(e instanceof GraphError)) throw e;
          tried.push({ type, error: errorOf(e) });
          continue;
        }
        return { accepted: type, tried, readBack: await readBack(ctx, id, CREATIVE_FIELDS, {}, { paused: false }) };
      }
      throw new CheckFailed("Neither Click-to-Instagram button was accepted.", { tried });
    });
    await check(ctx, "profile_destination", ["goal.profile_visits", "boost_cta.profile_visits"], async () => {
      const g = GOALS.find((x) => x.key === "profile_visits");
      if (!g) throw new CheckSkipped("No profile_visits goal in the catalog.");
      const campaignId = await create(ctx, "campaigns", campaignBody(ctx, "V-P4 profile", g.objective));
      const adSetId = await create(ctx, "adsets", adSetBody(ctx, "V-P4 profile", campaignId, { optimization: g.optimizationGoal, destination: g.destinationType, promoted: promotedObject(ctx, g) }));
      return { adSet: await readBack(ctx, adSetId, ["id", "name", "status", "destination_type", "optimization_goal"], { destination_type: g.destinationType }) };
    });
    await check(ctx, "ice_breakers", ["feature.ice_breakers", "goal.whatsapp_chats", "goal.any_chat"], async () => {
      const welcome = JSON.stringify({
        type: "VISUAL_EDITOR",
        version: 2,
        landing_screen_type: "welcome_message",
        media_type: "text",
        text_format: { customer_action_type: "ice_breakers", message: { ice_breakers: [{ title: "What are your prices?" }, { title: "Are you open today?" }], quick_replies: [], text: "Hi! How can we help?" } },
      });
      const id = await create(ctx, "adcreatives", linkCreative(ctx, "V-P4 ice breakers", {}, { link: WHATSAPP_LINK, call_to_action: { type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP" } }, page_welcome_message: welcome }));
      return { readBack: await readBack(ctx, id, CREATIVE_FIELDS, {}, { paused: false }) };
    });
    await check(ctx, "message_page_cta", ["goal.any_chat", "boost_cta.any_chat", "boost_cta.messenger_chats"], async () => {
      const id = await create(ctx, "adcreatives", linkCreative(ctx, "V-P4 Messenger", {}, { call_to_action: { type: "MESSAGE_PAGE", value: { app_destination: "MESSENGER" } } }));
      return { readBack: await readBack(ctx, id, CREATIVE_FIELDS, {}, { paused: false }) };
    });
  },

  async "V-P5"(ctx) {
    const spec = linkCreative(ctx, "V-P5 preview");
    for (const format of META_PREVIEW_FORMATS) {
      await check(ctx, `preview:${format}`, ["feature.previews"], async () => {
        const res = await ctx.ports.get<{ data?: { body?: string }[] }>(`${ctx.act}/generatepreviews`, { ad_format: format, creative: JSON.stringify(spec) });
        const body = res?.data?.[0]?.body ?? "";
        const src = /<iframe[^>]*\ssrc="([^"]+)"/i.exec(body)?.[1]?.replace(/&amp;/g, "&") ?? null;
        let host: string | null = null;
        try {
          host = src ? new URL(src).hostname : null;
        } catch {
          host = null;
        }
        if (!host || !(host === "facebook.com" || host.endsWith(".facebook.com"))) throw new CheckFailed("The preview's iframe is not on facebook.com.", { host });
        return { format, host };
      });
    }
  },

  async "V-P6"(ctx) {
    await check(ctx, "image_bytes", ["shape.single_image"], async () => {
      const hash = await uploadImage(ctx, "V-P6 image", 1080, 1350, [37, 99, 235]);
      ctx.kept.push(`image ${hash} (stays in the ad account's image library)`);
      let readBackImage: Json | null = null;
      try {
        readBackImage = await ctx.ports.get<Json>(`${ctx.act}/adimages`, { hashes: JSON.stringify([hash]), fields: "hash,width,height,status" });
      } catch (e) {
        readBackImage = { notRead: errorOf(e) };
      }
      return { hash, readBack: readBackImage };
    });
    await check(ctx, "carousel", ["shape.carousel"], async () => {
      const first = ctx.memo.images?.[0] ?? (await uploadImage(ctx, "V-P6 card 1", 1080, 1080, [37, 99, 235]));
      const second = await uploadImage(ctx, "V-P6 card 2", 1080, 1080, [22, 163, 74]);
      const id = await create(ctx, "adcreatives", {
        name: name(ctx, "V-P6 carousel"),
        object_story_spec: { page_id: ctx.pageId, ...(ctx.igId ? { instagram_user_id: ctx.igId } : {}), link_data: { link: TEST_LINK, message: TEST_TEXT, child_attachments: [first, second].map((h, i) => ({ link: TEST_LINK, image_hash: h, name: `Card ${i + 1}` })) } },
        degrees_of_freedom_spec: optOutSpec(),
      });
      return { readBack: await readBack(ctx, id, CREATIVE_FIELDS, {}, { paused: false }) };
    });
    await check(ctx, "video_file_url", ["shape.single_video"], async () => {
      if (!ctx.videoUrl) throw new CheckSkipped("Needs --video-url (a public https MP4).");
      const res = await ctx.ports.post<{ id?: string }>(`${ctx.act}/advideos`, { name: name(ctx, "V-P6 video"), file_url: ctx.videoUrl });
      if (typeof res?.id !== "string") throw new CheckFailed("advideos answered without an id.", { res });
      ctx.tracked.push({ kind: "video", id: res.id });
      let last: Json = {};
      for (let i = 0; i < 12; i++) {
        last = await ctx.ports.get<Json>(res.id, { fields: "id,status,length,thumbnails" });
        const status = (last.status as { video_status?: string } | undefined)?.video_status;
        if (status === "ready") return { videoId: res.id, status: last.status, thumbnails: Array.isArray((last.thumbnails as { data?: unknown[] } | undefined)?.data) ? (last.thumbnails as { data: unknown[] }).data.length : 0, signedUrl: "Record by hand that a signed URL works as file_url too." };
        if (status === "error") break;
        await ctx.sleep(ctx.pollMs);
      }
      throw new CheckFailed("The video was not ready in time.", { last });
    });
  },

  async "V-P8"(ctx) {
    let listId: string | null = null;
    const audience = async (body: Json) => {
      const res = await ctx.ports.post<{ id?: string }>(`${ctx.act}/customaudiences`, body);
      if (typeof res?.id !== "string") throw new CheckFailed("customaudiences answered without an id.", { res });
      ctx.tracked.push({ kind: "audience", id: res.id });
      return res.id;
    };
    await check(ctx, "customer_list_session", [], async () => {
      listId = await audience({ name: name(ctx, "V-P8 customer list"), subtype: "CUSTOM", customer_file_source: "USER_PROVIDED_ONLY", description: "PRM-VERIFY sandbox check" });
      const hashes = Array.from({ length: 100 }, (_, i) => [createHash("sha256").update(`prm.verify.${i}@example.com`).digest("hex")]);
      const session = { session_id: Number(String(ctx.now.getTime()).slice(-9)), batch_seq: 1, last_batch_flag: true, estimated_num_total: hashes.length };
      const sent = await ctx.ports.post<Json>(`${listId}/users`, { payload: { schema: ["EMAIL"], data: hashes }, session });
      return { listId, sent, readBack: await readBack(ctx, listId, ["id", "name", "subtype", "operation_status"], {}, { paused: false }) };
    });
    await check(ctx, "lookalike", [], async () => {
      if (!listId) throw new CheckSkipped("Needs the customer list.");
      const id = await audience({ name: name(ctx, "V-P8 lookalike"), subtype: "LOOKALIKE", origin_audience_id: listId, lookalike_spec: JSON.stringify({ country: "IN", ratio: 0.01, type: "similarity" }) });
      return { readBack: await readBack(ctx, id, ["id", "name", "subtype"], {}, { paused: false }) };
    });
    for (const e of AUDIENCE_EVENTS) {
      await check(ctx, `event:${e.id}`, [`audience_event.${e.id}`], async () => {
        const source =
          e.sourceType === "ig_business" ? ctx.igId : e.sourceType === "page" || e.sourceType === "lead" ? ctx.pageId : ctx.pixelId;
        if (!source) throw new CheckSkipped(e.sourceType === "pixel" ? "Needs a pixel (V-P18)." : "Needs --instagram.");
        const filters = e.sourceType === "pixel" ? [{ field: "url", operator: "i_contains", value: e.id === "website_url" ? "prm-verify" : "" }] : [{ field: "event", operator: "eq", value: e.event }];
        const rule = { inclusions: { operator: "or", rules: [{ event_sources: [{ id: source, type: e.sourceType }], retention_seconds: e.defaultDays * 86_400, filter: { operator: "and", filters } }] } };
        const id = await audience({ name: name(ctx, `V-P8 ${e.id}`), rule: JSON.stringify(rule), prefill: true });
        return { readBack: await readBack(ctx, id, ["id", "name", "subtype"], {}, { paused: false }) };
      });
    }
  },

  async "V-P9"(ctx) {
    await check(ctx, "creative_features_spec", ["feature.enhancements"], async () => {
      const id = await create(ctx, "adcreatives", linkCreative(ctx, "V-P9 enhancements"));
      const got = await ctx.ports.get<Json>(id, { fields: "id,degrees_of_freedom_spec" });
      const spec = ((got?.degrees_of_freedom_spec as Json | undefined)?.creative_features_spec ?? {}) as Record<string, { enroll_status?: string }>;
      const missing = OPTED_OUT_FEATURES.filter((f) => spec[f]?.enroll_status !== "OPT_OUT");
      if (missing.length) throw new CheckFailed(`Meta did not keep these features as OPT_OUT: ${missing.join(", ")}.`, { got });
      return { features: Object.keys(spec).length };
    });
  },

  async "V-P10"(ctx) {
    await check(ctx, "reachestimate", [], async () => {
      const res = await ctx.ports.get<Json>(`${ctx.act}/reachestimate`, { targeting_spec: JSON.stringify(BASE_TARGETING) });
      const data = (res?.data ?? res) as Json;
      if (typeof data?.users_lower_bound !== "number") throw new CheckFailed("reachestimate gave no users_lower_bound.", { res });
      return { res };
    });
    await check(ctx, "pin_code_search", [], async () => {
      const res = await ctx.ports.get<{ data?: Json[] }>("search", { type: "adgeolocation", location_types: JSON.stringify(["zip"]), q: "411001", country_code: "IN" });
      if (!res?.data?.some((p) => p.type === "zip")) throw new CheckFailed("No PIN code came back for 411001.", { res });
      return { res };
    });
    await check(ctx, "minimum_budgets", [], async () => {
      const res = await ctx.ports.get<{ data?: Json[] }>(`${ctx.act}/minimum_budgets`);
      if (!res?.data?.[0] || !Object.keys(res.data[0]).some((k) => k.startsWith("min_daily_budget"))) throw new CheckFailed("minimum_budgets has an unknown shape.", { res });
      return { res };
    });
  },

  async "V-P11"(ctx) {
    await check(ctx, "connected_instagram_accounts", [], async () => {
      const tried: Json[] = [];
      for (const edge of ["connected_instagram_accounts", "instagram_accounts"]) {
        try {
          const res = await ctx.ports.get<{ data?: Json[] }>(`${ctx.act}/${edge}`, { fields: "id,username" });
          const ids = (res?.data ?? []).map((r) => String(r.id));
          if (ctx.igId && !ids.includes(ctx.igId)) throw new CheckFailed(`${edge} does not list the test Instagram account.`, { ids });
          return { edge, ids, tried };
        } catch (e) {
          if (!(e instanceof GraphError)) throw e;
          tried.push({ edge, error: errorOf(e) });
        }
      }
      throw new CheckFailed("Neither edge answered.", { tried });
    });
  },

  // Graph leaves a field out when it is not set, so a read without the field proves nothing: V-P12 needs the number linked to
  // the Page and passes only when the field comes back with that number (the CTWA readiness row compares the same field).
  async "V-P12"(ctx) {
    await check(ctx, "page_whatsapp_number", [], async () => {
      if (!ctx.whatsappNumber) throw new CheckSkipped("Needs --whatsapp-number: the test WhatsApp number linked to the Page.");
      const got = await ctx.ports.get<Json>(ctx.pageId, { fields: "id,whatsapp_number" }, "page");
      if (!got || !("whatsapp_number" in got) || !digitsOf(got.whatsapp_number)) {
        throw new CheckFailed("The Page's whatsapp_number did not come back. Graph leaves out a field that is not set: link the number to the Page in Meta (or check the field name), then run V-P12 again.", { got });
      }
      if (digitsOf(got.whatsapp_number) !== digitsOf(ctx.whatsappNumber)) throw new CheckFailed("The Page's whatsapp_number is not the number given with --whatsapp-number.", { got });
      return { got, matchesLinkedNumber: true };
    });
  },

  async "V-P12+"(ctx) {
    await check(ctx, "portfolio_number_unlinked", [], async () => {
      if (!ctx.unlinkedWhatsappNumber) throw new CheckSkipped("Needs --unlinked-whatsapp-number: a number in the same business portfolio that is not linked to the Page.");
      const page = await ctx.ports.get<Json>(ctx.pageId, { fields: "id,whatsapp_number" }, "page");
      if (digitsOf(page.whatsapp_number) && digitsOf(page.whatsapp_number) === digitsOf(ctx.unlinkedWhatsappNumber)) throw new CheckSkipped("That number is linked to the Page; this addendum needs one that is not.");
      const g = GOALS.find((x) => x.key === "whatsapp_chats")!;
      const campaignId = await create(ctx, "campaigns", campaignBody(ctx, "V-P12+ portfolio number", g.objective));
      const adSetId = await create(ctx, "adsets", adSetBody(ctx, "V-P12+ portfolio number", campaignId, { optimization: g.optimizationGoal, destination: g.destinationType, promoted: { page_id: ctx.pageId, whatsapp_phone_number: ctx.unlinkedWhatsappNumber } }));
      return { accepted: true, adSet: await readBack(ctx, adSetId, ["id", "name", "status", "promoted_object"]) };
    });
  },

  async "V-P13"(ctx) {
    let identity: string | null = null;
    await check(ctx, "page_backed_create", [], async () => {
      const res = await ctx.ports.post<{ id?: string }>(`${ctx.pageId}/page_backed_instagram_accounts`, {}, "page");
      if (typeof res?.id !== "string") throw new CheckFailed("page_backed_instagram_accounts answered without an id.", { res });
      identity = res.id;
      ctx.kept.push(`Page-backed Instagram identity ${res.id} (one per Page; it can't be deleted)`);
      return { identity };
    });
    await check(ctx, "page_backed_creative", ["feature.page_backed_instagram"], async () => {
      if (!identity) throw new CheckSkipped("Needs the identity.");
      const id = await create(ctx, "adcreatives", { ...linkCreative(ctx, "V-P13 page-backed"), object_story_spec: { page_id: ctx.pageId, instagram_user_id: identity, link_data: { link: TEST_LINK, message: TEST_TEXT } } });
      return { readBack: await readBack(ctx, id, CREATIVE_FIELDS, {}, { paused: false }) };
    });
  },

  async "V-P14"(ctx) {
    let campaignId: string | null = null;
    for (const row of PLACEMENTS) {
      await check(ctx, `placement:${row.key}`, [`placement.${row.key}`], async () => {
        campaignId ??= await create(ctx, "campaigns", campaignBody(ctx, "V-P14 placements", "OUTCOME_TRAFFIC"));
        const rows = [row, ...companions(row)];
        const targeting = { ...BASE_TARGETING, ...positionsOf(rows), targeting_automation: { advantage_audience: 1 } };
        const adSetId = await create(ctx, "adsets", adSetBody(ctx, `V-P14 ${row.key}`, campaignId, { optimization: "LINK_CLICKS", destination: "WEBSITE", targeting }));
        const got = await readBack(ctx, adSetId, ["id", "name", "status", "targeting"]);
        const kept = ((got.targeting as Json | undefined)?.[`${row.platform}_positions`] ?? null) as string[] | null;
        if (!Array.isArray(kept) || !kept.includes(row.position)) throw new CheckFailed(`Meta did not keep ${row.platform} ${row.position}.`, { sent: positionsOf(rows), effective: got.targeting ?? null });
        return { effective: got.targeting };
      });
    }
  },

  async "V-P15"(ctx) {
    await check(ctx, "asset_customization", ["shape.placement_assets"], async () => {
      const feed = await uploadImage(ctx, "V-P15 feed", 1080, 1080, [37, 99, 235]);
      const tall = await uploadImage(ctx, "V-P15 vertical", 1080, 1920, [22, 163, 74]);
      const id = await create(ctx, "adcreatives", {
        name: name(ctx, "V-P15 tall version"),
        object_story_spec: { page_id: ctx.pageId, ...(ctx.igId ? { instagram_user_id: ctx.igId } : {}) },
        asset_feed_spec: {
          images: [{ hash: feed, adlabels: [{ name: "prm_feed" }] }, { hash: tall, adlabels: [{ name: "prm_vertical" }] }],
          bodies: [{ text: TEST_TEXT }],
          titles: [{ text: "PRM-VERIFY" }],
          link_urls: [{ website_url: TEST_LINK }],
          call_to_action_types: ["LEARN_MORE"],
          ad_formats: ["SINGLE_IMAGE"],
          asset_customization_rules: [
            { customization_spec: { publisher_platforms: ["facebook", "instagram"], facebook_positions: ["feed"], instagram_positions: ["stream"] }, image_label: { name: "prm_feed" }, priority: 1 },
            { customization_spec: { publisher_platforms: ["facebook", "instagram"], facebook_positions: ["story"], instagram_positions: ["story", "reels"] }, image_label: { name: "prm_vertical" }, priority: 2 },
          ],
        },
        degrees_of_freedom_spec: optOutSpec(),
      });
      return { readBack: await readBack(ctx, id, ["id", "name", "asset_feed_spec"], {}, { paused: false }) };
    });
  },
};

async function cleanup(ctx: Ctx): Promise<string[]> {
  const left: string[] = [];
  const order = [...ctx.tracked].sort((a, b) => CLEANUP_ORDER.indexOf(a.kind) - CLEANUP_ORDER.indexOf(b.kind));
  for (const t of order) {
    try {
      if (t.kind === "form") {
        if (!(await ctx.ports.archiveForm(t.id))) ctx.kept.push(`lead form ${t.id} (kept: the Spend Book has no lead-form lowering yet; a form can't spend. Archive it by hand in Meta Business Suite > Instant forms if you want it gone)`);
      } else if (ARCHIVED_KINDS.has(t.kind)) await ctx.ports.archive(t.id);
      else await ctx.ports.remove(t.id);
    } catch (e) {
      if (e instanceof VerifyRefusal) throw e;
      left.push(`${t.kind} ${t.id}: ${errorOf(e).message}`);
    }
  }
  ctx.tracked = [];
  return left;
}

// =====================================================================================================================
// The run
// =====================================================================================================================

export type AssetRow = { id: string; tenantId: string; type: string; externalId: string; sandbox: boolean; token: string | null };

export type RunDeps = {
  /** The MetaAsset row with its decrypted token (never logged). */
  loadAsset(tenantId: string, assetId: string): Promise<AssetRow | null>;
  /** A reason when Phase 0's runbook is using this sandbox ad account (in any workspace that has it connected), else null. */
  phase0Activity(tenantId: string, adAccountAssetId: string): Promise<string | null>;
  /**
   * The shared sandbox lock. take() answers null when this exact holder now holds it (free, expired or already its own), else
   * who holds it; release() gives it back only when this exact holder holds it.
   */
  lock: { take(holder: string, minutes: number): Promise<string | null>; release(holder: string): Promise<void> };
  /** The Spend Book of a sandbox run: its ledger rows are the record of what the script did. */
  book: BookPort;
  /** The Spend Book of a dry run: the same checks and permits, and nothing written (realDeps: readOnlyDb). Required for --dry-run. */
  dryRunBook?: BookPort;
  /** Dry run only: the in-process fake that answers instead of Meta (a new one when absent). */
  fake?: Pick<FakeMetaPromote, "fetch">;
  /** Dry run only: the fake's ids and tokens. */
  fakeIds?: { act: string; pageId: string; igId: string; userToken: string; pageToken: string; whatsappNumber: string; unlinkedWhatsappNumber?: string; videoUrl: string };
  writeFile?: (file: string, text: string) => void;
  readFile?: (file: string) => string;
  sleep?: (ms: number) => Promise<void>;
  /** This run's lock holder (default lockHolder(runId)). */
  lockHolder?: (runId: string) => string;
  /** True when a path lies inside a project or repository checkout (default insideProject). */
  insideProject?: (target: string) => boolean;
};

export type RunOptions = {
  dryRun: boolean;
  tenantId: string;
  accountAssetId: string;
  pageAssetId: string;
  instagramAssetId?: string | null;
  /** The test WhatsApp number linked to the Page (V-P1, V-P12). */
  whatsappNumber?: string | null;
  /** A number in the same business portfolio that is not linked to the Page (V-P12+). */
  unlinkedWhatsappNumber?: string | null;
  videoUrl?: string | null;
  steps?: readonly StepId[] | null;
  /**
   * Manual steps a person carried out and records as passed (V-P16, and V-P17 only with the owner present). Needs `operator`;
   * never in a dry run.
   */
  attest?: readonly StepId[] | null;
  write: boolean;
  verifiedPath: string;
  fixturesDir: string;
  /** Where the run report goes; `{runId}` in it is replaced by this run's id. */
  reportPath?: string | null;
  operator?: string | null;
  now?: Date;
  env?: Env;
};

export type RunReport = {
  runId: string;
  mode: "sandbox" | "dry-run";
  operator: string | null;
  startedAt: string;
  finishedAt: string;
  account: { assetId: string; externalId: string };
  /** The name this run held the sandbox lock under. */
  lock: string;
  /** database: the Spend Book rows of this run were written. memory: a dry run, nothing was written to the Spend Book. */
  spendBook: "database" | "memory";
  steps: StepResult[];
  passedSteps: StepId[];
  movedRows: string[];
  manual: { step: StepId; note: string }[];
  leftBehind: string[];
  kept: string[];
  wrote: { verified: string | null; fixtures: string[]; report: string | null };
};

export const REPO_VERIFIED_PATH = path.join("src", "lib", "promote", "catalog", "verified.ts");
export const REPO_FIXTURES_DIR = path.join("tests", "fixtures", "promote-verified");
/** The default report of a sandbox run with --write: one file per run, so a later run never replaces it. */
export const REPO_REPORT_PATH = path.join(REPO_FIXTURES_DIR, "run-report-{runId}.json");
/** Every promote run's lock holder starts with this; the rest names the run (lockHolder). */
export const LOCK_HOLDER_PREFIX = "promote:";
const LOCK_MINUTES = 120;

/** The pinned fixture of one step in one run. */
export const fixtureName = (step: StepId, runId: string) => `${step}.${runId}.json`;

/**
 * This run's name on the sandbox lock: unique per run and machine, so two promote runs started at once never both hold it, and
 * one never releases the other's.
 */
export function lockHolder(runId: string, host: string = hostname(), nonce: string = randomUUID().replace(/-/g, "").slice(0, 8)): string {
  const safeHost = host.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60) || "unknown-host";
  return `${LOCK_HOLDER_PREFIX}${runId}:${nonce}@${safeHost}`;
}

export type PathProbe = { exists(p: string): boolean; realpath(p: string): string };
const DISK: PathProbe = { exists: existsSync, realpath: (p) => realpathSync.native(p) };

/**
 * True when `target` lies inside a project or repository checkout: a directory at or above its real path (symlinks resolved,
 * from the nearest part that exists) holds package.json or .git. Whatever the working directory or the letter case on Windows
 * (the walk asks the file system, which matches names the way the platform does), so a dry run can't reach the repository's
 * verified.ts or fixtures through a relative or differently cased path.
 */
export function insideProject(target: string, fs: PathProbe = DISK): boolean {
  let probe = path.resolve(target);
  while (!fs.exists(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let dir = probe;
  try {
    dir = fs.realpath(probe);
  } catch {
    // Keep the resolved path.
  }
  for (;;) {
    if (fs.exists(path.join(dir, "package.json")) || fs.exists(path.join(dir, ".git"))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** Refuses an account that is not a Meta sandbox account, before anything is sent. */
export function assertSandbox(asset: AssetRow | null, kind: "ad_account" | "page" | "instagram"): AssetRow {
  if (!asset) throw new VerifyRefusal(`The ${kind} asset was not found in this workspace.`);
  if (asset.type !== kind) throw new VerifyRefusal(`That asset is a ${asset.type}, not a ${kind}.`);
  if (kind === "ad_account" && asset.sandbox !== true) throw new VerifyRefusal("Only a Meta sandbox ad account (MetaAsset.sandbox) can be used. This one is a real ad account, so nothing was sent.");
  return asset;
}

export async function runVerifyCatalog(opts: RunOptions, deps: RunDeps): Promise<RunReport> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const runId = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const write = deps.writeFile ?? ((file: string, text: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  });
  const read = deps.readFile ?? ((file: string) => readFileSync(file, "utf8"));
  const reportPath = opts.reportPath ? opts.reportPath.replaceAll("{runId}", runId) : null;

  // Refusals first: nothing has been sent yet.
  if (opts.dryRun) {
    const inside = deps.insideProject ?? ((p: string) => insideProject(p));
    const targets = [...(opts.write ? [opts.verifiedPath, opts.fixturesDir] : []), ...(reportPath ? [reportPath] : [])];
    if (targets.some((t) => inside(t))) {
      throw new VerifyRefusal("A dry run never writes inside a project or repository checkout, so it can't touch the real verified.ts or fixtures. Give --verified-path, --fixtures-dir and --report under a temporary folder, such as /tmp.");
    }
  }
  const book = opts.dryRun ? deps.dryRunBook : deps.book;
  if (!book) throw new VerifyRefusal("A dry run needs a Spend Book that writes nothing, and none was given. Nothing was sent.");
  for (const s of opts.attest ?? []) if (!MANUAL_STEPS[s]) throw new VerifyRefusal(`${s} is not a manual step; only ${Object.keys(MANUAL_STEPS).join(" and ")} can be attested.`);
  if (opts.attest?.length && opts.dryRun) throw new VerifyRefusal("A dry run can't record a manual check. Attest V-P16 or V-P17 on a sandbox run, after doing it.");
  if (opts.attest?.length && !opts.operator?.trim()) throw new VerifyRefusal("Name who did the manual check with --operator.");
  if (!opts.dryRun && (env.GRAPH_BASE_URL ?? "").trim()) throw new VerifyRefusal("GRAPH_BASE_URL is set, so Graph calls would go to a test server. Unset it for a sandbox run, or use --dry-run.");
  const account = assertSandbox(await deps.loadAsset(opts.tenantId, opts.accountAssetId), "ad_account");
  const page = assertSandbox(await deps.loadAsset(opts.tenantId, opts.pageAssetId), "page");
  const ig = opts.instagramAssetId ? assertSandbox(await deps.loadAsset(opts.tenantId, opts.instagramAssetId), "instagram") : null;
  if (["1", "true", "yes", "on"].includes((env.SPEND_SIM ?? "").trim().toLowerCase())) throw new VerifyRefusal("SPEND_SIM=1: Phase 0's synthetic spend series is on. The two runbooks never run at the same time.");
  const phase0 = await deps.phase0Activity(opts.tenantId, account.id);
  if (phase0) throw new VerifyRefusal(`Phase 0's runbook is using the sandbox: ${phase0}`);
  const holder = (deps.lockHolder ?? lockHolder)(runId);
  const held = await deps.lock.take(holder, LOCK_MINUTES);
  if (held) throw new VerifyRefusal(`The sandbox is in use: ${held}. Two runs never use it at the same time; wait until that run ends or its lock expires.`);

  const ids = opts.dryRun
    ? (deps.fakeIds ?? (await defaultFakeIds()))
    : {
        act: account.externalId.startsWith("act_") ? account.externalId : `act_${account.externalId}`,
        pageId: page.externalId,
        igId: ig?.externalId ?? null,
        userToken: account.token ?? "",
        pageToken: page.token ?? "",
        whatsappNumber: opts.whatsappNumber ?? null,
        unlinkedWhatsappNumber: opts.unlinkedWhatsappNumber ?? null,
        videoUrl: opts.videoUrl ?? null,
      };
  if (!ids.userToken || !ids.pageToken) {
    await deps.lock.release(holder);
    throw new VerifyRefusal("The ad account or the Page has no usable token. Connect them again in Settings > Connections.");
  }

  const restoreFetch = opts.dryRun ? await installFake(deps) : () => undefined;
  const results: StepResult[] = [];
  const startedAt = new Date();
  let current: StepResult | null = null;
  let ctxRef: Ctx | null = null;
  try {
    const ports = guardedPorts({
      tenantId: opts.tenantId,
      adAccountAssetId: account.id,
      act: ids.act,
      userToken: ids.userToken,
      pageToken: ids.pageToken,
      book,
      record: (r) => {
        const step = current;
        if (step) step.calls.push({ ...r, step: step.step, check: ctxRef?.check ?? "setup" });
      },
    });
    const ctx: Ctx = {
      ports,
      act: ids.act,
      pageId: ids.pageId,
      igId: opts.dryRun ? ids.igId : (ig?.externalId ?? null),
      whatsappNumber: opts.dryRun ? ids.whatsappNumber : (opts.whatsappNumber ?? null),
      unlinkedWhatsappNumber: opts.dryRun ? (ids.unlinkedWhatsappNumber ?? null) : (opts.unlinkedWhatsappNumber ?? null),
      videoUrl: opts.dryRun ? ids.videoUrl : (opts.videoUrl ?? null),
      pixelId: null,
      runId,
      now,
      sleep: deps.sleep ?? (opts.dryRun ? async () => undefined : (ms) => new Promise((r) => setTimeout(r, ms))),
      pollMs: opts.dryRun ? 0 : 10_000,
      tracked: [],
      kept: [],
      checks: [],
      check: "setup",
      memo: {},
    };
    ctxRef = ctx;
    const wanted = new Set<StepId>(opts.steps?.length ? opts.steps : STEP_IDS);
    for (const step of STEP_IDS) {
      if (!MANUAL_STEPS[step]) continue;
      if (opts.attest?.includes(step)) {
        const evidence = { operator: opts.operator?.trim() ?? null, attestedAt: now.toISOString(), what: MANUAL_STEPS[step] };
        results.push({ step, title: STEP_TITLES[step], status: "passed", checks: [{ id: "attested", passed: true, rows: [], evidence }], calls: [], leftBehind: [], kept: [], note: `Attested by ${evidence.operator}.` });
      } else if (wanted.has(step)) results.push({ step, title: STEP_TITLES[step], status: "manual", checks: [], calls: [], leftBehind: [], kept: [], note: MANUAL_STEPS[step] });
    }
    for (const step of RUN_ORDER) {
      if (!wanted.has(step)) continue;
      const run = STEPS[step]!;
      current = { step, title: STEP_TITLES[step], status: "failed", checks: [], calls: [], leftBehind: [], kept: [] };
      ctx.checks = [];
      ctx.kept = [];
      try {
        if (step !== "V-P18" && step !== "V-P0" && ctx.pixelId === null && !ctx.memo.pixelLooked) {
          ctx.memo.pixelLooked = true;
          ctx.pixelId = await firstPixel(ctx);
        }
        await run(ctx);
      } finally {
        current.leftBehind = await cleanup(ctx);
        current.checks = ctx.checks;
        current.kept = ctx.kept;
        const ran = current.checks.filter((c) => !c.skipped);
        current.status = current.checks.length === 0 || ran.length === 0 ? "skipped" : current.checks.every((c) => c.passed) ? "passed" : "failed";
        results.push(current);
        current = null;
      }
    }
  } finally {
    restoreFetch();
    await deps.lock.release(holder);
  }

  results.sort((a, b) => STEP_IDS.indexOf(a.step) - STEP_IDS.indexOf(b.step));
  const passed = results.filter((r) => r.status === "passed").map((r) => r.step);
  const report: RunReport = {
    runId,
    mode: opts.dryRun ? "dry-run" : "sandbox",
    operator: opts.operator ?? null,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    account: { assetId: account.id, externalId: ids.act },
    lock: holder,
    spendBook: opts.dryRun ? "memory" : "database",
    steps: results,
    passedSteps: passed,
    movedRows: [],
    manual: results.filter((r) => r.status === "manual").map((r) => ({ step: r.step, note: r.note ?? "" })),
    leftBehind: results.flatMap((r) => r.leftBehind.map((l) => `${r.step}: ${l}`)),
    kept: results.flatMap((r) => r.kept.map((k) => `${r.step}: ${k}`)),
    wrote: { verified: null, fixtures: [], report: null },
  };

  if (opts.write) {
    const source = read(opts.verifiedPath);
    const rows = passedRows(results, [...readVerifiedRows(source).keys()]);
    const { text, moved } = regenerateVerified(source, rows, passed, now, { dryRun: opts.dryRun });
    write(opts.verifiedPath, text);
    report.movedRows = moved;
    report.wrote.verified = opts.verifiedPath;
    for (const r of results) {
      const good = new Set(r.checks.filter((c) => c.passed).map((c) => c.id));
      if (good.size === 0) continue;
      // One file per step and run: a later run, even a partial one, never replaces the evidence an earlier run pinned.
      const file = path.join(opts.fixturesDir, fixtureName(r.step, runId));
      const fixture = {
        step: r.step,
        title: r.title,
        runId,
        mode: report.mode,
        recordedAt: report.finishedAt,
        checks: r.checks.filter((c) => c.passed),
        calls: r.calls.filter((c) => c.check === "setup" || good.has(c.check)),
      };
      write(file, `${JSON.stringify(fixture, null, 2)}\n`);
      report.wrote.fixtures.push(file);
    }
  }
  if (reportPath) {
    report.wrote.report = reportPath;
    write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

async function firstPixel(ctx: Ctx): Promise<string | null> {
  try {
    const res = await ctx.ports.get<{ data?: Json[] }>(`${ctx.act}/adspixels`, { fields: "id,name", limit: "5" });
    const id = res?.data?.[0]?.id;
    return typeof id === "string" ? id : null;
  } catch (e) {
    if (e instanceof VerifyRefusal) throw e;
    return null;
  }
}

async function defaultFakeIds(): Promise<NonNullable<RunDeps["fakeIds"]>> {
  const f = await import("../tests/helpers/fake-meta-promote");
  return {
    act: f.FAKE_ACT,
    pageId: f.FAKE_PAGE_ID,
    igId: f.FAKE_IG_ID,
    userToken: f.FAKE_USER_TOKEN,
    pageToken: f.FAKE_PAGE_TOKEN,
    // The fake Page's linked number, and one it does not have.
    whatsappNumber: "919800000001",
    unlinkedWhatsappNumber: "919800000002",
    videoUrl: "https://example.com/prm-verify.mp4",
  };
}

/** Points fetch at the in-process fake for the run; answers the restore. */
async function installFake(deps: RunDeps): Promise<() => void> {
  const fake = deps.fake ?? (await import("../tests/helpers/fake-meta-promote")).createFakeMetaPromote();
  const original = globalThis.fetch;
  globalThis.fetch = fake.fetch as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

// =====================================================================================================================
// The command line
// =====================================================================================================================

export type CliArgs = Omit<RunOptions, "now" | "env">;

export function parseArgs(argv: readonly string[]): CliArgs {
  // A flag given twice counts once, with its last value (so `$V --steps V-P12 --whatsapp-number ...` overrides $V's own).
  const get = (flag: string) => {
    const i = argv.lastIndexOf(flag);
    return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
  };
  const has = (flag: string) => argv.includes(flag);
  const dryRun = has("--dry-run");
  const list = (flag: string) => get(flag)?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
  const steps = list("--steps");
  const attest = list("--attest");
  for (const s of [...(steps ?? []), ...(attest ?? [])]) if (!(STEP_IDS as readonly string[]).includes(s)) throw new VerifyRefusal(`Unknown step ${s}. Use ${STEP_IDS.join(", ")}.`);
  const tenantId = get("--tenant");
  const accountAssetId = get("--account");
  const pageAssetId = get("--page");
  if (!tenantId || !accountAssetId || !pageAssetId) throw new VerifyRefusal("Give --tenant, --account (the sandbox ad account's MetaAsset id) and --page (the test Page's MetaAsset id).");
  const number = (flag: string) => {
    const value = get(flag);
    if (value && !/^\+?\d{8,15}$/.test(value)) throw new VerifyRefusal(`${flag} is digits in international format, like 919800000001.`);
    return value?.replace(/^\+/, "") ?? null;
  };
  const whatsappNumber = number("--whatsapp-number");
  const unlinkedWhatsappNumber = number("--unlinked-whatsapp-number");
  if (whatsappNumber && unlinkedWhatsappNumber && whatsappNumber === unlinkedWhatsappNumber) {
    throw new VerifyRefusal("--unlinked-whatsapp-number must be a different number from --whatsapp-number (the one linked to the Page).");
  }
  const videoUrl = get("--video-url");
  if (videoUrl && !/^https:\/\//.test(videoUrl)) throw new VerifyRefusal("--video-url must be an https address.");
  return {
    dryRun,
    tenantId,
    accountAssetId,
    pageAssetId,
    instagramAssetId: get("--instagram"),
    whatsappNumber,
    unlinkedWhatsappNumber,
    videoUrl,
    steps: steps as StepId[] | null,
    attest: attest as StepId[] | null,
    write: has("--write"),
    verifiedPath: get("--verified-path") ?? REPO_VERIFIED_PATH,
    fixturesDir: get("--fixtures-dir") ?? REPO_FIXTURES_DIR,
    reportPath: get("--report") ?? (has("--write") && !dryRun ? REPO_REPORT_PATH : null),
    operator: get("--operator"),
  };
}

// =====================================================================================================================
// Phase 0's activity on the sandbox, and the dry run's Spend Book
// =====================================================================================================================

/** The reads phase0Activity needs (realDeps answers them from the database). */
export type Phase0Queries = {
  /** The ad account asset's Meta id (act_<n> or <n>). */
  accountExternalId(assetId: string): Promise<string | null>;
  /** Every workspace that has a sandbox ad account with one of these Meta ids connected. */
  sandboxTenants(externalIds: readonly string[]): Promise<string[]>;
  /** Phase 0 synthetic spend rows (SpendDaily source sim) written in these workspaces since `since`. */
  simRows(tenantIds: readonly string[], since: Date): Promise<number>;
  /** Spend Book rows about a sandbox ad account (sandbox = true) in these workspaces since `since`, from anyone but this script. */
  otherSandboxLedgerRows(tenantIds: readonly string[], since: Date): Promise<number>;
};

export const PHASE0_WINDOW_MS = 2 * 3_600_000;

/**
 * Why Phase 0's runbook may be using this sandbox ad account, or null. Meta gives one sandbox ad account per app, and it can
 * be connected in Phase 0's own workspace as well as this one, so every workspace that has the same sandbox account is
 * checked: Phase 0's synthetic spend rows, and Spend Book rows about the sandbox (its V-steps create and turn on objects) from
 * any actor but this script, in the last 2 hours.
 */
export async function phase0ActivityIn(q: Phase0Queries, adAccountAssetId: string, now: Date = new Date()): Promise<string | null> {
  const external = (await q.accountExternalId(adAccountAssetId)) ?? "";
  const num = external.replace(/^act_/, "");
  if (!num) return null;
  const tenants = [...new Set(await q.sandboxTenants([num, `act_${num}`]))];
  if (tenants.length === 0) return null;
  const since = new Date(now.getTime() - PHASE0_WINDOW_MS);
  const where = tenants.length === 1 ? "the workspace that has this sandbox ad account" : `${tenants.length} workspaces that have this sandbox ad account`;
  const sims = await q.simRows(tenants, since);
  if (sims > 0) return `Phase 0's synthetic spend rows were written in ${where} in the last 2 hours. Wait until its run ends.`;
  const others = await q.otherSandboxLedgerRows(tenants, since);
  if (others > 0) return `the Spend Book has ${others} rows about the sandbox ad account from someone else in ${where} in the last 2 hours (Phase 0's checks create and turn on objects there). Wait until they end.`;
  return null;
}

/** A write the dry run's Spend Book held back instead of sending to the database. */
export type HeldWrite = { model: string; method: string };

const MODEL_WRITES = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany"]);
const SQL_WRITE = /^\s*(insert|update|delete|merge|upsert|alter|create|drop|truncate|grant|revoke|lock|copy|with\b[\s\S]*\b(insert|update|delete)\b)/i;

function sqlText(args: readonly unknown[]): string {
  const first = args[0];
  if (typeof first === "string") return first;
  if (Array.isArray(first)) return first.join("?");
  if (first && typeof first === "object" && Array.isArray((first as { strings?: unknown }).strings)) return ((first as { strings: string[] }).strings).join("?");
  return "";
}

/**
 * A database client for a dry run's Spend Book: reads go to the database, so a stopped or frozen workspace still refuses and
 * the permits are the Book's own; every write is held in memory (`held`) and never sent. A model write answers with the row
 * it would have written; $transaction runs its callback on this same client (so the spend lock's SQL is held too); raw SQL
 * that writes is held, raw SQL that reads is sent.
 */
export function readOnlyDb<T extends object>(client: T, held: HeldWrite[] = []): T {
  let seq = 0;
  const row = (data: unknown) => ({ id: `dryrun_${++seq}`, seq: BigInt(seq), createdAt: new Date(), updatedAt: new Date(), ...(data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {}) });
  const model = (name: string, delegate: object) =>
    new Proxy(delegate, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop);
        if (typeof prop === "string" && MODEL_WRITES.has(prop)) {
          return async (args?: { data?: unknown; create?: unknown }) => {
            held.push({ model: name, method: prop });
            if (prop === "createMany" || prop === "updateMany" || prop === "deleteMany") return { count: Array.isArray(args?.data) ? args.data.length : 0 };
            if (prop === "createManyAndReturn" || prop === "updateManyAndReturn") return (Array.isArray(args?.data) ? args.data : []).map(row);
            return row(prop === "upsert" ? args?.create : args?.data);
          };
        }
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  const proxy: T = new Proxy(client, {
    get(target, prop) {
      if (prop === "$transaction") {
        return async (arg: unknown) => (typeof arg === "function" ? (arg as (tx: T) => unknown)(proxy) : Promise.all(arg as readonly unknown[]));
      }
      if (prop === "$executeRaw" || prop === "$executeRawUnsafe") {
        return async () => {
          held.push({ model: "$raw", method: prop });
          return 0;
        };
      }
      const value: unknown = Reflect.get(target, prop);
      if ((prop === "$queryRaw" || prop === "$queryRawUnsafe") && typeof value === "function") {
        return async (...args: unknown[]) => {
          if (SQL_WRITE.test(sqlText(args))) {
            held.push({ model: "$raw", method: prop });
            return [];
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (typeof prop === "string" && !prop.startsWith("$") && !prop.startsWith("_") && value && typeof value === "object") return model(prop, value);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return proxy;
}

/** The real dependencies: the database, the Spend Book and the sealed tokens (loaded only when the script runs). */
async function realDeps(): Promise<RunDeps> {
  const { prisma } = await import("@/lib/db");
  const { getAssetAccess } = await import("@/lib/meta-connect");
  const book = await import("@/lib/spend/book");
  const KEY = "sandbox:runbook-lock";
  const dryDb = readOnlyDb(prisma);
  return {
    async loadAsset(tenantId, assetId) {
      const row = (await prisma.metaAsset.findFirst({ where: { id: assetId, tenantId }, select: { id: true, tenantId: true, type: true, externalId: true, sandbox: true } })) as Omit<AssetRow, "token"> | null;
      if (!row) return null;
      let token: string | null = null;
      try {
        token = (await getAssetAccess(tenantId, assetId)).token;
      } catch {
        token = null;
      }
      return { ...row, token };
    },
    phase0Activity: (_tenantId, adAccountAssetId) =>
      phase0ActivityIn(
        {
          accountExternalId: async (id) => (await prisma.metaAsset.findUnique({ where: { id }, select: { externalId: true } }))?.externalId ?? null,
          sandboxTenants: async (externalIds) =>
            (await prisma.metaAsset.findMany({ where: { type: "ad_account", sandbox: true, externalId: { in: [...externalIds] } }, select: { tenantId: true } })).map((r) => r.tenantId),
          simRows: (tenantIds, since) => prisma.spendDaily.count({ where: { tenantId: { in: [...tenantIds] }, source: "sim", syncedAt: { gt: since } } }),
          otherSandboxLedgerRows: (tenantIds, since) =>
            prisma.spendLedger.count({
              where: {
                tenantId: { in: [...tenantIds] },
                sandbox: true,
                createdAt: { gt: since },
                OR: [{ actorType: { not: "system" } }, { actorId: null }, { actorId: { not: VERIFY_JOB } }],
              },
            }),
        },
        adAccountAssetId,
      ),
    lock: {
      // One statement, so two runs started at once cannot both take it: the row is written only when it is free, held by this
      // exact holder (each run's own name, lockHolder), or expired.
      async take(holder, minutes) {
        const value = JSON.stringify({ holder, startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + minutes * 60_000).toISOString() });
        const taken = (await prisma.$queryRaw`
          INSERT INTO "PlatformSetting" (key, value, "updatedAt") VALUES (${KEY}, ${value}::jsonb, now())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()
          WHERE "PlatformSetting".value->>'holder' = ${holder} OR coalesce(("PlatformSetting".value->>'expiresAt')::timestamptz, 'epoch') < now()
          RETURNING key`) as { key: string }[];
        if (taken.length > 0) return null;
        const row = (await prisma.platformSetting.findUnique({ where: { key: KEY } })) as { value: unknown } | null;
        const v = (row?.value ?? null) as { holder?: string; startedAt?: string } | null;
        return `${v?.holder ?? "another runbook"} has held it since ${v?.startedAt ?? "earlier"}`;
      },
      async release(holder) {
        await prisma.$executeRaw`DELETE FROM "PlatformSetting" WHERE key = ${KEY} AND value->>'holder' = ${holder}`;
      },
    },
    // No lowerLeadForm: Phase 0's Book has no lead-form lowering yet, so forms are kept rather than ledgered as ad archives.
    book: { permitForPausedCreate: (t, a, n, actor) => book.permitForPausedCreate(t, a, n, actor), recordLowering: (t, i, actor, reason, run, o) => book.recordLowering(t, i, actor, reason, run, o) },
    // A dry run's Book: the same checks and permits, its reads from the database, and nothing written to it.
    dryRunBook: {
      permitForPausedCreate: (t, a, n, actor) => book.permitForPausedCreate(t, a, n, actor, { db: dryDb }),
      recordLowering: (t, i, actor, reason, run, o) => book.recordLowering(t, i, actor, reason, run, { ...o, db: dryDb }),
    },
  };
}

function summary(report: RunReport): string {
  const lines = [`PRM-VERIFY run ${report.runId} (${report.mode}) on ${report.account.externalId}, lock ${report.lock}`];
  if (report.spendBook === "memory") lines.push("Dry run: nothing was written to the Spend Book.");
  for (const s of report.steps) {
    const failed = s.checks.filter((c) => !c.passed && !c.skipped).map((c) => c.id);
    const skipped = s.checks.filter((c) => c.skipped).map((c) => c.id);
    lines.push(`  ${s.step.padEnd(7)} ${s.status.padEnd(8)} ${s.title}${failed.length ? ` | failed: ${failed.join(", ")}` : ""}${skipped.length ? ` | skipped: ${skipped.join(", ")}` : ""}`);
  }
  lines.push(`Steps passed: ${report.passedSteps.join(", ") || "none"}`);
  if (report.movedRows.length) lines.push(`Rows moved to sandbox: ${report.movedRows.length}`);
  if (report.leftBehind.length) lines.push(`Not archived (archive these by hand in Ads Manager): ${report.leftBehind.join("; ")}`);
  if (report.kept.length) lines.push(`Kept, named PRM-VERIFY (each says why): ${report.kept.join("; ")}`);
  if (report.wrote.report) lines.push(`Report: ${report.wrote.report}`);
  for (const m of report.manual) lines.push(`Manual ${m.step}: ${m.note}`);
  return lines.join("\n");
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArgs(argv);
    const report = await runVerifyCatalog({ ...args, env: process.env }, await realDeps());
    console.log(summary(report));
    return report.leftBehind.length ? 2 : 0;
  } catch (e) {
    console.error(e instanceof VerifyRefusal ? `Refused: ${e.message}` : `Failed: ${errorOf(e).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
