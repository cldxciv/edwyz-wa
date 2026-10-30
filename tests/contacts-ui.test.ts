import { describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/contacts/csv";
import { normalizePhone } from "@/lib/contacts/phone";
import {
  addChunkReport,
  analyzeImport,
  buildImportChunks,
  emptyReport,
  friendlyError,
  importProgress,
  importSummary,
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
    expect(optInView({ ...base, optIn: true, optedOutAt: "2026-02-01T00:00:00Z" }).label).toBe("Opted out");
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
    expect(analyzeImport("name\nAsha")).toMatchObject({ ok: false, problem: expect.stringMatching(/column named phone/) });
    const many = "phone\n" + Array.from({ length: 10_001 }, (_, i) => `+9198765${String(i).padStart(5, "0")}`).join("\n");
    expect(analyzeImport(many)).toMatchObject({ ok: false, problem: expect.stringMatching(/10,000/) });
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
  });
});
