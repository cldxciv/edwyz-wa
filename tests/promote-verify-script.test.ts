import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { graphBaseOverride } from "@/lib/graph";
import { spendDryRun } from "@/lib/spend/flags";
import { mintPermit } from "@/lib/spend/permit";
import { setTripwireAuditSink, type TripwireAuditEvent } from "@/lib/spend/tripwire";
import {
  assertVerifyBody,
  DRY_RUN_MARKER,
  DRY_RUN_TAG,
  fixtureName,
  FORBIDDEN_CLASSES,
  guardedPorts,
  insideProject,
  LOCK_HOLDER_PREFIX,
  lockHolder,
  parseArgs,
  passedRows,
  phase0ActivityIn,
  readOnlyDb,
  readVerifiedRows,
  regenerateVerified,
  REPO_FIXTURES_DIR,
  REPO_REPORT_PATH,
  REPO_VERIFIED_PATH,
  rowRefs,
  runVerifyCatalog,
  sanitize,
  STEP_IDS,
  VERIFY_JOB,
  VERIFY_PREFIX,
  VerifyRefusal,
  type AssetRow,
  type BookPort,
  type CallRecord,
  type HeldWrite,
  type PathProbe,
  type Phase0Queries,
  type RunDeps,
  type RunOptions,
  type RunReport,
  type StepResult,
} from "../scripts/promote-verify-catalog";
import { createFakeMetaPromote, FAKE_ACT, FAKE_IG_ID, FAKE_PAGE_ID, FAKE_USER_TOKEN, type FakeMetaPromote } from "./helpers/fake-meta-promote";

/**
 * scripts/promote-verify-catalog.ts (docs/IG-PAGE-ADS-SPEC.md 9.6, PRM-16), run with --dry-run against the in-process fake
 * Meta. The Spend Book is replaced by one that mints real permits (the ads client and the transport tripwire run for real, in
 * enforce mode), so the fake's classify recorder sees exactly what a sandbox run would send.
 *
 * Also the end-to-end harness of 9.4: playwright.config.ts starts the app itself with the fake's settings, e2e/global-setup.ts
 * and e2e/promote-helpers.ts read those settings (never the runner's own shell), and the specs prove per test that the app
 * reads Graph from the fake.
 */

// e2e/promote-helpers.ts is imported below with its Playwright-side neighbours stubbed: only its guard is under test, and the
// real e2e/helpers.ts would load the app's .env. defineConfig and devices let playwright.config.ts load.
vi.mock("../e2e/helpers", () => ({ BASE: "http://localhost:3500", ORIGIN: "http://localhost:3500", connectFakeNumber: vi.fn(), db: vi.fn(), signupUser: vi.fn(), stamp: () => "1" }));
vi.mock("../e2e/growth-helpers", () => ({ axeSerious: vi.fn(), overflowsX: vi.fn(), seal: vi.fn(), seedMeta: vi.fn(), setCap: vi.fn() }));
vi.mock("../e2e/spend-kit", () => ({ liftNewWorkspaceLimits: vi.fn(), seedSpendControl: vi.fn() }));
vi.mock("../e2e/auth-onboarding-util", () => ({ joinWorkspace: vi.fn(), skipWelcome: vi.fn() }));
vi.mock("@playwright/test", () => ({
  expect: Object.assign(vi.fn(), { poll: vi.fn(), configure: vi.fn() }),
  test: vi.fn(),
  defineConfig: (config: unknown) => config,
  devices: { "Desktop Chrome": {}, "Pixel 7": {} },
}));

type Json = Record<string, unknown>;

// =====================================================================================================================
// A harness: assets, the lock, Phase 0's activity and a Spend Book that mints real permits
// =====================================================================================================================

type Harness = {
  fake: FakeMetaPromote;
  deps: RunDeps;
  /** The minting in-memory Book (the dry run's Book, and the one the port tests use). */
  memBook: BookPort;
  lock: { holder: string | null; takes: number; releases: number; taken: string[] };
  /** Ads objects archived through recordLowering (an ads ledger row each). */
  lowered: string[];
  /** Lead forms archived through lowerLeadForm (no ads ledger row). */
  formLowered: string[];
  createPermits: number;
  /** Calls that reached deps.book, the sandbox run's Book. A dry run must make none. */
  realBookCalls: number;
};

function harness(opts: { sandbox?: boolean; lockHeldBy?: string | null; phase0?: string | null; formLowering?: boolean; dryRunBook?: boolean } = {}): Harness {
  const fake = createFakeMetaPromote();
  const h: Harness = { fake, deps: undefined as unknown as RunDeps, memBook: undefined as unknown as BookPort, lock: { holder: opts.lockHeldBy ?? null, takes: 0, releases: 0, taken: [] }, lowered: [], formLowered: [], createPermits: 0, realBookCalls: 0 };
  let seq = 0;
  const lowering = (tenantId: string, objectId: string) => {
    const now = new Date();
    return mintPermit({ type: "lowering", kind: "archive", correlationId: `l_${++seq}`, tenantId, metaObjectIds: [objectId], paths: [objectId], maxUses: 2, issuedAt: now, expiresAt: new Date(now.getTime() + 120_000) });
  };
  const memBook: BookPort = {
    async permitForPausedCreate(tenantId, act, objectCount) {
      h.createPermits++;
      const now = new Date();
      return mintPermit({
        type: "create",
        correlationId: `c_${++seq}`,
        tenantId,
        adAccountExternalId: act,
        objectCount,
        paths: [`${act}/campaigns`, `${act}/adsets`, `${act}/adcreatives`, `${act}/ads`],
        maxUses: objectCount + 2,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + 600_000),
      });
    },
    async recordLowering(tenantId, intent, _actor, _reason, run) {
      const permit = lowering(tenantId, intent.metaObjectId);
      await run(permit);
      h.lowered.push(intent.metaObjectId);
      return { correlationId: permit.correlationId };
    },
    ...(opts.formLowering === false
      ? {}
      : {
          async lowerLeadForm(tenantId: string, formId: string, _actor: unknown, run: (permit: ReturnType<typeof lowering>) => Promise<void>) {
            h.formLowered.push(formId);
            await run(lowering(tenantId, formId));
          },
        }),
  };
  h.memBook = memBook;
  const counted: BookPort = {
    permitForPausedCreate: (...a) => (h.realBookCalls++, memBook.permitForPausedCreate(...a)),
    recordLowering: (...a) => (h.realBookCalls++, memBook.recordLowering(...a)),
  };
  const assets = (tenantId: string): Record<string, AssetRow> => ({
    acc: { id: "acc", tenantId, type: "ad_account", externalId: FAKE_ACT, sandbox: opts.sandbox !== false, token: "never-sent-in-a-dry-run" },
    page: { id: "page", tenantId, type: "page", externalId: FAKE_PAGE_ID, sandbox: false, token: "never-sent-in-a-dry-run" },
    ig: { id: "ig", tenantId, type: "instagram", externalId: FAKE_IG_ID, sandbox: false, token: "never-sent-in-a-dry-run" },
  });
  h.deps = {
    loadAsset: async (tenantId, id) => assets(tenantId)[id] ?? null,
    phase0Activity: async () => opts.phase0 ?? null,
    // The real lock's rule: taken when free or held by this exact holder; released only by this exact holder.
    lock: {
      async take(holder) {
        h.lock.takes++;
        if (h.lock.holder && h.lock.holder !== holder) return `${h.lock.holder} has held it since 10:00`;
        h.lock.holder = holder;
        h.lock.taken.push(holder);
        return null;
      },
      async release(holder) {
        h.lock.releases++;
        if (h.lock.holder === holder) h.lock.holder = null;
      },
    },
    book: counted,
    ...(opts.dryRunBook === false ? {} : { dryRunBook: memBook }),
    fake,
    fakeIds: {
      act: FAKE_ACT,
      pageId: FAKE_PAGE_ID,
      igId: FAKE_IG_ID,
      userToken: FAKE_USER_TOKEN,
      pageToken: fake.pageToken(),
      whatsappNumber: "919800000001",
      unlinkedWhatsappNumber: "919800000002",
      videoUrl: "https://example.com/prm-verify.mp4",
    },
  };
  return h;
}

const ENV = { SPEND_TRIPWIRE: "enforce", SPEND_DRY_RUN: "", SPEND_SIM: "", GRAPH_BASE_URL: "" };
const options = (over: Partial<RunOptions> = {}): RunOptions => ({
  dryRun: true,
  tenantId: "t_prm_verify",
  accountAssetId: "acc",
  pageAssetId: "page",
  instagramAssetId: "ig",
  write: false,
  verifiedPath: "unused-verified.ts",
  fixturesDir: "unused-fixtures",
  reportPath: null,
  now: new Date("2026-10-31T10:00:00Z"),
  env: ENV,
  ...over,
});

const ROOT = path.resolve(__dirname, "..");
const REAL_VERIFIED = path.resolve(__dirname, "../src/lib/promote/catalog/verified.ts");
const RUN_ID = "20261031T100000Z";
const tripwireEvents: TripwireAuditEvent[] = [];
const formIdsOf = (report: RunReport): string[] =>
  report.steps.flatMap((s) => s.calls).filter((c) => c.ok && c.pattern.endsWith("/leadgen_forms") && c.method === "POST").map((c) => String((c.response as Json).id));

beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  setTripwireAuditSink((e) => void tripwireEvents.push(e));
});
afterAll(() => {
  setTripwireAuditSink(null);
  vi.unstubAllEnvs();
});

// =====================================================================================================================
// One full dry run, written to temporary copies
// =====================================================================================================================

describe("a --dry-run against the fake Meta", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "prm-verify-"));
  const verifiedCopy = path.join(dir, "verified.ts");
  const fixturesDir = path.join(dir, "fixtures");
  const reportPath = path.join(dir, "report-{runId}.json");
  const realBefore = readFileSync(REAL_VERIFIED, "utf8");
  let h: Harness;
  let report: RunReport;
  let objectsBefore: Set<string>;
  const fetchBefore = globalThis.fetch;

  beforeAll(async () => {
    writeFileSync(verifiedCopy, realBefore);
    h = harness();
    objectsBefore = new Set(h.fake.base.objects.keys());
    tripwireEvents.length = 0;
    report = await runVerifyCatalog(options({ write: true, verifiedPath: verifiedCopy, fixturesDir, reportPath }), h.deps);
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("runs every automated step, lists V-P16 and V-P17 as manual, and gives its own lock and fetch back", () => {
    const ran = report.steps.map((s) => s.step).sort();
    expect(ran).toEqual([...STEP_IDS].sort());
    expect(report.steps.filter((s) => s.status === "manual").map((s) => s.step)).toEqual(["V-P16", "V-P17"]);
    expect(report.mode).toBe("dry-run");
    expect(report.lock).toMatch(new RegExp(`^${LOCK_HOLDER_PREFIX}${RUN_ID}:[0-9a-f]{8}@`));
    expect(h.lock).toMatchObject({ holder: null, takes: 1, releases: 1, taken: [report.lock] });
    expect(globalThis.fetch).toBe(fetchBefore);
  });

  it("writes nothing to the Spend Book: every permit comes from the dry run's Book", () => {
    expect(report.spendBook).toBe("memory");
    expect(h.realBookCalls).toBe(0);
    expect(h.createPermits).toBeGreaterThan(20);
  });

  it("creates only PAUSED objects named 'PRM-VERIFY …' (creatives without a status), each under a create permit", () => {
    const creates = h.fake.calls.filter((c) => c.class === "ads_create");
    expect(creates.length).toBeGreaterThan(20);
    expect(creates.some((c) => c.pattern.endsWith("/ads"))).toBe(true);
    for (const c of creates) {
      const body = c.body as Json;
      expect(String(body.name), c.pattern).toMatch(/^PRM-VERIFY /);
      if (c.pattern.endsWith("/adcreatives")) expect(body, "a creative carries no status").not.toHaveProperty("status");
      else expect(body.status, c.pattern).toBe("PAUSED");
      expect(c.permitted, c.pattern).toBe(true);
    }
    expect(h.createPermits).toBe(creates.length);
    // Named not-spend creates carry the prefix too.
    const named = h.fake.calls.filter((c) => c.method === "POST" && /\/(leadgen_forms|customaudiences|adspixels|advideos|adimages)$/.test(c.path));
    expect(named.length).toBeGreaterThan(10);
    for (const c of named) expect(String((c.body as Json).name), c.path).toMatch(/^PRM-VERIFY /);
  });

  it("reads back and archives every campaign, ad set and ad it made, through a ledgered lowering", () => {
    const made = [...h.fake.base.objects.entries()].filter(([id]) => !objectsBefore.has(id)).map(([, o]) => o);
    expect(made.length).toBeGreaterThan(20);
    for (const o of made) {
      expect(o.name).toMatch(/^PRM-VERIFY /);
      expect(o.status, o.name).toBe("ARCHIVED");
    }
    const lowerings = h.fake.calls.filter((c) => c.class === "ads_lowering");
    expect(lowerings.length).toBeGreaterThanOrEqual(made.length);
    for (const l of lowerings) {
      expect(l.body).toEqual({ status: "ARCHIVED" });
      expect(l.permitted).toBe(true);
    }
    for (const o of made) expect(h.lowered).toContain(o.id);
    // Every PAUSED object was read back before it was archived.
    const reads = new Set(h.fake.calls.filter((c) => c.method === "GET").map((c) => c.path));
    for (const o of made) expect(reads.has(o.id), `read back ${o.name}`).toBe(true);
  });

  it("archives each lead form with the Page token under the Book's lead-form lowering, never an ads ledger row", () => {
    const forms = formIdsOf(report);
    expect(forms.length).toBeGreaterThan(3);
    for (const id of forms) {
      const archive = h.fake.calls.filter((c) => c.method === "POST" && c.path === id);
      expect(archive, `form ${id}`).toHaveLength(1);
      expect(archive[0].body).toEqual({ status: "ARCHIVED" });
      expect(archive[0].tokenKind, "a form's status goes with the Page token").toBe("page");
      expect(archive[0].permitted).toBe(true);
      expect(h.formLowered).toContain(id);
      expect(h.lowered, "no ad-level ledger row for a form").not.toContain(id);
    }
  });

  it("never calls a spend-class edge: no activation, raise, Meta limit or message, and no tripwire event", () => {
    for (const c of h.fake.calls) expect(FORBIDDEN_CLASSES.has(c.class), `${c.method} ${c.pattern} is ${c.class}`).toBe(false);
    expect(h.fake.calls.filter((c) => c.class !== "not_spend").every((c) => c.permitted)).toBe(true);
    expect(() => h.fake.assertClean()).not.toThrow();
    expect(h.fake.relayedCalls()).toEqual([]);
    expect(tripwireEvents).toEqual([]);
    // Nothing was ever set ACTIVE or given a budget after creation.
    for (const c of h.fake.calls.filter((x) => x.method === "POST" && /^\d+$|^[A-Za-z0-9_]+$/.test(x.path) && !x.path.includes("/"))) {
      expect(c.body).toEqual({ status: "ARCHIVED" });
    }
  });

  it("V-P12 passes only on the linked number coming back; V-P12+ uses the unlinked number", () => {
    const vp12 = report.steps.find((s) => s.step === "V-P12")!;
    expect(vp12.status).toBe("passed");
    expect(vp12.checks[0].evidence).toMatchObject({ matchesLinkedNumber: true });
    const adSets = h.fake.calls.filter((c) => c.class === "ads_create" && c.pattern.endsWith("/adsets") && String((c.body as Json).name).includes("V-P12+"));
    expect(adSets).toHaveLength(1);
    const promoted = (adSets[0].body as Json).promoted_object;
    expect(typeof promoted === "string" ? JSON.parse(promoted) : promoted).toMatchObject({ whatsapp_phone_number: "919800000002" });
  });

  it("regenerates verified.ts with only the passed rows moved to 'sandbox', stamped as dry-run output (on the temporary copy)", () => {
    const before = readVerifiedRows(realBefore);
    const text = readFileSync(verifiedCopy, "utf8");
    const after = readVerifiedRows(text);
    expect([...after.keys()]).toEqual([...before.keys()]);
    const passed = passedRows(report.steps, [...before.keys()]);
    for (const [key, state] of after) {
      const was = before.get(key)!;
      if (was === "docs" && passed.has(key)) expect(state, key).toBe("sandbox");
      else expect(state, key).toBe(was);
    }
    expect(report.movedRows.sort()).toEqual([...passed].filter((k) => before.get(k) === "docs").sort());
    expect(report.movedRows.length).toBeGreaterThan(0);
    // What the fake can answer moves; what it cannot read back (creatives, effective placements) stays at docs.
    expect(after.get("feature.previews")).toBe("sandbox");
    expect(after.get("question.FULL_NAME")).toBe("sandbox");
    expect(after.get("audience_event.ig_all")).toBe("sandbox");
    expect(after.get("shape.ig_media_boost")).toBe("docs");
    expect(after.get("placement.instagram_feed")).toBe("docs");
    // A goal that needs the owner-present check (V-P17) never moves here; nor one whose boost button failed.
    expect(after.get("goal.profile_visits")).toBe("docs");
    expect(after.get("goal.lead_form")).toBe("docs");
    // Every moved row has every one of its steps behind it.
    for (const key of report.movedRows) for (const step of rowRefs(key) ?? []) expect(report.steps.find((s) => s.step === step)?.status, `${key} needs ${step}`).not.toBe("manual");
    expect(text.split(/\r?\n/)[0]).toBe(DRY_RUN_MARKER);
    expect(text).toContain(`export const VERIFIED_GENERATED_AT: string | null = "2026-10-31T10:00:00.000Z";`);
    expect(text).toMatch(/export const VERIFIED_RUNBOOK_STEPS: readonly string\[\] = \[.*"V-P5".*\];/);
    expect(text).not.toMatch(/"V-P16"|"V-P17"/);
    // A sandbox run refuses to build on a dry run's output.
    expect(() => regenerateVerified(text, new Set(), [], new Date())).toThrow(/dry run's output/);
  });

  it("leaves the repository's verified.ts alone", () => {
    expect(readFileSync(REAL_VERIFIED, "utf8")).toBe(realBefore);
  });

  it("pins one fixture per step and run with only its passed checks, and no token anywhere", () => {
    expect(report.wrote.fixtures.length).toBeGreaterThan(0);
    for (const file of report.wrote.fixtures) {
      expect(path.basename(file)).toMatch(new RegExp(`^V-P\\d+\\+?\\.${RUN_ID}\\.json$`));
      const text = readFileSync(file, "utf8");
      expect(text).not.toContain(FAKE_USER_TOKEN);
      expect(text).not.toMatch(/FAKE_PAGE_TOKEN|access_token|appsecret_proof/);
      const fixture = JSON.parse(text) as { step: string; runId: string; mode: string; checks: { id: string; passed: boolean }[]; calls: CallRecord[] };
      expect(fixture).toMatchObject({ runId: RUN_ID, mode: "dry-run" });
      expect(path.basename(file)).toBe(fixtureName(fixture.step as StepResult["step"], RUN_ID));
      expect(fixture.checks.every((c) => c.passed)).toBe(true);
      const ids = new Set(fixture.checks.map((c) => c.id));
      for (const call of fixture.calls) expect(call.check === "setup" || ids.has(call.check)).toBe(true);
    }
    const steps = report.wrote.fixtures.map((f) => path.basename(f).split(".")[0]);
    expect(steps).toContain("V-P5");
    expect(steps).not.toContain("V-P14");
    // The report path's {runId} is this run's id.
    expect(report.wrote.report).toBe(path.join(dir, `report-${RUN_ID}.json`));
    const saved = JSON.parse(readFileSync(report.wrote.report!, "utf8")) as RunReport;
    expect(saved).toMatchObject({ runId: RUN_ID, mode: "dry-run", spendBook: "memory", lock: report.lock });
  });

  it("a later partial run writes its own files and leaves the earlier run's evidence in place", async () => {
    const earlier = readdirSync(fixturesDir).sort();
    const h2 = harness();
    const later = await runVerifyCatalog(options({ steps: ["V-P5"], write: true, verifiedPath: verifiedCopy, fixturesDir, reportPath, now: new Date("2026-11-01T09:30:00Z") }), h2.deps);
    expect(later.runId).toBe("20261101T093000Z");
    const now = readdirSync(fixturesDir).sort();
    for (const f of earlier) expect(now).toContain(f);
    expect(now).toContain(fixtureName("V-P5", "20261101T093000Z"));
    expect(existsSync(path.join(dir, `report-${RUN_ID}.json`))).toBe(true);
    expect(existsSync(path.join(dir, "report-20261101T093000Z.json"))).toBe(true);
    // Rows never move down: what the first run moved is still at sandbox.
    const rows = readVerifiedRows(readFileSync(verifiedCopy, "utf8"));
    for (const key of report.movedRows) expect(rows.get(key), key).toBe("sandbox");
  }, 60_000);
});

// =====================================================================================================================
// Refusals: nothing is sent
// =====================================================================================================================

describe("refusals before anything is sent", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a non-sandbox ad account", async () => {
    const h = harness({ sandbox: false });
    await expect(runVerifyCatalog(options(), h.deps)).rejects.toThrow(/Only a Meta sandbox ad account/);
    expect(h.fake.calls).toEqual([]);
    expect(h.lock.takes).toBe(0);
    await expect(runVerifyCatalog(options({ dryRun: false }), h.deps)).rejects.toBeInstanceOf(VerifyRefusal);
  });

  it("refuses an asset of the wrong kind", async () => {
    const h = harness();
    await expect(runVerifyCatalog(options({ accountAssetId: "page" }), h.deps)).rejects.toThrow(/not a ad_account|is a page/);
    expect(h.fake.calls).toEqual([]);
  });

  it("refuses to run alongside Phase 0's runbook: the shared lock, its activity on the sandbox, SPEND_SIM", async () => {
    const held = harness({ lockHeldBy: "phase0" });
    await expect(runVerifyCatalog(options(), held.deps)).rejects.toThrow(/sandbox is in use: phase0/);
    expect(held.fake.calls).toEqual([]);
    expect(held.lock.holder).toBe("phase0");

    const sim = harness({ phase0: "synthetic spend rows in the last 2 hours" });
    await expect(runVerifyCatalog(options(), sim.deps)).rejects.toThrow(/Phase 0's runbook is using the sandbox/);
    expect(sim.lock.takes).toBe(0);

    const env = harness();
    await expect(runVerifyCatalog(options({ env: { ...ENV, SPEND_SIM: "1" } }), env.deps)).rejects.toThrow(/SPEND_SIM=1/);
    expect(env.fake.calls).toEqual([]);
  });

  it("two promote runs at once: the second is refused, names who holds the lock, and never releases it", async () => {
    const other = lockHolder("20261031T095900Z", "ops-laptop", "1a2b3c4d");
    const h = harness({ lockHeldBy: other });
    await expect(runVerifyCatalog(options(), h.deps)).rejects.toThrow(new RegExp(`sandbox is in use: ${other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} has held it`));
    expect(h.lock).toMatchObject({ holder: other, releases: 0 });
    expect(h.fake.calls).toEqual([]);
    // The old shared name "promote" is someone else's too: never re-entered.
    const legacy = harness({ lockHeldBy: "promote" });
    await expect(runVerifyCatalog(options(), legacy.deps)).rejects.toThrow(/sandbox is in use: promote has held it/);
    expect(legacy.lock.holder).toBe("promote");
  });

  it("a dry run never writes inside a project or repository checkout, whatever the working directory or casing", async () => {
    const h = harness();
    const refuse = (over: Partial<RunOptions>) => expect(runVerifyCatalog(options({ write: true, ...over }), h.deps)).rejects.toThrow(/never writes inside a project or repository/);
    const tmp = mkdtempSync(path.join(tmpdir(), "prm-verify-ok-"));
    try {
      await refuse({ verifiedPath: REPO_VERIFIED_PATH, fixturesDir: tmp });
      await refuse({ verifiedPath: path.join(tmp, "verified.ts"), fixturesDir: REPO_FIXTURES_DIR });
      // From another directory: ../wa/src/... resolves into the repository all the same.
      await refuse({ verifiedPath: path.join(ROOT, "..", path.basename(ROOT), "src", "lib", "promote", "catalog", "verified.ts"), fixturesDir: tmp });
      // A folder that does not exist yet, inside the repository.
      await refuse({ verifiedPath: path.join(tmp, "verified.ts"), fixturesDir: path.join(ROOT, "tmp-prm-not-here", "fixtures") });
      // The report counts too, even without --write.
      await expect(runVerifyCatalog(options({ reportPath: path.join(ROOT, "tests", "fixtures", "promote-verified", "run-report-{runId}.json") }), h.deps)).rejects.toThrow(/never writes inside/);
      // Windows paths match whatever the letter case.
      if (process.platform === "win32") await refuse({ verifiedPath: REAL_VERIFIED.toUpperCase(), fixturesDir: tmp });
      expect(h.fake.calls).toEqual([]);
      expect(h.lock.takes).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a dry run needs a Spend Book that writes nothing", async () => {
    const h = harness({ dryRunBook: false });
    await expect(runVerifyCatalog(options(), h.deps)).rejects.toThrow(/Spend Book that writes nothing/);
    expect(h.fake.calls).toEqual([]);
    expect(h.lock.takes).toBe(0);
    expect(h.realBookCalls).toBe(0);
  });

  it("a sandbox run refuses GRAPH_BASE_URL (its calls would reach a test server, not Meta)", async () => {
    const h = harness();
    await expect(runVerifyCatalog(options({ dryRun: false, env: { ...ENV, GRAPH_BASE_URL: "http://127.0.0.1:4010" } }), h.deps)).rejects.toThrow(/GRAPH_BASE_URL is set/);
  });

  it("manual steps are attested only by a named person, never in a dry run, and only V-P16 or V-P17", async () => {
    const h = harness();
    await expect(runVerifyCatalog(options({ attest: ["V-P17"], operator: "Owner and deployer" }), h.deps)).rejects.toThrow(/dry run can't record a manual check/);
    await expect(runVerifyCatalog(options({ dryRun: false, attest: ["V-P17"] }), h.deps)).rejects.toThrow(/--operator/);
    await expect(runVerifyCatalog(options({ dryRun: false, attest: ["V-P5"], operator: "x" }), h.deps)).rejects.toThrow(/not a manual step/);
    expect(h.fake.calls).toEqual([]);
  });
});

describe("insideProject", () => {
  it("is true at or below a folder that holds package.json or .git, and false in a temporary folder", () => {
    expect(insideProject(REAL_VERIFIED)).toBe(true);
    expect(insideProject(path.join(ROOT, "no-such-folder", "deeper", "verified.ts"))).toBe(true);
    const tmp = mkdtempSync(path.join(tmpdir(), "prm-inside-"));
    try {
      expect(insideProject(path.join(tmp, "verified.ts"))).toBe(false);
      expect(insideProject(path.join(tmp, "a", "b", "fixtures"))).toBe(false);
      writeFileSync(path.join(tmp, "package.json"), "{}");
      expect(insideProject(path.join(tmp, "a", "verified.ts"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("asks the file system, so a case-insensitive one matches any casing, and a link is followed to its real folder", () => {
    // A case-insensitive file system with one checkout at C:\Work\Repo and a link C:\Temp\link -> C:\Work\Repo\src.
    const files = new Set(["c:\\work\\repo\\package.json", "c:\\work\\repo\\src", "c:\\temp\\link", "c:\\temp", "c:\\work\\repo", "c:\\work", "c:\\"]);
    const probe: PathProbe = {
      exists: (p) => files.has(p.toLowerCase()),
      realpath: (p) => (p.toLowerCase() === "c:\\temp\\link" ? "C:\\Work\\Repo\\src" : p),
    };
    if (process.platform !== "win32") return; // path.win32 semantics are what this models
    expect(insideProject("C:\\WORK\\REPO\\SRC\\verified.ts", probe)).toBe(true);
    expect(insideProject("C:\\Temp\\link\\verified.ts", probe)).toBe(true);
    expect(insideProject("C:\\Temp\\other\\verified.ts", probe)).toBe(false);
  });
});

describe("lockHolder", () => {
  it("names the run, a nonce and the host, so two runs never share it", () => {
    expect(lockHolder("20261031T100000Z", "ops laptop!", "1a2b3c4d")).toBe("promote:20261031T100000Z:1a2b3c4d@opslaptop");
    const a = lockHolder("20261031T100000Z", "same-host");
    const b = lockHolder("20261031T100000Z", "same-host");
    expect(a).not.toBe(b);
    expect(a.startsWith(LOCK_HOLDER_PREFIX)).toBe(true);
  });
});

describe("phase0ActivityIn: Phase 0 on the same sandbox account, in any workspace", () => {
  const queries = (over: Partial<Phase0Queries> & { tenants?: string[] } = {}) => {
    const seen: { externalIds: string[][]; sim: string[][]; ledger: string[][]; since: Date[] } = { externalIds: [], sim: [], ledger: [], since: [] };
    const q: Phase0Queries = {
      accountExternalId: async () => "act_42",
      sandboxTenants: async (ids) => (seen.externalIds.push([...ids]), over.tenants ?? ["t_promote", "t_phase0"]),
      simRows: async (t, since) => (seen.sim.push([...t]), seen.since.push(since), 0),
      otherSandboxLedgerRows: async (t) => (seen.ledger.push([...t]), 0),
      ...over,
    };
    return { q, seen };
  };
  const now = new Date("2026-10-31T10:00:00Z");

  it("checks every workspace that has the sandbox account, with or without act_, over the last 2 hours", async () => {
    const { q, seen } = queries();
    await expect(phase0ActivityIn(q, "acc", now)).resolves.toBeNull();
    expect(seen.externalIds).toEqual([["42", "act_42"]]);
    expect(seen.sim).toEqual([["t_promote", "t_phase0"]]);
    expect(seen.ledger).toEqual([["t_promote", "t_phase0"]]);
    expect(seen.since[0].toISOString()).toBe("2026-10-31T08:00:00.000Z");
  });

  it("refuses on Phase 0's sim rows or on others' Spend Book rows about the sandbox in Phase 0's own workspace", async () => {
    await expect(phase0ActivityIn(queries({ simRows: async () => 3 }).q, "acc", now)).resolves.toMatch(/synthetic spend rows were written in 2 workspaces/);
    await expect(phase0ActivityIn(queries({ otherSandboxLedgerRows: async () => 5 }).q, "acc", now)).resolves.toMatch(/5 rows about the sandbox ad account from someone else/);
  });

  it("says nothing for an account it can't find", async () => {
    await expect(phase0ActivityIn(queries({ accountExternalId: async () => null }).q, "acc", now)).resolves.toBeNull();
    await expect(phase0ActivityIn(queries({ tenants: [] }).q, "acc", now)).resolves.toBeNull();
  });

  it("the script's own rows are told apart by its actor (system, promote-verify-catalog)", () => {
    expect(VERIFY_JOB).toBe("promote-verify-catalog");
  });
});

describe("readOnlyDb: the dry run's Spend Book reads the database and writes nothing", () => {
  const client = () => {
    const calls: string[] = [];
    const c = {
      spendLedger: {
        create: vi.fn(async (_args: unknown) => (calls.push("create"), { id: "real" })),
        createMany: vi.fn(async (_args: unknown) => (calls.push("createMany"), { count: 1 })),
        findFirst: vi.fn(async (_args: unknown) => (calls.push("findFirst"), { id: "row_1" })),
      },
      spendCommitment: {
        updateMany: vi.fn(async (_args: unknown) => (calls.push("updateMany"), { count: 2 })),
        upsert: vi.fn(async (_args: unknown) => (calls.push("upsert"), {})),
      },
      $transaction: vi.fn(async (_fn: unknown) => calls.push("$transaction")),
      $executeRawUnsafe: vi.fn(async (_sql: string) => (calls.push("$executeRawUnsafe"), 1)),
      $queryRaw: vi.fn(async (..._args: unknown[]) => (calls.push("$queryRaw"), [{ n: 1 }])),
    };
    return { c, calls };
  };

  it("holds every model write and answers with the row it would have written; reads go through", async () => {
    const { c, calls } = client();
    const held: HeldWrite[] = [];
    const db = readOnlyDb(c, held);
    const row = (await db.spendLedger.create({ data: { tenantId: "t1", phase: "info" } })) as unknown as Json;
    expect(row).toMatchObject({ tenantId: "t1", phase: "info" });
    expect(String(row.id)).toMatch(/^dryrun_/);
    await expect(db.spendLedger.createMany({ data: [{}, {}] })).resolves.toEqual({ count: 2 });
    await db.spendCommitment.updateMany({ where: {}, data: {} });
    await expect(db.spendCommitment.upsert({ create: { id: "x" }, update: {}, where: {} })).resolves.toMatchObject({ id: "x" });
    await expect(db.spendLedger.findFirst({ where: {} })).resolves.toEqual({ id: "row_1" });
    expect(calls).toEqual(["findFirst"]);
    expect(held).toEqual([
      { model: "spendLedger", method: "create" },
      { model: "spendLedger", method: "createMany" },
      { model: "spendCommitment", method: "updateMany" },
      { model: "spendCommitment", method: "upsert" },
    ]);
  });

  it("runs a transaction's callback on itself, holds raw writes (the spend lock's SQL too) and sends raw reads", async () => {
    const { c, calls } = client();
    const held: HeldWrite[] = [];
    const db = readOnlyDb(c, held);
    const out = await (db.$transaction as unknown as (fn: (tx: typeof db) => Promise<string>) => Promise<string>)(async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))");
      await tx.spendLedger.create({ data: {} });
      return "done";
    });
    expect(out).toBe("done");
    const insert = Object.assign(["INSERT INTO \"SpendLedger\" (id) VALUES (", ")"], { raw: [] }) as unknown as TemplateStringsArray;
    await expect((db.$queryRaw as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>)(insert, "x")).resolves.toEqual([]);
    const select = Object.assign(["select count(*)::int as n from \"SpendDaily\" where \"tenantId\" = ", ""], { raw: [] }) as unknown as TemplateStringsArray;
    await expect((db.$queryRaw as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>)(select, "t1")).resolves.toEqual([{ n: 1 }]);
    expect(calls).toEqual(["$queryRaw"]);
    expect(held.map((w) => `${w.model}.${w.method}`)).toEqual(["$raw.$executeRawUnsafe", "spendLedger.create", "$raw.$queryRaw"]);
  });
});

describe("an attested owner-present check (V-P17) counts like a passed step", () => {
  it("lets a row that needs V-P17 move once its other steps pass in the same run", () => {
    const at = (step: StepResult["step"], checks: StepResult["checks"]): StepResult => ({ step, title: step, status: "passed", checks, calls: [], leftBehind: [], kept: [] });
    const results = [
      at("V-P1", [{ id: "goal:profile_visits", passed: true, rows: ["goal.profile_visits"], evidence: {} }]),
      at("V-P4", [{ id: "profile_destination", passed: true, rows: ["goal.profile_visits"], evidence: {} }]),
    ];
    expect(passedRows(results, ["goal.profile_visits"]).size).toBe(0);
    results.push(at("V-P17", [{ id: "attested", passed: true, rows: [], evidence: { operator: "Owner" } }]));
    expect([...passedRows(results, ["goal.profile_visits"])]).toEqual(["goal.profile_visits"]);
  });
});

describe("the guarded ports refuse anything but reads, PAUSED creates, archives and not-spend writes", () => {
  const setup = (opts: { formLowering?: boolean } = {}) => {
    const h = harness(opts);
    const records: Omit<CallRecord, "step" | "check">[] = [];
    const permit = vi.spyOn(h.memBook, "permitForPausedCreate");
    const lowering = vi.spyOn(h.memBook, "recordLowering");
    const ports = guardedPorts({ tenantId: "t1", adAccountAssetId: "acc", act: FAKE_ACT, userToken: FAKE_USER_TOKEN, pageToken: h.fake.pageToken(), book: h.memBook, record: (r) => void records.push(r) });
    vi.stubGlobal("fetch", h.fake.fetch);
    return { h, ports, records, permit, lowering };
  };
  afterEach(() => vi.unstubAllGlobals());

  it("refuses an activation, a budget raise and Meta's limit without sending them", async () => {
    const { h, ports } = setup();
    await expect(ports.post("23850000000000999", { status: "ACTIVE" })).rejects.toThrow(/ads_raise_or_unknown/);
    await expect(ports.post("23850000000000999", { daily_budget: 99_999 })).rejects.toThrow(/ads_raise_or_unknown/);
    await expect(ports.post(FAKE_ACT, { spend_cap: "1000.00" })).rejects.toThrow(/meta_cap/);
    await expect(ports.post("1234567890/messages", { to: "919800000001", type: "text" })).rejects.toThrow(/msg_send/);
    await expect(ports.post(`${FAKE_ACT}/campaigns`, { name: `${VERIFY_PREFIX}x`, status: "PAUSED" })).rejects.toBeInstanceOf(VerifyRefusal);
    expect(h.fake.calls).toEqual([]);
  });

  it("refuses a create that is not PAUSED or not named PRM-VERIFY, before asking for a permit", async () => {
    const { h, ports, permit } = setup();
    await expect(ports.createPaused("campaigns", { name: `${VERIFY_PREFIX}x`, status: "ACTIVE", objective: "OUTCOME_TRAFFIC" })).rejects.toThrow(/PAUSED/);
    await expect(ports.createPaused("campaigns", { name: "Diwali sale", status: "PAUSED", objective: "OUTCOME_TRAFFIC" })).rejects.toThrow(/PRM-VERIFY/);
    await expect(ports.createPaused("adcreatives", { name: `${VERIFY_PREFIX}x`, status: "PAUSED" })).rejects.toThrow(/no status/);
    await expect(ports.post(`${FAKE_ACT}/customaudiences`, { name: "Customers", subtype: "CUSTOM" })).rejects.toThrow(/PRM-VERIFY/);
    expect(permit).not.toHaveBeenCalled();
    expect(h.fake.calls).toEqual([]);
  });

  it("sends a PAUSED create under a permit and records it with its class and pattern only", async () => {
    const { h, ports, records } = setup();
    const id = await ports.createPaused("campaigns", { name: `${VERIFY_PREFIX}one`, status: "PAUSED", objective: "OUTCOME_TRAFFIC", special_ad_categories: [] });
    await ports.archive(id);
    expect(h.fake.calls.map((c) => [c.class, c.permitted])).toEqual([
      ["ads_create", true],
      ["ads_lowering", true],
    ]);
    expect(records.map((r) => [r.method, r.pattern, r.class, r.ok])).toEqual([
      ["POST", "act_{id}/campaigns", "ads_create", true],
      ["POST", "{id}", "ads_lowering", true],
    ]);
  });

  it("archives a lead form with the Page token under the lead-form lowering, with no ads ledger row", async () => {
    const { h, ports, lowering, records } = setup();
    const form = await ports.post<{ id: string }>(`${FAKE_PAGE_ID}/leadgen_forms`, { name: `${VERIFY_PREFIX}form`, questions: [{ type: "FULL_NAME" }], privacy_policy: { url: "https://example.com/privacy" }, locale: "en_US" }, "page");
    // The fake has no form status: it answers #100 once the call is through, which is enough to see what was sent.
    await ports.archiveForm(form.id).catch(() => undefined);
    const sent = h.fake.calls.filter((c) => c.path === form.id && c.method === "POST");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ class: "ads_lowering", tokenKind: "page", permitted: true, body: { status: "ARCHIVED" } });
    expect(h.formLowered).toEqual([form.id]);
    expect(lowering).not.toHaveBeenCalled();
    expect(h.lowered).toEqual([]);
    expect(records.at(-1)).toMatchObject({ method: "POST", pattern: "{id}", class: "ads_lowering" });
  });

  it("keeps a lead form, sending nothing, while the Book has no lead-form lowering", async () => {
    const { h, ports, lowering } = setup({ formLowering: false });
    await expect(ports.archiveForm("5566778899001122")).resolves.toBe(false);
    expect(h.fake.calls).toEqual([]);
    expect(lowering).not.toHaveBeenCalled();
  });
});

describe("a run whose Book has no lead-form lowering keeps its forms and says so", () => {
  it("lists every form under kept, sends no form archive, and leaves nothing behind for them", async () => {
    const h = harness({ formLowering: false });
    const report = await runVerifyCatalog(options({ steps: ["V-P7"] }), h.deps);
    const forms = formIdsOf(report);
    expect(forms.length).toBeGreaterThan(1);
    for (const id of forms) {
      expect(report.kept.some((k) => k.includes(`lead form ${id}`))).toBe(true);
      expect(report.leftBehind.some((l) => l.includes(id))).toBe(false);
      expect(h.fake.calls.filter((c) => c.method === "POST" && c.path === id)).toEqual([]);
    }
  }, 60_000);
});

describe("V-P12: the Page's whatsapp_number must come back with the linked number", () => {
  const vp12 = async (over: Partial<RunOptions>, strip = false) => {
    const h = harness();
    if (strip) {
      const real = h.fake.fetch;
      h.deps.fake = {
        fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const res = await real(input as never, init as never);
          const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
          if (!url.pathname.endsWith(`/${FAKE_PAGE_ID}`) || !(url.searchParams.get("fields") ?? "").includes("whatsapp_number")) return res;
          // Graph leaves out a field that is not set.
          const body = (await res.json()) as Json;
          delete body.whatsapp_number;
          return new Response(JSON.stringify(body), { status: res.status, headers: { "content-type": "application/json" } });
        }) as FakeMetaPromote["fetch"],
      };
    }
    if (over.whatsappNumber !== undefined) h.deps.fakeIds = { ...h.deps.fakeIds!, whatsappNumber: over.whatsappNumber ?? "" };
    const report = await runVerifyCatalog(options({ steps: ["V-P12"] }), h.deps);
    return report.steps.find((s) => s.step === "V-P12")!;
  };

  it("fails when the field is left out, even though the read succeeded", async () => {
    const step = await vp12({}, true);
    expect(step.status).toBe("failed");
    expect(step.checks[0].error?.message).toMatch(/did not come back/);
  });

  it("fails on a different number, and is skipped without one", async () => {
    const other = await vp12({ whatsappNumber: "919811111111" });
    expect(other.status).toBe("failed");
    expect(other.checks[0].error?.message).toMatch(/not the number given/);
    const none = await vp12({ whatsappNumber: "" });
    expect(none.status).toBe("skipped");
    expect(none.checks[0].skipped).toMatch(/--whatsapp-number/);
  });
});

// =====================================================================================================================
// Pure parts
// =====================================================================================================================

describe("verified.ts regeneration", () => {
  const SOURCE = [
    "// generatedAt: never (hand-seeded by PRM-02)",
    "// runbook steps passed: none",
    'import type { VerifyState } from "../types";',
    "export const VERIFIED_GENERATED_AT: string | null = null;",
    'export const VERIFIED_RUNBOOK_STEPS: readonly string[] = ["V-P9"];',
    "export const VERIFIED: Readonly<Record<string, VerifyState>> = {",
    '  "goal.awareness": "docs",',
    '  "goal.page_likes": "live",',
    '  "feature.previews": "sandbox",',
    '  "question.EMAIL": "docs",',
    "};",
  ].join("\n");

  it("moves only docs rows in the set to sandbox, never down and never to live", () => {
    const { text, moved } = regenerateVerified(SOURCE, new Set(["goal.awareness", "goal.page_likes", "feature.previews"]), ["V-P1", "V-P5"], new Date("2026-11-02T08:00:00Z"));
    expect(moved).toEqual(["goal.awareness"]);
    const rows = readVerifiedRows(text);
    expect(Object.fromEntries(rows)).toEqual({ "goal.awareness": "sandbox", "goal.page_likes": "live", "feature.previews": "sandbox", "question.EMAIL": "docs" });
    expect(text).toContain('export const VERIFIED_RUNBOOK_STEPS: readonly string[] = ["V-P1", "V-P5", "V-P9"];');
    expect(text).toContain('export const VERIFIED_GENERATED_AT: string | null = "2026-11-02T08:00:00.000Z";');
    expect(text).toContain("// runbook steps passed: V-P1, V-P5, V-P9");
    expect(text).not.toContain(DRY_RUN_TAG);
  });

  it("stamps a dry run's output once, and a sandbox run refuses a source that carries the stamp", () => {
    const dry = regenerateVerified(SOURCE, new Set(), [], new Date()).text;
    const once = regenerateVerified(SOURCE, new Set(["goal.awareness"]), ["V-P1"], new Date(), { dryRun: true }).text;
    expect(dry).not.toContain(DRY_RUN_TAG);
    expect(once.startsWith(`${DRY_RUN_MARKER}\n`)).toBe(true);
    const twice = regenerateVerified(once, new Set(), [], new Date(), { dryRun: true }).text;
    expect(twice.split(DRY_RUN_TAG).length - 1).toBe(1);
    expect(() => regenerateVerified(once, new Set(), [], new Date())).toThrow(/dry run's output/);
  });

  it("refuses a file that is not the generated shape", () => {
    expect(() => regenerateVerified("export const X = 1;", new Set(), [], new Date())).toThrow(/not in the generated shape/);
  });

  it("keeps the real file's rows parseable and every row's steps known", () => {
    const rows = readVerifiedRows(readFileSync(REAL_VERIFIED, "utf8"));
    expect(rows.size).toBeGreaterThan(70);
    for (const key of rows.keys()) {
      const refs = rowRefs(key);
      expect(refs, key).not.toBeNull();
      for (const r of refs ?? []) expect(STEP_IDS as readonly string[], `${key} -> ${r}`).toContain(r);
    }
  });
});

describe("the committed verification record", () => {
  const dir = path.join(ROOT, REPO_FIXTURES_DIR);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  const parsed = files.map((f) => ({ file: f, json: JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { mode?: string; passedSteps?: string[]; movedRows?: string[] } }));
  const reports = parsed.filter((p) => /^run-report-.+\.json$/.test(p.file));

  it("verified.ts carries no dry-run output, and no dry-run report or fixture is committed", () => {
    expect(readFileSync(REAL_VERIFIED, "utf8")).not.toContain(DRY_RUN_TAG);
    for (const p of parsed) expect(p.json.mode, p.file).not.toBe("dry-run");
  });

  it("every step verified.ts lists, and every row past docs, has a sandbox run report behind it", async () => {
    const { VERIFIED, VERIFIED_RUNBOOK_STEPS } = await import("@/lib/promote/catalog/verified");
    const sandboxReports = reports.filter((r) => r.json.mode === "sandbox");
    const passed = new Set(sandboxReports.flatMap((r) => r.json.passedSteps ?? []));
    for (const s of VERIFIED_RUNBOOK_STEPS) expect(passed.has(s), `${s} is listed in verified.ts with no sandbox run report (${REPO_FIXTURES_DIR}/run-report-<run id>.json)`).toBe(true);
    const moved = new Set(sandboxReports.flatMap((r) => r.json.movedRows ?? []));
    for (const [key, state] of Object.entries(VERIFIED)) if (state === "sandbox") expect(moved.has(key), `${key} is at sandbox with no sandbox run report that moved it`).toBe(true);
  });
});

describe("passedRows", () => {
  const step = (s: StepResult["step"], status: StepResult["status"], checks: StepResult["checks"] = []): StepResult => ({ step: s, title: s, status, checks, calls: [], leftBehind: [], kept: [] });

  it("needs every step of the row; a check that names the row decides for that step", () => {
    const results = [
      step("V-P1", "failed", [
        { id: "goal:awareness", passed: true, rows: ["goal.awareness"], evidence: {} },
        { id: "goal:page_likes", passed: false, rows: ["goal.page_likes"], evidence: {} },
      ]),
      step("V-P5", "passed", [{ id: "preview:X", passed: true, rows: ["feature.previews"], evidence: {} }]),
      step("V-P6", "failed", [{ id: "carousel", passed: false, rows: ["shape.carousel"], evidence: {} }]),
      step("V-P17", "manual"),
    ];
    const rows = passedRows(results, ["goal.awareness", "goal.page_likes", "feature.previews", "goal.video_views", "goal.profile_visits", "shape.carousel"]);
    expect([...rows].sort()).toEqual(["feature.previews", "goal.awareness"]);
  });
});

describe("helpers", () => {
  it("sanitize drops credentials and summarises uploads", () => {
    expect(sanitize({ access_token: "x", page_token: "y", nested: { appsecret_proof: "z", ok: 1 }, bytes: "QUJD" })).toEqual({ nested: { ok: 1 }, bytes: "<4 base64 characters>" });
  });

  it("assertVerifyBody", () => {
    expect(() => assertVerifyBody("adsets", { name: `${VERIFY_PREFIX}a`, status: "PAUSED" })).not.toThrow();
    expect(() => assertVerifyBody("ads", { name: `${VERIFY_PREFIX}a`, status: "PAUSED", configured_status: "ACTIVE" })).toThrow(VerifyRefusal);
    expect(() => assertVerifyBody("adcreatives", { name: `${VERIFY_PREFIX}a` })).not.toThrow();
  });

  it("parseArgs", () => {
    const a = parseArgs(["--tenant", "t1", "--account", "a1", "--page", "p1", "--steps", "V-P0,V-P7+", "--whatsapp-number", "+919800000001", "--write"]);
    expect(a).toMatchObject({ tenantId: "t1", accountAssetId: "a1", pageAssetId: "p1", steps: ["V-P0", "V-P7+"], whatsappNumber: "919800000001", unlinkedWhatsappNumber: null, write: true, dryRun: false, verifiedPath: REPO_VERIFIED_PATH });
    // A sandbox run's report is its own file per run.
    expect(a.reportPath).toBe(REPO_REPORT_PATH);
    expect(REPO_REPORT_PATH).toContain("{runId}");
    expect(parseArgs(["--tenant", "t1", "--account", "a", "--page", "p", "--dry-run", "--write"]).reportPath).toBeNull();
    expect(() => parseArgs(["--tenant", "t1"])).toThrow(/Give --tenant/);
    expect(() => parseArgs(["--tenant", "t1", "--account", "a", "--page", "p", "--steps", "V-P99"])).toThrow(/Unknown step/);
    expect(() => parseArgs(["--tenant", "t1", "--account", "a", "--page", "p", "--video-url", "http://x"])).toThrow(/https/);
  });

  it("parseArgs: the last value of a repeated flag wins; the unlinked number is its own flag and must differ", () => {
    const a = parseArgs(["--tenant", "t1", "--account", "a", "--page", "p", "--whatsapp-number", "919800000001", "--steps", "V-P12+", "--unlinked-whatsapp-number", "+919800000002", "--whatsapp-number", "919800000003"]);
    expect(a).toMatchObject({ whatsappNumber: "919800000003", unlinkedWhatsappNumber: "919800000002", steps: ["V-P12+"] });
    expect(() => parseArgs(["--tenant", "t1", "--account", "a", "--page", "p", "--unlinked-whatsapp-number", "12ab"])).toThrow(/--unlinked-whatsapp-number is digits/);
    expect(() => parseArgs(["--tenant", "t1", "--account", "a", "--page", "p", "--whatsapp-number", "919800000001", "--unlinked-whatsapp-number", "+919800000001"])).toThrow(/different number/);
  });
});

// =====================================================================================================================
// The end-to-end harness: Playwright starts the app with the fake's settings, and the guard reads only those (9.4)
// =====================================================================================================================

describe("e2e/global-setup: the settings Playwright starts the app with", () => {
  it("follows GRAPH_BASE_URL, refuses a non-loopback one, else FAKE_META_PORT or 4010", async () => {
    const { fakeMetaPort } = await import("../e2e/global-setup");
    expect(fakeMetaPort({ GRAPH_BASE_URL: "http://127.0.0.1:4555" })).toBe(4555);
    expect(fakeMetaPort({ GRAPH_BASE_URL: "http://localhost" })).toBe(80);
    expect(() => fakeMetaPort({ GRAPH_BASE_URL: "https://graph.facebook.com" })).toThrow(/127\.0\.0\.1/);
    expect(fakeMetaPort({ FAKE_META_PORT: "4777" })).toBe(4777);
    expect(fakeMetaPort({ FAKE_META_PORT: "nope" })).toBe(4010);
    expect(fakeMetaPort({})).toBe(4010);
  });

  it("never NODE_ENV=production, and the app's own readers accept every value: Graph goes to the fake, writes are dry runs", async () => {
    const { appServerEnv, appServerCommand, appServerMode } = await import("../e2e/global-setup");
    for (const mode of ["", "start", "dev"]) {
      const env = appServerEnv({ E2E_APP_MODE: mode, FAKE_META_PORT: "4777" }, "http://localhost:3500");
      expect(env.NODE_ENV).toBe(mode === "dev" ? "development" : "test");
      expect(env).toMatchObject({ SITE_URL: "http://localhost:3500", GRAPH_BASE_URL: "http://127.0.0.1:4777", SPEND_DRY_RUN: "1", PROMOTE_ENABLED: "on", PROMOTE_AUDIENCES: "all", EDDY_FAKE_MODEL: "scripted" });
      // What src/lib/graph and src/lib/spend/flags read in the app's process.
      expect(graphBaseOverride(env)).toBe("http://127.0.0.1:4777");
      expect(spendDryRun(env)).toBe(true);
    }
    // The bug this guards against: `next start` alone runs with NODE_ENV=production, where both are ignored.
    const prod = { ...appServerEnv({}, "http://localhost:3500"), NODE_ENV: "production" };
    expect(graphBaseOverride(prod)).toBeNull();
    expect(spendDryRun(prod)).toBe(false);
    expect(appServerCommand({}, 3500)).toBe("npx next start -p 3500");
    expect(appServerCommand({ E2E_APP_MODE: "dev" }, 3500)).toBe("npx next dev -p 3500");
    expect(() => appServerMode({ E2E_APP_MODE: "prod" })).toThrow(/E2E_APP_MODE must be start/);
  });

  it("the fake listens on the port the app was given, whatever the runner's shell says", async () => {
    const { APP_ENV_KEY, recordedAppEnv, setupPort } = await import("../e2e/global-setup");
    const app = JSON.stringify({ GRAPH_BASE_URL: "http://127.0.0.1:4888", SPEND_DRY_RUN: "1" });
    expect(setupPort({ [APP_ENV_KEY]: app, GRAPH_BASE_URL: "http://127.0.0.1:4010" })).toBe(4888);
    expect(setupPort({ GRAPH_BASE_URL: "http://127.0.0.1:4010" })).toBe(4010);
    expect(recordedAppEnv({ [APP_ENV_KEY]: app })).toEqual({ GRAPH_BASE_URL: "http://127.0.0.1:4888", SPEND_DRY_RUN: "1" });
    expect(recordedAppEnv({ [APP_ENV_KEY]: "not json" })).toBeNull();
    expect(recordedAppEnv({})).toBeNull();
  });
});

describe("playwright.config.ts owns the app's environment", () => {
  const load = async (env: Record<string, string | undefined>) => {
    vi.resetModules();
    for (const k of ["E2E_BASE_URL", "E2E_APP_ENV", "E2E_APP_MODE", "GRAPH_BASE_URL", "FAKE_META_PORT", "TEST_WORKER_INDEX"]) vi.stubEnv(k, env[k]);
    return (await import("../playwright.config")).default as unknown as {
      globalSetup: string;
      webServer?: { command: string; url: string; reuseExistingServer: boolean; env: Record<string, string> };
      use: { baseURL: string };
    };
  };
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  });

  it("starts the app itself (never reusing a server already there) and records what it passed", async () => {
    const config = await load({ E2E_BASE_URL: undefined, E2E_APP_ENV: "left over from a shell" });
    expect(config.globalSetup).toBe("./e2e/global-setup.ts");
    expect(config.use.baseURL).toBe("http://localhost:3500");
    expect(config.webServer).toMatchObject({ command: "npx next start -p 3500", url: "http://localhost:3500", reuseExistingServer: false });
    expect(config.webServer!.env).toMatchObject({ NODE_ENV: "test", GRAPH_BASE_URL: "http://127.0.0.1:4010", SPEND_DRY_RUN: "1", PROMOTE_ENABLED: "on" });
    expect(JSON.parse(process.env.E2E_APP_ENV ?? "null")).toEqual(config.webServer!.env);
  });

  it("with E2E_BASE_URL it starts nothing and records nothing, so the promote specs refuse", async () => {
    const config = await load({ E2E_BASE_URL: "http://localhost:3510", E2E_APP_ENV: JSON.stringify({ GRAPH_BASE_URL: "http://127.0.0.1:4010" }) });
    expect(config.webServer).toBeUndefined();
    expect(config.use.baseURL).toBe("http://localhost:3510");
    expect(process.env.E2E_APP_ENV).toBeUndefined();
  });

  it("a worker keeps the runner's record and starts nothing", async () => {
    const recorded = JSON.stringify({ NODE_ENV: "test", GRAPH_BASE_URL: "http://127.0.0.1:4010", SPEND_DRY_RUN: "1", PROMOTE_ENABLED: "on" });
    const config = await load({ TEST_WORKER_INDEX: "0", E2E_APP_ENV: recorded });
    expect(config.webServer).toBeUndefined();
    expect(process.env.E2E_APP_ENV).toBe(recorded);
  });
});

describe("e2e/promote-helpers guard: reads the app's settings, never the runner's", () => {
  const KEYS = ["E2E_APP_ENV", "FAKE_META_URL", "GRAPH_BASE_URL", "SPEND_DRY_RUN", "PROMOTE_ENABLED"] as const;
  const APP = { NODE_ENV: "test", GRAPH_BASE_URL: "http://127.0.0.1:4010", SPEND_DRY_RUN: "1", PROMOTE_ENABLED: "on", PROMOTE_AUDIENCES: "all" };
  const load = async (app: Record<string, string> | null, env: Partial<Record<(typeof KEYS)[number], string>> = {}) => {
    vi.resetModules();
    for (const k of KEYS) vi.stubEnv(k, env[k] ?? "");
    vi.stubEnv("E2E_APP_ENV", app ? JSON.stringify(app) : "");
    vi.stubEnv("FAKE_META_URL", env.FAKE_META_URL ?? "http://127.0.0.1:4010");
    return import("../e2e/promote-helpers");
  };
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  });

  it("throws on load when Playwright did not start the app, even with the right values in the runner's own shell", async () => {
    await expect(load(null, { GRAPH_BASE_URL: "http://127.0.0.1:4010", SPEND_DRY_RUN: "1", PROMOTE_ENABLED: "on" })).rejects.toThrow(/Playwright starts itself.+E2E_APP_ENV is missing/);
  });

  it("throws when the app runs with NODE_ENV=production (it would ignore GRAPH_BASE_URL and SPEND_DRY_RUN)", async () => {
    await expect(load({ ...APP, NODE_ENV: "production" })).rejects.toThrow(/NODE_ENV=production/);
  });

  it("throws when the app's GRAPH_BASE_URL is unset or not a loopback address", async () => {
    await expect(load({ ...APP, GRAPH_BASE_URL: "" })).rejects.toThrow(/started without GRAPH_BASE_URL/);
    await expect(load({ ...APP, GRAPH_BASE_URL: "https://graph.facebook.com" })).rejects.toThrow(/127\.0\.0\.1, localhost or \[::1\]/);
    await expect(load({ ...APP, GRAPH_BASE_URL: "http://10.0.0.5:4010" })).rejects.toThrow(/loopback|127\.0\.0\.1/);
  });

  it("throws when the fake listens elsewhere, or the app runs without SPEND_DRY_RUN=1 and PROMOTE_ENABLED=on", async () => {
    await expect(load(APP, { FAKE_META_URL: "http://127.0.0.1:4999" })).rejects.toThrow(/port 4010.+port 4999/);
    // The runner's own SPEND_DRY_RUN does not count: only the app's.
    await expect(load({ ...APP, SPEND_DRY_RUN: "" }, { SPEND_DRY_RUN: "1" })).rejects.toThrow(/SPEND_DRY_RUN must be 1/);
    await expect(load({ ...APP, PROMOTE_ENABLED: "admins" }, { PROMOTE_ENABLED: "on" })).rejects.toThrow(/PROMOTE_ENABLED must be on/);
  });

  it("loads with the app on the fake, exposes the app's settings, and assertPromoteEnv refuses an empty environment", async () => {
    const m = await load(APP, { PROMOTE_ENABLED: "off" });
    expect(m.PROMOTE_ENV).toEqual({ graphBaseUrl: "http://127.0.0.1:4010", fakeUrl: "http://127.0.0.1:4010", app: APP });
    expect(m.appSetting("PROMOTE_AUDIENCES")).toBe("all");
    expect(m.appSetting("EDDY_PHASE")).toBe("");
    expect(() => m.assertPromoteEnv({})).toThrow(/E2E_APP_ENV is missing/);
    expect(m.assertPromoteEnv({ E2E_APP_ENV: JSON.stringify({ ...APP, GRAPH_BASE_URL: "http://localhost:4010/", SPEND_DRY_RUN: "true", PROMOTE_ENABLED: "ON" }) }).graphBaseUrl).toBe("http://localhost:4010");
    expect(m.t("card.boost.start", { amount: "₹2,625" })).toBe("Start boost · up to ₹2,625");
    expect(m.solidPng(4, 5).subarray(1, 4).toString("ascii")).toBe("PNG");
  });

  it("counts only the app's calls: the fake's tokens, and never a call a spec sends itself", async () => {
    const m = await load(APP);
    expect(m.isAppCall({ method: "GET", pattern: "{id}/media", tokenKind: "page" })).toBe(true);
    expect(m.isAppCall({ method: "GET", pattern: "act_{id}/generatepreviews", tokenKind: "user" })).toBe(true);
    expect(m.isAppCall({ method: "POST", pattern: "{id}/test_leads", tokenKind: "page" }), "the leads spec's own test lead").toBe(false);
    expect(m.isAppCall({ method: "GET", pattern: "{id}", tokenKind: "none" })).toBe(false);
    expect(m.isAppCall({ method: "GET", pattern: "{id}", tokenKind: "unknown" })).toBe(false);
    expect(m.SOURCE_READS.test("{id}/media")).toBe(true);
    expect(m.SOURCE_READS.test("{id}/published_posts")).toBe(true);
    expect(m.SOURCE_READS.test("{id}/test_leads")).toBe(false);
  });
});

// =====================================================================================================================
// The 9.4 specs, the runbook, the App Review documents and the rollout notes (PRM-16 acceptance)
// =====================================================================================================================

const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replaceAll("\r\n", "\n");

describe("the 9.4 end-to-end specs", () => {
  const SPECS = ["promote-boost", "promote-leads", "promote-ctwa", "promote-limits", "promote-audiences", "promote-versions", "promote-connect-popup", "eddy-promote"];

  it("each runs on desktop and @mobile, through the guarded helpers, with axe, the three widths and a dark screenshot", () => {
    for (const name of SPECS) {
      const spec = read(`e2e/${name}.spec.ts`);
      expect(spec, name).toMatch(/test\.describe\("[^"]*@mobile"/);
      expect(spec, name).toMatch(/from "\.\/promote-helpers"/);
      expect(spec, name).toContain("checkPromoteQuality(");
    }
    const helpers = read("e2e/promote-helpers.ts");
    const quality = helpers.slice(helpers.indexOf("export async function checkPromoteQuality"));
    expect(quality).toContain("axeSerious(page");
    expect(quality).toContain("[360, 390, 1280]");
    expect(quality).toContain("darkScreenshot(page");
    expect(helpers).toMatch(/export const PROMOTE_ENV: PromoteE2EEnv = assertPromoteEnv\(process\.env\);/);
  });

  it("each proves, per test, that the app reads Graph from the fake (a marker taken at the start of the test)", () => {
    for (const name of SPECS) {
      const spec = read(`e2e/${name}.spec.ts`);
      expect(spec, name).not.toContain("fakeCallCount");
      if (name === "promote-connect-popup") {
        // Its cancelled popup makes no Graph call: a throwaway workspace proves the same app reads from the fake.
        expect(spec, name).toMatch(/test\.beforeAll\(async \(\{ browser \}\) => \{\s*await proveAppUsesFake\(browser\);/);
        continue;
      }
      const tests = spec.split(/\n\s*test\(/).slice(1);
      expect(tests.length, name).toBeGreaterThan(0);
      for (const [i, body] of tests.entries()) {
        expect(body, `${name} test ${i + 1}`).toContain("const mark = await fakeMark();");
        expect(body, `${name} test ${i + 1}`).toMatch(/expectAppReadsFake\((page|admin\.page)\.request, mark\)/);
      }
    }
    const leads = read("e2e/promote-leads.spec.ts");
    expect(leads).toContain("fakeMetaTestLead(FAKE_FORM_ID");
    expect(leads).toContain("await expectAppUsedFake(leadMark);");
    expect(leads).not.toMatch(/fetch\(`\$\{PROMOTE_ENV\.fakeUrl\}/);
  });

  it("use context.route only for facebook.com, never page.route or a route to the Graph host", () => {
    for (const name of SPECS) {
      const spec = read(`e2e/${name}.spec.ts`);
      expect(spec, name).not.toMatch(/page\.route\(/);
      expect(spec, name).not.toContain("graph.facebook.com");
      for (const m of spec.matchAll(/context\.route\(([^,]+),/g)) expect(m[1], name).toMatch(/facebook\\\.com/);
    }
  });

  it("the audiences spec reads PROMOTE_AUDIENCES from the app's settings, not the runner's shell", () => {
    const spec = read("e2e/promote-audiences.spec.ts");
    expect(spec).toContain('appSetting("PROMOTE_AUDIENCES")');
    expect(spec).not.toContain("process.env.PROMOTE_AUDIENCES");
  });
});

describe("docs/promote-verification-runbook.md", () => {
  const runbook = read("docs/promote-verification-runbook.md");
  const label = (s: string) => (s.endsWith("+") ? `${s.slice(0, -1)} addendum` : s);

  it("lists every V-P step and addendum with its command, pass criteria and where it is recorded", () => {
    for (const step of STEP_IDS) {
      const row = runbook.split("\n").find((l) => l.startsWith(`| **${label(step)}**`));
      expect(row, step).toBeDefined();
      const cells = row!.split("|").slice(1, -1).map((c) => c.trim());
      expect(cells.length, step).toBe(6);
      for (const [i, cell] of cells.entries()) expect(cell.length, `${step} column ${i + 1}`).toBeGreaterThan(3);
    }
    expect(runbook).toMatch(/\| \*\*V-P17\*\* \| \*\*Owner-present live check\*\*/);
    expect(runbook).toContain("never the script");
    expect(runbook).toContain("sandbox:runbook-lock");
    expect(runbook).toContain("PRM-VERIFY ");
  });

  it("names where results go: the per-run report and fixtures, verified.ts, the table and MIGRATIONS-APPLIED", () => {
    for (const where of ["tests/fixtures/promote-verified/run-report-<run id>.json", "tests/fixtures/promote-verified/<step>.<run id>.json", "src/lib/promote/catalog/verified.ts", "## 4. Results", "MIGRATIONS-APPLIED"]) expect(runbook, where).toContain(where);
    expect(runbook).not.toContain("promote-verified/run-report.json");
    expect(runbook).not.toContain("promote-verified/<step>.json");
  });

  it("says each run holds the lock under its own name, a dry run writes nothing to the Spend Book, and V-P12 needs the linked number", () => {
    expect(runbook).toContain("promote:<run id>:<nonce>@<host>");
    expect(runbook).not.toMatch(/holder `promote`,/);
    expect(runbook).toMatch(/dry run writes nothing to the Spend Book/i);
    const vp12 = runbook.split("\n").find((l) => l.startsWith("| **V-P12**"))!;
    expect(vp12).not.toContain("linked or not");
    expect(vp12).toContain("--whatsapp-number");
    expect(runbook.split("\n").find((l) => l.startsWith("| **V-P12 addendum**"))).toContain("--unlinked-whatsapp-number");
  });
});

describe("the App Review documents", () => {
  const ALL_KNOWN = [
    "business_management", "ads_management", "ads_read", "pages_show_list", "pages_read_engagement", "pages_manage_ads", "pages_manage_metadata", "leads_retrieval",
    "pages_manage_posts", "instagram_basic", "instagram_content_publish", "instagram_manage_messages", "instagram_business_manage_messages", "pages_messaging",
    "instagram_manage_comments", "instagram_manage_insights", "read_insights", "pages_manage_engagement", "catalog_management", "instagram_branded_content_ads_brand",
    "whatsapp_business_messaging", "whatsapp_business_management",
  ];
  const named = (text: string) => ALL_KNOWN.filter((p) => new RegExp(`(?<![a-z_])${p}(?![a-z_])`).test(text));

  it("the ads permission documents name only permissions in META_CONNECT_SCOPES", async () => {
    const { META_CONNECT_SCOPES } = await import("@/lib/meta-connect/scopes");
    for (const doc of ["ads_management", "ads_read", "pages_read_engagement", "pages_manage_ads", "leads_retrieval"]) {
      const text = read(`docs/app-review/${doc}.md`);
      expect(named(text).filter((p) => !(META_CONNECT_SCOPES as readonly string[]).includes(p)), doc).toEqual([]);
      expect(text, doc).toContain("Feature built: **Built**");
      expect(text, doc).toMatch(/## Screencast script/);
    }
  });

  it("the overview names any other permission only as not requested or next workstream", async () => {
    const { META_CONNECT_SCOPES } = await import("@/lib/meta-connect/scopes");
    const embeddedSignup = ["whatsapp_business_messaging", "whatsapp_business_management"];
    for (const line of read("docs/app-review/00-overview.md").split("\n")) {
      const others = named(line).filter((p) => !(META_CONNECT_SCOPES as readonly string[]).includes(p) && !embeddedSignup.includes(p));
      if (others.length) expect(line, others.join(", ")).toMatch(/not requested|next workstream/i);
    }
  });

  it("instagram_manage_messages and pages_messaging are clearly the next workstream, with their review material ready", () => {
    for (const doc of ["instagram_manage_messages", "pages_messaging"]) {
      const text = read(`docs/app-review/${doc}.md`);
      expect(text.split("\n")[0]).toBe(`# ${doc}`);
      expect(text).toContain("Phase: NEXT WORKSTREAM (not requested");
      expect(text).toContain("NEXT WORKSTREAM, NOT REQUESTED");
      for (const part of ["## Use-case and configuration", "## Use-case description", "## Screencast script", "## Switching it from next workstream to requested"]) expect(text, `${doc}: ${part}`).toContain(part);
    }
  });

  it("covers the 8.2 screencasts: popup connect, boost a reel, Click-to-WhatsApp, a form and a test lead, the hub, placements, the timeline", () => {
    const docs = ["00-overview", "ads_management", "ads_read", "pages_read_engagement", "pages_manage_ads", "leads_retrieval"].map((d) => read(`docs/app-review/${d}.md`)).join("\n");
    for (const part of ["Connect with Facebook", "boost an Instagram reel", "a Click-to-WhatsApp ad", "a customer-list audience with the consent screen", "Send a test lead", "Leads hub", "results by placement", "the review status timeline"]) {
      expect(docs.toLowerCase(), part).toContain(part.toLowerCase());
    }
  });

  it("the dashboard checklist carries the ads workstream's platform tasks", () => {
    const text = read("docs/meta-dashboard-requirements.md");
    expect(text).toContain("### 1I. Instagram and Facebook Page ads");
    for (let n = 80; n <= 93; n++) expect(text, `item ${n}`).toMatch(new RegExp(`^\\| ${n} \\|`, "m"));
    expect(text).toContain("Edwyz Connect Pages IG Ads");
  });
});

describe("deploy/README-deploy.md rollout notes (9.7)", () => {
  const readme = read("deploy/README-deploy.md");
  const d3 = readme.slice(readme.indexOf("### D.3"), readme.indexOf("## B. Move to an independent server later"));

  it("records each train's gate flip by flip in MIGRATIONS-APPLIED", () => {
    expect(d3.length).toBeGreaterThan(1000);
    const order = ["**P1 dark**", "**P2 drafts and reads, `PROMOTE_ENABLED=admins`.**", "**P3 Start, `PROMOTE_ENABLED=on`.**", "**P4 audiences, versions and video**", "**P5 Eddy v2**"];
    const at = order.map((o) => d3.indexOf(o));
    for (const [i, o] of order.entries()) expect(at[i], o).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(d3).toContain(">> /var/www/edwyz-wa/MIGRATIONS-APPLIED");
  });

  it("names every 9.7 gate, and the P3 gate names the run's own report file", () => {
    const p3 = d3.slice(d3.indexOf("**P3 Start"), d3.indexOf("**P4 audiences"));
    for (const g of ["V-P0 to V-P7", "`SPEND_ENFORCE=enforce`", "`SPEND_TRIPWIRE=enforce`", "P0-1", "P0-11", "D31", "7 days of P2", "spend.tripwire.bypass"]) expect(p3, g).toContain(g);
    expect(p3).toContain("tests/fixtures/promote-verified/run-report-<run id>.json");
    expect(p3).not.toContain("promote-verified/run-report.json");
    const p4 = d3.slice(d3.indexOf("**P4 audiences"), d3.indexOf("**P5 Eddy v2**"));
    for (const g of ["V-P8", "LEGAL_DPDP_AUDIENCES_OK", "below 80%", "PROMOTE_VIDEO"]) expect(p4, g).toContain(g);
    expect(p4.indexOf("LEGAL_DPDP_AUDIENCES_OK=0->1")).toBeLessThan(p4.indexOf("PROMOTE_AUDIENCES=engagement->all"));
    const p5 = d3.slice(d3.indexOf("**P5 Eddy v2**"));
    for (const g of ["Eddy train E5", "evals"]) expect(p5, g).toContain(g);
  });

  it("the end-to-end evidence comes from the app Playwright starts itself, never `npm run start` with NODE_ENV=production", () => {
    expect(d3).toContain("webServer");
    expect(d3).toContain("NODE_ENV=test");
    expect(d3).toContain("Never start the app for this run with plain `npm run start`");
    // The old instruction: the app started by hand with the settings in front of it, which the runner could not check.
    expect(d3).not.toContain("started with `GRAPH_BASE_URL=");
    for (const file of ["e2e/promote-helpers.ts", "e2e/global-setup.ts", "playwright.config.ts"]) expect(read(file), file).not.toMatch(/SPEND_DRY_RUN=1[^\n]*npm run start/);
  });
});
