import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Seams between the packages of wave 4 (P09 to P13) that each package's own tests could not see, because the other side
 * was being written at the same time:
 *
 * 1. The action definitions' catalogue (P11, src/lib/eddy/copy/defs.ts) registers itself on import, but no client file
 *    imported it, so cards and done rows showed raw keys such as "defs.fact.tags_added". EddyRoot (P13) now imports it.
 * 2. open_page and the connect intents (P11) are chips and cards the member taps (EDDY-SPEC 4.6, 6.15), but EddyRoot (P13)
 *    navigated as soon as the intent arrived. They are now transcript items; only composer_draft and open_templates run.
 * 3. GET /api/eddy/status (P12) did not send historyDays and the panel (P13) dropped unknown fields, so the first-use
 *    notice, the enable card and the delete line always said 90 days, whatever retention the platform configured.
 * 4. get_conversation's customerLanguage (P11) used a local heuristic until P12's detector existed; it now uses it.
 * 5. list_templates (P11) could not filter the `flagged` template status that P10 added.
 * 6. Both P12 (scripted.json) and P13 (panel-e2e.json) wrote the same scripted e2e scenarios; the file that sorts first
 *    silently won. A `match` now appears in one file only.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/app" }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));

// Several tests load the action registry and the Eddy React tree from a reset module graph: about 3 s alone, much more
// while the full suite runs in parallel (the same reason tests/actions-defs.test.ts allows 30 s).
vi.setConfig({ testTimeout: 30_000 });

const ROOT = path.resolve(__dirname, "..");

describe("1. the definitions' catalogue reaches the browser", () => {
  afterEach(() => vi.resetModules());

  it("is registered once EddyRoot (always mounted in AppShell) is loaded, and not before", async () => {
    vi.resetModules();
    const i18n = await import("@/lib/eddy/i18n");
    expect(i18n.hasKey("defs.fact.tags_added")).toBe(false);
    expect(i18n.hasKey("card.tag_contacts.title")).toBe(false);
    await import("@/components/eddy/EddyRoot");
    expect(i18n.hasKey("defs.fact.tags_added")).toBe(true);
    expect(i18n.translateKey("en", "card.tag_contacts.title", { count: 12 })).toBe("Change tags on 12 contacts?");
    expect(i18n.translateKey("hinglish", "card.set_my_availability.confirm")).toBe("Mujhe away dikhayein");
    expect(i18n.translateKey("hi", "defs.role.agent")).toBe("टीम सदस्य");
  });

  it("is imported by EddyRoot itself, not only by a test", () => {
    const src = readFileSync(path.join(ROOT, "src/components/eddy/EddyRoot.tsx"), "utf8");
    expect(src).toMatch(/^import "@\/lib\/eddy\/copy\/defs";$/m);
  });
});

describe("2. navigate and connect intents wait for the member's tap", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The loop's own mapping from a definition's UI hint to the stream event (src/lib/eddy/loop.ts intentOf). */
  function eventFromHint(ui: { kind: string; [k: string]: unknown }) {
    if (ui.kind === "navigate") return { type: "intent", kind: "navigate", payload: { path: ui.path, labelKey: ui.labelKey } } as const;
    if (ui.kind === "intent") return { type: "intent", kind: ui.intent as "connect_whatsapp" | "connect_facebook", payload: ui.payload ?? {} } as const;
    throw new Error(`unexpected hint ${ui.kind}`);
  }

  it("open_page's hint becomes a chip to the page; the turn itself never navigates", async () => {
    const { actionByName } = await import("@/lib/actions");
    const { streamReducer, initialStreamState } = await import("@/components/eddy/useEddyStream");
    const { runIntent } = await import("@/components/eddy/EddyRoot");
    const { t } = await import("@/lib/eddy/i18n");
    const def = actionByName("open_page")!;
    const hint = def.forUi!({ path: "/app/inbox?c=cv_1", label: "Inbox" } as never, {} as never) as { kind: string };
    const event = eventFromHint(hint);
    const navigate = vi.fn();
    runIntent(event, navigate, undefined);
    expect(navigate).not.toHaveBeenCalled();

    const s = streamReducer(initialStreamState, { type: "event", event });
    expect(s.items).toEqual([{ kind: "chips", id: "i1", lang: "en", chips: [{ path: "/app/inbox?c=cv_1", label: t("en", "btn.open_page") }] }]);

    // In the reply's language, and a refused path shows nothing.
    const hi = streamReducer({ ...initialStreamState, lang: "hi" }, { type: "event", event });
    expect(hi.items[0]).toMatchObject({ kind: "chips", lang: "hi", chips: [{ label: t("hi", "btn.open_page") }] });
    for (const bad of ["https://evil.example/app", "//evil.example/app", "/app/../admin", "/admin"]) {
      expect(streamReducer(initialStreamState, { type: "event", event: { type: "intent", kind: "navigate", payload: { path: bad } } }).items).toEqual([]);
    }
  });

  it("connect_whatsapp and connect_facebook become cards with one chip to the connect page", async () => {
    const { actionByName } = await import("@/lib/actions");
    const { streamReducer, initialStreamState, CONNECT_FACEBOOK_PATH, CONNECT_WHATSAPP_PATH } = await import("@/components/eddy/useEddyStream");
    type StreamState = typeof initialStreamState;
    const { runIntent } = await import("@/components/eddy/EddyRoot");
    const { t } = await import("@/lib/eddy/i18n");
    const navigate = vi.fn();
    let s: StreamState = { ...initialStreamState, lang: "hinglish" };
    for (const name of ["connect_whatsapp", "connect_facebook"]) {
      const def = actionByName(name)!;
      const result = name === "connect_whatsapp" ? { path: "/app/settings/connect?from=eddy" } : { start: "/api/meta-connect/start", returnPath: "/app/settings/connections" };
      const event = eventFromHint(def.forUi!(result as never, {} as never) as { kind: string });
      runIntent(event, navigate, undefined);
      s = streamReducer(s, { type: "event", event });
    }
    expect(navigate).not.toHaveBeenCalled();
    expect(s.items).toEqual([
      { kind: "action", id: "i1", lang: "hinglish", title: t("hinglish", "done.connect_whatsapp"), chips: [{ path: CONNECT_WHATSAPP_PATH, label: t("hinglish", "btn.connect_whatsapp") }] },
      { kind: "action", id: "i2", lang: "hinglish", title: t("hinglish", "done.connect_facebook"), chips: [{ path: CONNECT_FACEBOOK_PATH, label: t("hinglish", "btn.connect_facebook") }] },
    ]);
    // The paths the cards lead to are the ones open_page and the connect definitions name.
    expect(CONNECT_WHATSAPP_PATH).toBe("/app/settings/connect?from=eddy");
    expect(CONNECT_FACEBOOK_PATH.startsWith("/app/settings/connections")).toBe(true);
  });

  it("drafts and the template picker still act at once, and leave the transcript alone", async () => {
    const { streamReducer, initialStreamState } = await import("@/components/eddy/useEddyStream");
    const { runIntent } = await import("@/components/eddy/EddyRoot");
    const { EDDY_EVENTS, onEddyEvent } = await import("@/components/eddy/events");
    const target = new EventTarget();
    vi.stubGlobal("window", Object.assign(target, { setTimeout: (fn: () => void) => (fn(), 1) }));
    const seen: unknown[] = [];
    const offDraft = onEddyEvent(EDDY_EVENTS.draft, (d) => seen.push(["draft", d]), target);
    const offTpl = onEddyEvent(EDDY_EVENTS.openTemplates, (d) => seen.push(["templates", d]), target);
    const draft = { type: "intent", kind: "composer_draft", payload: { conversationId: "cv1", text: "Namaste" } } as const;
    const pick = { type: "intent", kind: "open_templates", payload: { conversationId: "cv1" } } as const;
    runIntent(draft, vi.fn(), "cv1");
    runIntent(pick, vi.fn(), "cv1");
    expect(seen).toEqual([
      ["draft", { conversationId: "cv1", text: "Namaste" }],
      ["templates", { conversationId: "cv1" }],
    ]);
    expect(streamReducer(streamReducer(initialStreamState, { type: "event", event: draft }), { type: "event", event: pick })).toEqual(initialStreamState);
    offDraft();
    offTpl();
  });

  it("closes a streaming reply before the chip, so the chip sits after the words that offer it", async () => {
    const { streamReducer, initialStreamState } = await import("@/components/eddy/useEddyStream");
    let s = streamReducer(initialStreamState, { type: "event", event: { type: "delta", text: "Here it is." } });
    s = streamReducer(s, { type: "event", event: { type: "intent", kind: "navigate", payload: { path: "/app/templates", labelKey: "btn.open_page" } } });
    s = streamReducer(s, { type: "event", event: { type: "delta", text: "Anything else?" } });
    expect(s.items.map((it) => [it.kind, it.id])).toEqual([
      ["eddy", "e1"],
      ["chips", "i2"],
      ["eddy", "e3"],
    ]);
    expect(s.items[0]).toMatchObject({ streaming: false, text: "Here it is." });
  });

  it("renders the chip as an /app link and announces a connect card politely", async () => {
    const { MessageView } = await import("@/components/eddy/MessageView");
    const { announcementFor } = await import("@/components/eddy/Transcript");
    const { streamReducer, initialStreamState } = await import("@/components/eddy/useEddyStream");
    const s = streamReducer(initialStreamState, { type: "event", event: { type: "intent", kind: "navigate", payload: { path: "/app/templates", labelKey: "btn.open_page" } } });
    const html = renderToStaticMarkup(h(MessageView, { item: s.items[0] }));
    expect(html).toContain('href="/app/templates"');
    expect(html).toContain("data-eddy-nav-chip");
    expect(html).toContain("Open the page");

    const c = streamReducer(initialStreamState, { type: "event", event: { type: "intent", kind: "connect_whatsapp", payload: {} } });
    const card = renderToStaticMarkup(h(MessageView, { item: c.items[0] }));
    expect(card).toContain('role="group"');
    expect(card).toContain('href="/app/settings/connect?from=eddy"');
    expect(announcementFor([], c.items)).toBe("Ready. Tap to connect WhatsApp.");
  });
});

describe("3. the chat retention the panel states is the platform's own", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/auth");
    vi.doUnmock("@/lib/eddy/model-binding");
    vi.doUnmock("@/lib/eddy/status");
    vi.doUnmock("@/lib/eddy/settings");
    vi.resetModules();
  });

  it("GET /api/eddy/status carries historyDays, and the panel keeps it through parseStatus", async () => {
    vi.resetModules();
    const status = { state: "ready", readOnly: false, canEnable: true, ownerNames: ["Asha"], allowance: { usedToday: 0, limitToday: null, usedMonth: 0, limitMonth: null, resetsOn: null, memberUsedToday: 0, memberLimitToday: 40 }, langPref: "auto", needsYou: 0, demo: false, whatsapp: "connected", phase: 1, firstUse: true, spendingStopped: false };
    vi.doMock("@/lib/auth", () => ({ getActor: vi.fn(async () => ({ tenantId: "t1", userId: "u1", role: "owner" })) }));
    vi.doMock("@/lib/eddy/model-binding", () => ({ defaultStatusDeps: vi.fn(async () => ({})) }));
    vi.doMock("@/lib/eddy/status", () => ({ eddyStatus: vi.fn(async () => status) }));
    vi.doMock("@/lib/eddy/settings", () => ({ eddyHistoryDays: vi.fn(async () => 60) }));
    const { GET } = await import("@/app/api/eddy/status/route");
    const res = await GET(new Request("https://wa.example.test/api/eddy/status"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toEqual({ ...status, historyDays: 60 });

    const { parseStatus, historyDaysOf } = await import("@/components/eddy/useEddyStatus");
    expect(historyDaysOf(parseStatus(json))).toBe(60);
    // Without the field, or with a value outside the retention limits (30 to 365), the panel says 90 as before.
    expect(historyDaysOf(parseStatus(status))).toBe(90);
    expect(parseStatus({ ...status, historyDays: 7 })).not.toHaveProperty("historyDays");
    expect(parseStatus({ ...status, historyDays: 400 })).not.toHaveProperty("historyDays");
  });
});

describe("4. get_conversation's customer language uses Eddy's detector (5.7)", () => {
  it("agrees with src/lib/eddy/language.ts and is null before the customer wrote anything", async () => {
    const { customerLanguage } = await import("@/lib/actions/defs/inbox");
    const eddy = await import("@/lib/eddy/language");
    const cases: string[][] = [
      ["Hello", "Is the shop open today?"],
      ["नमस्ते", "मेरा ऑर्डर कब आएगा?"],
      ["bhaiya order kab aayega?", "kal tak mil jayega kya?", "jaldi bata do"],
      ["mujhe refund chahiye", "paisa wapas karo yaar"],
      ["Order #4521 https://shop.example/t/4521", "ok"],
    ];
    for (const texts of cases) expect(customerLanguage(texts)).toBe(eddy.customerLanguage(texts));
    expect(customerLanguage(["bhaiya order kab aayega?", "kal tak mil jayega kya?", "jaldi bata do"])).toBe("hinglish");
    expect(customerLanguage([])).toBeNull();
    expect(customerLanguage(["12345", "  ", "👍"])).toBeNull();
  });
});

describe("5. list_templates knows the flagged status", () => {
  it("accepts flagged as a filter and explains it", async () => {
    const { actionByName } = await import("@/lib/actions");
    const { validate } = await import("@/lib/actions/schema");
    const def = actionByName("list_templates")!;
    expect(validate(def.inputSchema, { status: "flagged" })).toBeNull();
    expect(validate(def.inputSchema, { status: "nope" })).not.toBeNull();
    expect(def.description).toMatch(/flagged/);
    // The filter lists every value of the TemplateStatus enum in the schema, so no status is unreachable.
    const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
    const values = /enum TemplateStatus \{([^}]*)\}/
      .exec(schema)![1]
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "").trim())
      .filter(Boolean)
      .sort();
    expect(values).toContain("flagged");
    const props = (def.inputSchema as unknown as { properties: { status: { enum: string[] } } }).properties.status.enum;
    expect([...props].sort()).toEqual(values);
  });
});

describe("6. scripted e2e scenarios (EDDY_FAKE_MODEL=scripted)", () => {
  it("each match string lives in one fixture file only, so no scenario is silently shadowed", () => {
    const dir = path.join(ROOT, "e2e", "fixtures", "eddy");
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
      const fixture = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as { scenarios?: { id: string; match?: string }[] };
      for (const s of fixture.scenarios ?? []) {
        if (!s.match) continue;
        const key = s.match.toLowerCase();
        const where = `${name}#${s.id}`;
        if (seen.has(key)) dupes.push(`"${s.match}" in ${seen.get(key)} and ${where}`);
        else seen.set(key, where);
      }
    }
    expect(dupes).toEqual([]);
    // The panel scenarios e2e/eddy.spec.ts sends resolve to panel-e2e.json.
    for (const m of ["e2e-eddy hinglish", "e2e-eddy tag vip", "e2e-eddy send reply", "e2e-eddy delete template"]) expect(seen.get(m)).toMatch(/^panel-e2e\.json#/);
  });
});
