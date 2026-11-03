import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Instagram and Facebook Page ads: the flags, promoteAccess, the route guard and the /api/promote route class
 * (docs/IG-PAGE-ADS-SPEC.md 1.4, 4.8, 9.7, D22; PRM-00 acceptance 6, 8 and 9). No database and no network: getActor and the
 * three lookups the guard makes (the user, the spend control row, the ad account) are faked, and so is the campaign load of
 * ads/service.activateCampaign, where the Start gate also stands.
 */
const h = vi.hoisted(() => ({
  getActor: vi.fn(),
  user: vi.fn(),
  control: vi.fn(),
  asset: vi.fn(),
  campaign: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getActor: h.getActor }));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: h.user },
    spendControl: { findUnique: h.control },
    metaAsset: { findFirst: h.asset },
    adCampaign: { findFirst: h.campaign },
  },
}));

import { GET as accessRoute } from "@/app/api/promote/access/route";
import { notExposedEntry } from "@/lib/actions/not-exposed";
import { PROMOTE_GOAL_KEYS as RULES_GOAL_KEYS, PROMOTE_PAGE_LANG_VALUES } from "@/lib/env-rules.mjs";
import {
  effectiveAudiences,
  legalDpdpAudiencesOk,
  metaLoginPopup,
  PROMOTE_GOAL_KEYS,
  PROMOTE_HIDDEN,
  PROMOTE_PAGE_LANGS,
  promoteAccess,
  promoteAudiences,
  promoteEnabled,
  promoteExperimental,
  promoteFlags,
  promoteGoals,
  promotePageLangs,
  promotePreviews,
  promoteVideo,
} from "@/lib/promote/flags";
import {
  accessFor,
  assertPromoteStartOpen,
  isDryRun,
  PROMOTE_NOT_FOUND,
  PROMOTE_OWNER_ONLY,
  PROMOTE_ROLE_TOO_LOW,
  PROMOTE_START_CLOSED,
  PROMOTE_START_SURFACES,
  PROMOTE_WRITERS_ONLY,
  promoteRead,
  promoteRoute,
  promoteWrite,
} from "@/lib/promote/route-guard";

type Role = "owner" | "admin" | "agent";
const ENFORCING = { SPEND_ENFORCE: "enforce", SPEND_TRIPWIRE: "enforce" };
const ORIGIN = "https://wa.edwyz.com";
const actor = (role: Role = "owner") => ({ userId: "u1", tenantId: "t1", role });
const access = (role: Role, env: Record<string, string>, extra: { isPlatformAdmin?: boolean; sandboxAccount?: boolean } = {}) =>
  promoteAccess({ role, isPlatformAdmin: extra.isPlatformAdmin ?? false, sandboxAccount: extra.sandboxAccount ?? false }, env);

const post = (origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}/api/promote/drafts`, { method: "POST", headers: origin ? { origin, "content-type": "application/json" } : {}, body: "{}" });
const get = () => new Request(`${ORIGIN}/api/promote/access`);

/** Rejects with an HttpError: its status and message. */
async function refusal(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    return { status: (error as { status: number }).status, message: (error as Error).message };
  }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.getActor.mockResolvedValue(actor("owner"));
  h.user.mockResolvedValue({ email: "someone@shop.test", emailVerifiedAt: new Date(), disabledAt: null, totpEnabledAt: null });
  h.control.mockResolvedValue({ spendingAdAccountAssetId: "as1" });
  h.asset.mockResolvedValue({ sandbox: false });
  process.env.SITE_URL = ORIGIN;
  process.env.PLATFORM_ADMIN_EMAILS = "staff@edwyz.com";
  for (const k of ["PROMOTE_ENABLED", "SPEND_ENFORCE", "SPEND_TRIPWIRE", "PROMOTE_EXPERIMENTAL", "SPEND_DRY_RUN"]) delete process.env[k];
});

describe("flag readers (train P1 defaults)", () => {
  it("defaults to dark: off, every goal, Meta previews, no video, no audiences, English, popup login", () => {
    expect(promoteFlags({})).toEqual({
      enabled: "off",
      goals: [...PROMOTE_GOAL_KEYS],
      previews: "meta",
      video: "off",
      audiences: "off",
      effectiveAudiences: "off",
      legalDpdpAudiencesOk: false,
      experimental: false,
      pageLangs: ["en"],
      metaLoginPopup: true,
    });
  });

  it("reads each value trimmed and in any case, and falls back to the safe default on an unknown one", () => {
    expect(promoteEnabled({ PROMOTE_ENABLED: " Admins " })).toBe("admins");
    expect(promoteEnabled({ PROMOTE_ENABLED: "ON" })).toBe("on");
    expect(promoteEnabled({ PROMOTE_ENABLED: "yes" })).toBe("off");
    expect(promotePreviews({ PROMOTE_PREVIEWS: "local" })).toBe("local");
    expect(promotePreviews({ PROMOTE_PREVIEWS: "iframe" })).toBe("meta");
    expect(promoteVideo({ PROMOTE_VIDEO: "file_url" })).toBe("file_url");
    expect(promoteVideo({ PROMOTE_VIDEO: "resumable" })).toBe("resumable");
    expect(promoteVideo({ PROMOTE_VIDEO: "on" })).toBe("off");
    expect(promoteAudiences({ PROMOTE_AUDIENCES: "engagement" })).toBe("engagement");
    expect(promoteAudiences({ PROMOTE_AUDIENCES: "everyone" })).toBe("off");
    expect(legalDpdpAudiencesOk({ LEGAL_DPDP_AUDIENCES_OK: "1" })).toBe(true);
    expect(legalDpdpAudiencesOk({ LEGAL_DPDP_AUDIENCES_OK: "maybe" })).toBe(false);
    expect(promoteExperimental({ PROMOTE_EXPERIMENTAL: "true" })).toBe(true);
    expect(metaLoginPopup({ META_LOGIN_POPUP: "off" })).toBe(false);
    expect(metaLoginPopup({ META_LOGIN_POPUP: "0" })).toBe(false);
    expect(metaLoginPopup({ META_LOGIN_POPUP: "sometimes" })).toBe(true);
  });

  it("PROMOTE_GOALS keeps catalog order, drops unknown keys, and unset means every goal", () => {
    expect(promoteGoals({ PROMOTE_GOALS: " lead_form, whatsapp_chats ,boost_everything," })).toEqual(["whatsapp_chats", "lead_form"]);
    expect(promoteGoals({ PROMOTE_GOALS: "" })).toEqual([...PROMOTE_GOAL_KEYS]);
    expect(promoteGoals({ PROMOTE_GOALS: "nothing_known" })).toEqual([]);
  });

  it("PROMOTE_PAGE_LANGS always keeps English and adds only hi and hinglish", () => {
    expect(promotePageLangs({})).toEqual(["en"]);
    expect(promotePageLangs({ PROMOTE_PAGE_LANGS: "hinglish" })).toEqual(["en", "hinglish"]);
    expect(promotePageLangs({ PROMOTE_PAGE_LANGS: "hi,en,fr" })).toEqual(["en", "hi"]);
  });

  it("customer lists only with PROMOTE_AUDIENCES=all, and in production only with the legal flag", () => {
    expect(effectiveAudiences({ PROMOTE_AUDIENCES: "all" })).toBe("all");
    expect(effectiveAudiences({ PROMOTE_AUDIENCES: "all", NODE_ENV: "production" })).toBe("engagement");
    expect(effectiveAudiences({ PROMOTE_AUDIENCES: "all", NODE_ENV: "production", LEGAL_DPDP_AUDIENCES_OK: "1" })).toBe("all");
    expect(effectiveAudiences({ PROMOTE_AUDIENCES: "engagement", NODE_ENV: "production" })).toBe("engagement");
  });

  it("keeps the goal keys and page languages equal to the startup check's lists", () => {
    expect([...RULES_GOAL_KEYS]).toEqual([...PROMOTE_GOAL_KEYS]);
    expect([...PROMOTE_PAGE_LANG_VALUES]).toEqual([...PROMOTE_PAGE_LANGS]);
    expect(PROMOTE_GOAL_KEYS).toHaveLength(12);
  });
});

describe("promoteAccess matrix (1.4, 9.7)", () => {
  it("off: nothing is visible, for anyone, platform admins included", () => {
    for (const role of ["owner", "admin", "agent"] as const) {
      expect(access(role, {}, { isPlatformAdmin: true, sandboxAccount: true })).toEqual(PROMOTE_HIDDEN);
      expect(access(role, { PROMOTE_ENABLED: "off", ...ENFORCING })).toEqual(PROMOTE_HIDDEN);
    }
  });

  it("admins: a platform admin sees it, a workspace owner does not; Start stays hidden even with both enforce modes", () => {
    const env = { PROMOTE_ENABLED: "admins", ...ENFORCING };
    expect(access("owner", env, { isPlatformAdmin: true })).toMatchObject({ visible: true, canWrite: true, canStart: false });
    expect(access("owner", env, { isPlatformAdmin: false })).toEqual(PROMOTE_HIDDEN);
    expect(access("agent", env, { isPlatformAdmin: true })).toMatchObject({ visible: true, canWrite: false, canStart: false });
  });

  it("on: owners and admins write, an agent is read-only", () => {
    const env = { PROMOTE_ENABLED: "on", ...ENFORCING };
    expect(access("owner", env)).toMatchObject({ visible: true, canWrite: true, canStart: true });
    expect(access("admin", env)).toMatchObject({ visible: true, canWrite: true, canStart: true });
    expect(access("agent", env)).toMatchObject({ visible: true, canWrite: false, canStart: false });
  });

  it("canStart is false unless both SPEND_ENFORCE and SPEND_TRIPWIRE enforce (train P3)", () => {
    expect(access("owner", { PROMOTE_ENABLED: "on" }).canStart).toBe(false);
    expect(access("owner", { PROMOTE_ENABLED: "on", SPEND_ENFORCE: "enforce" }).canStart).toBe(false);
    expect(access("owner", { PROMOTE_ENABLED: "on", SPEND_TRIPWIRE: "enforce" }).canStart).toBe(false);
    expect(access("owner", { PROMOTE_ENABLED: "on", SPEND_ENFORCE: "enforce", SPEND_TRIPWIRE: "report" }).canStart).toBe(false);
    expect(access("owner", { PROMOTE_ENABLED: "on", ...ENFORCING }).canStart).toBe(true);
  });

  it("experimental rows only for a sandbox ad account, and only with PROMOTE_EXPERIMENTAL", () => {
    const env = { PROMOTE_ENABLED: "on", PROMOTE_EXPERIMENTAL: "1" };
    expect(access("owner", env, { sandboxAccount: true }).experimental).toBe(true);
    expect(access("owner", env, { sandboxAccount: false }).experimental).toBe(false);
    expect(access("owner", { PROMOTE_ENABLED: "on" }, { sandboxAccount: true }).experimental).toBe(false);
  });

  it("passes the other flags through once visible, with customer lists held back in production", () => {
    const env = { PROMOTE_ENABLED: "on", PROMOTE_AUDIENCES: "all", PROMOTE_VIDEO: "file_url", PROMOTE_PREVIEWS: "local", PROMOTE_GOALS: "lead_form", PROMOTE_PAGE_LANGS: "hi", NODE_ENV: "production" };
    expect(access("admin", env)).toMatchObject({ audiences: "engagement", video: "file_url", previews: "local", goals: ["lead_form"], pageLangs: ["en", "hi"] });
    expect(access("admin", { ...env, LEGAL_DPDP_AUDIENCES_OK: "1" }).audiences).toBe("all");
  });

  it("never hands out the shared hidden object's arrays", () => {
    const a = access("owner", {});
    a.goals.push("lead_form");
    expect(PROMOTE_HIDDEN.goals).toEqual([]);
  });
});

describe("route guard (4.8)", () => {
  it("answers 404 while the feature is off, without asking who the caller is", async () => {
    expect(await refusal(promoteRead(get()))).toEqual({ status: 404, message: PROMOTE_NOT_FOUND });
    expect(await refusal(promoteWrite(post()))).toEqual({ status: 404, message: PROMOTE_NOT_FOUND });
    expect(h.getActor).not.toHaveBeenCalled();
    expect(h.user).not.toHaveBeenCalled();
  });

  it("admins mode: 404 for a workspace owner who is not an Edwyz platform admin; a verified platform admin gets in", async () => {
    process.env.PROMOTE_ENABLED = "admins";
    expect(await refusal(promoteRead(get()))).toMatchObject({ status: 404 });
    expect(await refusal(promoteWrite(post()))).toMatchObject({ status: 404 });
    h.user.mockResolvedValue({ email: "Staff@edwyz.com", emailVerifiedAt: new Date(), disabledAt: null, totpEnabledAt: null });
    const guard = await promoteRead(get());
    expect(guard.access).toMatchObject({ visible: true, canWrite: true, canStart: false });
    expect(h.user).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "u1" } }));
    // An allowlisted address that was never verified is not a platform admin.
    h.user.mockResolvedValue({ email: "staff@edwyz.com", emailVerifiedAt: null, disabledAt: null, totpEnabledAt: null });
    expect(await refusal(promoteRead(get()))).toMatchObject({ status: 404 });
  });

  it("on: an agent reads, but gets 403 on POST; an admin may write", async () => {
    process.env.PROMOTE_ENABLED = "on";
    h.getActor.mockResolvedValue(actor("agent"));
    expect((await promoteRead(get())).access).toMatchObject({ visible: true, canWrite: false });
    expect(await refusal(promoteWrite(post()))).toEqual({ status: 403, message: PROMOTE_WRITERS_ONLY });
    expect(await refusal(promoteRead(get(), { minRole: "admin" }))).toEqual({ status: 403, message: PROMOTE_ROLE_TOO_LOW });
    h.getActor.mockResolvedValue(actor("admin"));
    expect(await refusal(promoteRead(get(), { minRole: "owner" }))).toEqual({ status: 403, message: PROMOTE_OWNER_ONLY });
    expect((await promoteWrite(post())).actor).toEqual(actor("admin"));
    expect(h.user).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin POST, or one with no Origin, before it looks up the caller", async () => {
    process.env.PROMOTE_ENABLED = "on";
    expect(await refusal(promoteWrite(post("https://evil.example")))).toMatchObject({ status: 403 });
    expect(await refusal(promoteWrite(post(null)))).toMatchObject({ status: 403 });
    expect(h.getActor).not.toHaveBeenCalled();
  });

  it("Start needs canStart: 403 with plain copy until both spend controls enforce", async () => {
    process.env.PROMOTE_ENABLED = "on";
    expect(await refusal(promoteWrite(post(), { start: true }))).toEqual({ status: 403, message: PROMOTE_START_CLOSED });
    Object.assign(process.env, ENFORCING);
    expect((await promoteWrite(post(), { start: true })).access.canStart).toBe(true);
  });

  it("looks up the sandbox account only while PROMOTE_EXPERIMENTAL is on", async () => {
    const env = { PROMOTE_ENABLED: "on" };
    expect((await accessFor(actor(), env)).experimental).toBe(false);
    expect(h.control).not.toHaveBeenCalled();
    h.asset.mockResolvedValue({ sandbox: true });
    expect((await accessFor(actor(), { ...env, PROMOTE_EXPERIMENTAL: "1" })).experimental).toBe(true);
    expect(h.asset).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "as1", tenantId: "t1" } }));
    h.control.mockResolvedValue(null);
    expect((await accessFor(actor(), { ...env, PROMOTE_EXPERIMENTAL: "1" })).experimental).toBe(false);
  });

  it("isDryRun follows SPEND_DRY_RUN and is never on in production", () => {
    expect(isDryRun({ SPEND_DRY_RUN: "1" })).toBe(true);
    expect(isDryRun({})).toBe(false);
    expect(isDryRun({ SPEND_DRY_RUN: "1", NODE_ENV: "production" })).toBe(false);
  });

  it("promoteRoute turns every refusal into its JSON answer and passes the guard to the handler", async () => {
    const handler = vi.fn(async ({ access: a, dryRun }: { access: { canWrite: boolean }; dryRun: boolean }) => Response.json({ canWrite: a.canWrite, dryRun }));
    const POST = promoteRoute("write", handler);
    const off = await POST(post(), {});
    expect(off.status).toBe(404);
    expect(await off.json()).toEqual({ error: PROMOTE_NOT_FOUND });
    process.env.PROMOTE_ENABLED = "on";
    process.env.SPEND_DRY_RUN = "1";
    const ok = await POST(post(), {});
    expect(await ok.json()).toEqual({ canWrite: true, dryRun: true });
    const cross = await POST(post("https://evil.example"), {});
    expect(cross.status).toBe(403);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("the Start gate at the spend chokepoint (assertPromoteStartOpen in ads/service.activateCampaign)", () => {
  const thrown = (fn: () => void): { status: number; message: string } | null => {
    try {
      fn();
      return null;
    } catch (error) {
      return { status: (error as { status: number }).status, message: (error as Error).message };
    }
  };
  const closed = { status: 403, message: PROMOTE_START_CLOSED };
  const OPEN = { PROMOTE_ENABLED: "on", ...ENFORCING };
  const campaign = (surface: string, status = "paused") => ({ id: "c1", tenantId: "t1", surface, status, metaCampaignId: "MC1", currency: "INR", adSets: [] });
  const activate = async (role: Role, mode: "activate" | "resume" = "activate") => {
    const { activateCampaign } = await import("@/lib/ads/service");
    return activateCampaign(actor(role), "c1", { confirm: true, confirmedTotalMinor: 100 }, mode);
  };

  it("gates only campaigns made by Promote or Eddy; old-wizard and API campaigns, and rows with no surface, keep Phase 0's rules", () => {
    expect([...PROMOTE_START_SURFACES]).toEqual(["promote", "eddy"]);
    for (const env of [{}, { PROMOTE_ENABLED: "admins" }, { PROMOTE_ENABLED: "on" }]) {
      for (const surface of ["wizard", "api", null, undefined]) expect(thrown(() => assertPromoteStartOpen(actor("admin"), { surface }, env)), `${surface}`).toBeNull();
    }
  });

  it("refuses a promote or Eddy campaign with 403 and plain copy until Start is open (train P3), and always for an agent", () => {
    for (const surface of ["promote", "eddy"]) {
      for (const env of [{}, { PROMOTE_ENABLED: "off", ...ENFORCING }, { PROMOTE_ENABLED: "admins", ...ENFORCING }, { PROMOTE_ENABLED: "on" }, { PROMOTE_ENABLED: "on", SPEND_ENFORCE: "enforce" }, { PROMOTE_ENABLED: "on", SPEND_TRIPWIRE: "enforce" }]) {
        expect(thrown(() => assertPromoteStartOpen(actor("owner"), { surface }, env)), `${surface} ${JSON.stringify(env)}`).toEqual(closed);
      }
      expect(thrown(() => assertPromoteStartOpen(actor("owner"), { surface }, OPEN))).toBeNull();
      expect(thrown(() => assertPromoteStartOpen(actor("admin"), { surface }, OPEN))).toBeNull();
      expect(thrown(() => assertPromoteStartOpen(actor("agent"), { surface }, OPEN))).toEqual(closed);
    }
    // Pure: no lookup of the platform-admin rule or the sandbox account, even in admins mode.
    expect(h.user).not.toHaveBeenCalled();
    expect(h.control).not.toHaveBeenCalled();
  });

  it("activateCampaign refuses a promote draft while PROMOTE_ENABLED=admins, for activate and resume, before anything else happens", async () => {
    Object.assign(process.env, { PROMOTE_ENABLED: "admins", ...ENFORCING });
    h.campaign.mockResolvedValue(campaign("promote"));
    for (const mode of ["activate", "resume"] as const) expect(await refusal(activate("owner", mode)), mode).toEqual(closed);
    // The campaign load was the only database call: nothing was audited, reserved or sent (the fake has nothing else).
    expect(h.campaign).toHaveBeenCalledTimes(2);
    expect(h.campaign).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c1", tenantId: "t1" } }));
    h.campaign.mockResolvedValue(campaign("eddy"));
    expect(await refusal(activate("admin"))).toEqual(closed);
    // The same while spend controls only observe, with the feature fully on.
    Object.assign(process.env, { PROMOTE_ENABLED: "on", SPEND_ENFORCE: "observe", SPEND_TRIPWIRE: "observe" });
    expect(await refusal(activate("owner", "resume"))).toEqual(closed);
  });

  it("activateCampaign lets an old-wizard campaign, and a promote campaign once Start is open, past the gate to the usual checks", async () => {
    process.env.PROMOTE_ENABLED = "admins";
    h.campaign.mockResolvedValue(campaign("wizard", "active"));
    expect(await refusal(activate("owner"))).toEqual({ status: 409, message: "The campaign is already active." });
    Object.assign(process.env, OPEN);
    h.campaign.mockResolvedValue(campaign("promote", "active"));
    expect(await refusal(activate("owner"))).toEqual({ status: 409, message: "The campaign is already active." });
  });

  it("the gate stands right after the campaign is loaded, before the audit row, the reservation and any Meta call", () => {
    const src = readFileSync(path.join(process.cwd(), "src/lib/ads/service.ts"), "utf8");
    const body = src.slice(src.indexOf("export async function activateCampaign"));
    const load = body.indexOf("await mustLoad(tenantId, id)");
    const gate = body.indexOf("assertPromoteStartOpen(actor, c)");
    expect(load).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(load);
    for (const later of ["auditStrict(", "reserveAds(", "guardedClient("]) expect(gate, later).toBeLessThan(body.indexOf(later));
  });

  it("every /api/promote route that starts, activates or resumes spending asks the write guard for Start ({start: true})", () => {
    const root = path.join(process.cwd(), "src/app/api/promote");
    const routes: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === "route.ts") routes.push(path.relative(root, full).split(path.sep).join("/"));
      }
    };
    walk(root);
    expect(routes).toContain("access/route.ts");
    const SPENDS = /(^|\/)(start|activate|resume)(\/|$)/;
    for (const route of routes.filter((r) => SPENDS.test(r))) {
      const src = readFileSync(path.join(root, route), "utf8");
      expect(src, route).toMatch(/promoteRoute\(\s*"write"|promoteWrite\(/);
      expect(src, route).toMatch(/\bstart:\s*true\b/);
    }
  });
});

describe("GET /api/promote/access and the route class (PRM-00 acceptance 8)", () => {
  it("answers 404 while dark and the member's access once on, never cached", async () => {
    expect((await accessRoute(get())).status).toBe(404);
    process.env.PROMOTE_ENABLED = "on";
    h.getActor.mockResolvedValue(actor("agent"));
    const res = await accessRoute(get());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      access: { visible: true, canWrite: false, canStart: false, audiences: "off", video: "off", previews: "meta", goals: [...PROMOTE_GOAL_KEYS], experimental: false, pageLangs: ["en"] },
    });
  });

  it("classifies every route and method under /api/promote as v2 until PRM-13 gives each its action", () => {
    for (const [route, method] of [["/api/promote/access", "GET"], ["/api/promote/drafts", "POST"], ["/api/promote/drafts/[id]/start", "POST"], ["/api/promote/audiences/[id]", "DELETE"]] as const) {
      expect(notExposedEntry(route, method)).toMatchObject({ route: "/api/promote/**", reason: "v2" });
    }
    expect(notExposedEntry("/api/promotions", "GET")).toBeNull();
  });
});
