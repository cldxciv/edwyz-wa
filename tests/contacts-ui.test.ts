import { describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/contacts/csv";
import { normalizePhone } from "@/lib/contacts/phone";
import {
  addChunkReport,
  analyzeImport,
  buildImportChunks,
  emptyReport,
  EXISTING_CHOICES,
  friendlyError,
  importProgress,
  importResultStats,
  importQuery,
  importSummary,
  addStopWord,
  OPTED_OUT_NOTE,
  OPT_OUT_WARNING,
  optInView,
  parseTagInput,
  sampleCsv,
} from "@/components/contacts/helpers";

describe("sampleCsv", () => {
  it("has the supported headers and parses with the server parser", () => {
    const rows = parseCsv(sampleCsv());
    expect(rows[0]).toEqual(["phone", "name", "tags", "opt_in", "opt_in_source"]);
    expect(rows.length).toBe(3);
    for (const r of rows.slice(1)) expect(normalizePhone(r[0])).not.toBeNull();
  });

  it("passes its own import analysis", () => {
    const a = analyzeImport(sampleCsv());
    expect(a).toMatchObject({ ok: true, ready: 2, invalid: 0, duplicates: 0, optInYes: 1 });
  });
});

describe("optInView", () => {
  const base = { optIn: false, optInSource: null, optInAt: null, optedOutAt: null };
  it("maps the three consent states", () => {
    expect(optInView(base).label).toBe("Not opted in");
    expect(optInView(base).status).toBe("inactive");
    const inn = optInView({ ...base, optIn: true, optInSource: "web form", optInAt: "2026-01-02T00:00:00Z" });
    expect(inn.label).toBe("Opted in");
    expect(inn.detail).toContain("web form");
    expect(optInView({ ...base, optIn: true, optedOutAt: "2026-02-01T00:00:00Z" }).label).toBe("Opted out of marketing");
  });
});

describe("parseTagInput", () => {
  it("splits, trims and dedupes", () => {
    expect(parseTagInput("a, b;a ,, c")).toEqual(["a", "b", "c"]);
  });
});

describe("friendlyError", () => {
  it("keeps plain server messages and hides technical ones", () => {
    expect(friendlyError(new Error("A contact with this phone number already exists."), "x")).toBe("A contact with this phone number already exists.");
    expect(friendlyError(new Error("PrismaClientKnownRequestError: P2002"), "fallback")).toBe("fallback");
    expect(friendlyError(new Error('{"error":1}'), "fallback")).toBe("fallback");
    expect(friendlyError(new Error("x".repeat(300)), "fallback")).toBe("fallback");
    expect(friendlyError(new TypeError("Failed to fetch"), "fallback")).toMatch(/could not reach/);
    expect(friendlyError(undefined, "fallback")).toBe("fallback");
  });
});

describe("analyzeImport", () => {
  const csv = [
    "phone,name,tags,opt_in,city",
    "+919876543210,Asha,vip;north,yes,Pune",
    "09123456789,Ravi,,no,",
    "+919876543210,Asha again,,yes,",
    "abc,Bad,,,",
    ",Empty,,,",
  ].join("\n");

  it("counts ready, duplicate and invalid rows like the server would", () => {
    const a = analyzeImport(csv);
    if (!a.ok) throw new Error("expected ok");
    expect(a.total).toBe(5);
    expect(a.ready).toBe(2);
    expect(a.duplicates).toBe(1);
    expect(a.invalid).toBe(2);
    expect(a.optInYes).toBe(1);
    expect(a.extraColumns).toEqual(["city"]);
    expect(a.rows.filter((r) => r.status === "invalid").map((r) => [r.row, r.reason])).toEqual([
      [5, "Not a valid phone number"],
      [6, "Phone number is empty"],
    ]);
    expect(a.preview[0]).toMatchObject({ phone: "+919876543210", name: "Asha", tags: "vip, north", optIn: true });
    expect(a.preview[1].phone).toBe("+919123456789");
  });

  it("explains fatal problems in plain words", () => {
    expect(analyzeImport("  ")).toMatchObject({ ok: false });
    expect(analyzeImport("phone\n")).toMatchObject({ ok: false, problem: expect.stringMatching(/no contacts/) });
    expect(analyzeImport("name\nAsha")).toMatchObject({ ok: false, problem: expect.stringMatching(/column named phone.*Phone Number, Mobile, WhatsApp or wa_id also work/) });
    const many = "phone\n" + Array.from({ length: 10_001 }, (_, i) => `+9198765${String(i).padStart(5, "0")}`).join("\n");
    expect(analyzeImport(many)).toMatchObject({ ok: false, problem: expect.stringMatching(/10,000/) });
  });
});

describe("phone column names", () => {
  it("reads files exported by other tools, the way the server will", () => {
    const a = analyzeImport("Name,Phone Number,City\nAsha,98765 43210,Pune\n");
    if (!a.ok) throw new Error("expected ok");
    expect(a).toMatchObject({ ready: 1, phoneColumn: "Phone Number", extraColumns: ["city"] });
    expect(a.preview[0]).toMatchObject({ phone: "+919876543210", name: "Asha" });
    for (const header of ["Mobile", "mobile number", "WhatsApp", "whatsapp-number", "phone_number"]) {
      expect(analyzeImport(`${header}\n9876543210\n`)).toMatchObject({ ok: true, ready: 1, phoneColumn: header, extraColumns: [] });
    }
  });

  it("treats wa_id as international and sends chunks the server parses the same way", () => {
    const a = analyzeImport("wa_id,name\n14155550123,Sam\n");
    if (!a.ok) throw new Error("expected ok");
    expect(a.preview[0].phone).toBe("+14155550123");
    expect(parseCsv(buildImportChunks(a)[0].csv)[0]).toEqual(["wa_id", "name"]);
  });

  it("uses a column named phone first; another phone-like column stays an extra detail", () => {
    const a = analyzeImport("mobile,phone\n+911111111111,+919876543210\n");
    if (!a.ok) throw new Error("expected ok");
    expect(a).toMatchObject({ phoneColumn: "phone", extraColumns: ["mobile"] });
    expect(a.preview[0].phone).toBe("+919876543210");
  });
});

describe("opt-out notices", () => {
  it("say exactly what an opt-out does (owner default 1): no marketing, order updates and replies still arrive, START brings offers back", () => {
    for (const text of [OPT_OUT_WARNING, OPTED_OUT_NOTE]) {
      expect(text).toMatch(/no marketing messages/i);
      expect(text).toMatch(/Order updates and replies to their own messages can still arrive/);
      expect(text).toMatch(/send START to get offers again/);
      expect(text).not.toMatch(/no template message|not even order/i);
    }
    expect(OPT_OUT_WARNING).toMatch(/cannot opt them in again/);
    expect(OPTED_OUT_NOTE).toMatch(/utility templates, like order or delivery updates/);
  });
});

describe("STOP words editor", () => {
  it("adds a workspace word normalised, and refuses defaults, duplicates, START words and empty input", () => {
    expect(addStopWord([], "  Band Karo! ")).toEqual({ ok: true, word: "band karo", words: ["band karo"] });
    expect(addStopWord(["band karo"], "BAND KARO")).toMatchObject({ ok: false, reason: expect.stringMatching(/already a STOP word/) });
    expect(addStopWord([], "Opt-Out")).toMatchObject({ ok: false, reason: expect.stringMatching(/already a STOP word/) });
    expect(addStopWord([], "start")).toMatchObject({ ok: false, reason: expect.stringMatching(/START|get offers again/) });
    expect(addStopWord([], "!!")).toMatchObject({ ok: false, reason: expect.stringMatching(/letter or number/) });
    expect(addStopWord([], "x".repeat(41))).toMatchObject({ ok: false, reason: expect.stringMatching(/40 characters/) });
  });

  it("stops at the workspace limit", () => {
    const full = Array.from({ length: 20 }, (_, i) => `word${i}`);
    expect(addStopWord(full, "one more")).toMatchObject({ ok: false, reason: expect.stringMatching(/up to 20/) });
  });

  it("renders the full list: the defaults and the workspace's own words, each removable one with a labelled button", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { StopWordsEditor } = await import("@/components/contacts/StopWordsEditor");
    const html = renderToStaticMarkup(createElement(StopWordsEditor, { words: ["band karo"], onChange: () => undefined }));
    for (const w of ["stop", "stop all", "unsubscribe", "opt out", "cancel", "end", "quit", "band karo"]) expect(html).toContain(`>${w}`);
    expect(html).toContain('aria-label="Remove STOP word band karo"');
    expect(html).not.toContain('aria-label="Remove STOP word stop"');
    expect(html).toContain("Order updates and replies to their own messages can");
    expect(html).toContain('aria-live="polite"');
    expect(html).toMatch(/<label[^>]*for="[^"]+"[^>]*>Add a word<\/label>/);
    const readOnly = renderToStaticMarkup(createElement(StopWordsEditor, { words: ["band karo"], onChange: () => undefined, readOnly: true }));
    expect(readOnly).not.toContain("Remove STOP word");
    expect(readOnly).not.toContain("Add a word");
  });
});

describe("contacts import and Shopify consent (owner default 2)", () => {
  it("never reads a Shopify accepts-marketing column as a WhatsApp opt-in", () => {
    const csv = "Phone,First Name,Accepts Email Marketing,Accepts SMS Marketing\n+919876543210,Asha,yes,yes\n";
    const a = analyzeImport(csv);
    if (!a.ok) throw new Error("expected ok");
    expect(a.optInYes).toBe(0);
    expect(a.preview[0].optIn).toBe(false);
    expect(a.extraColumns).toEqual(expect.arrayContaining(["accepts email marketing", "accepts sms marketing"]));
  });
});

describe("import chunks", () => {
  const rows = Array.from({ length: 7 }, (_, i) => `+9198765432${String(i).padStart(2, "0")},Person ${i}`);
  const a = analyzeImport(["phone,name", ...rows, "bad,Nope", rows[0]].join("\n"));
  if (!a.ok) throw new Error("expected ok");

  it("sends only importable rows, in batches the server parser accepts", () => {
    const chunks = buildImportChunks(a, 3);
    expect(chunks.map((c) => c.rows.length)).toEqual([3, 3, 1]);
    expect(chunks.flatMap((c) => c.rows)).not.toContain(9);
    expect(chunks.flatMap((c) => c.rows)).not.toContain(10);
    for (const c of chunks) {
      const parsed = parseCsv(c.csv);
      expect(parsed[0]).toEqual(["phone", "name"]);
      expect(parsed.length - 1).toBe(c.rows.length);
    }
  });

  it("keeps commas and quotes in names intact", () => {
    const q = analyzeImport('phone,name\n+919876543210,"Verma, Asha ""AV"""');
    if (!q.ok) throw new Error("expected ok");
    expect(parseCsv(buildImportChunks(q)[0].csv)[1][1]).toBe('Verma, Asha "AV"');
  });

  it("merges chunk reports and maps rows back to the file", () => {
    let total = emptyReport();
    total = addChunkReport(total, { created: 2, updated: 1, skipped: 0, errors: [{ row: 3, reason: "x" }] }, [10, 11, 12]);
    total = addChunkReport(total, { created: 1, updated: 0, skipped: 0, errors: [] }, [13]);
    expect(total).toEqual({ created: 3, updated: 1, skipped: 0, errors: [{ row: 11, reason: "x" }] });
  });

  it("reports progress and a short summary", () => {
    expect(importProgress(0, 0)).toBe(0);
    expect(importProgress(250, 1000)).toBe(25);
    expect(importProgress(2000, 1000)).toBe(100);
    expect(importSummary({ created: 1, updated: 2, skipped: 0, errors: [] })).toBe("1 new contact added, 2 contacts updated.");
    expect(importSummary(emptyReport())).toBe("No contacts were added or changed.");
    expect(importSummary({ created: 2, updated: 0, skipped: 4, errors: [] }, 3)).toBe("2 new contacts added, 3 saved contacts left unchanged.");
    expect(importSummary(emptyReport(), 1)).toBe("1 saved contact left unchanged.");
  });

  it("posts each batch with the existing-contacts choice the route reads", () => {
    expect(EXISTING_CHOICES.map((c) => c.value)).toEqual(["update", "skip"]);
    expect(importQuery("update")).toBe("");
    expect(importQuery("skip")).toBe("?existing=skip");
  });

  it("shows people left alone by 'skip' apart from duplicates in the file", () => {
    const report = { created: 5, updated: 0, skipped: 3, errors: [{ row: 9, reason: "x" }] };
    expect(importResultStats(report, "skip", 2)).toEqual([
      { label: "Added", value: 5 },
      { label: "Left unchanged", value: 2 },
      { label: "Duplicates skipped", value: 1 },
      { label: "Left out", value: 1 },
    ]);
    expect(importResultStats({ ...report, updated: 4, skipped: 1 }, "update", 0)).toEqual([
      { label: "Added", value: 5 },
      { label: "Updated", value: 4 },
      { label: "Duplicates skipped", value: 1 },
      { label: "Left out", value: 1 },
    ]);
  });
});
