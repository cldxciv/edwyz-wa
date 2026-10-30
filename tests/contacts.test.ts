import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;
const store: Row[] = [];

vi.mock("@/lib/billing", () => ({ assertWithinLimit: async () => undefined }));
vi.mock("@/lib/db", () => ({
  prisma: {
    contact: {
      findMany: vi.fn(async ({ where }: any) => store.filter((c) => c.tenantId === where.tenantId && where.phone.in.includes(c.phone))),
      createMany: vi.fn(async ({ data }: any) => {
        for (const d of data) {
          if (!store.some((c) => c.tenantId === d.tenantId && c.phone === d.phone)) {
            store.push({ id: `c${store.length + 1}`, optIn: false, optedOutAt: null, tags: [], attributes: {}, name: null, ...d });
          }
        }
        return { count: data.length };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        Object.assign(store.find((c) => c.id === where.id)!, data);
      }),
      findFirst: vi.fn(async ({ where }: any) =>
        store.find((c) => c.tenantId === where.tenantId && (where.id ? c.id === where.id : c.phone === where.phone)) ?? null,
      ),
    },
  },
}));

import { parseCsv } from "@/lib/contacts/csv";
import { importContacts } from "@/lib/contacts/import";
import { normalizePhone } from "@/lib/contacts/phone";
import { updateContact } from "@/lib/contacts/service";

describe("normalizePhone", () => {
  const table: [string, string | null][] = [
    ["98765 43210", "+919876543210"],
    ["+91 98765-43210", "+919876543210"],
    ["(98765) 43210", "+919876543210"],
    ["09876543210", "+919876543210"],
    ["00919876543210", "+919876543210"],
    ["919876543210", "+919876543210"],
    ["+14155552671", "+14155552671"],
    ["0014155552671", "+14155552671"],
    ["12345", null],
    ["+1234567", null],
    ["+1234567890123456", null],
    ["abc", null],
    ["", null],
    ["98+76543210", null],
  ];
  it.each(table)("%s -> %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it("uses a custom default country code", () => {
    expect(normalizePhone("4155552671", "1")).toBe("+14155552671");
  });
});

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, CRLF and embedded newlines", () => {
    const text = 'phone,name\r\n"+91 1","Smith, ""Bob"""\r\n2,"line1\nline2"\r\n';
    expect(parseCsv(text)).toEqual([
      ["phone", "name"],
      ["+91 1", 'Smith, "Bob"'],
      ["2", "line1\nline2"],
    ]);
  });
  it("strips BOM, skips blank lines, keeps empty fields", () => {
    expect(parseCsv("﻿a,b,c\n\n1,,3")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });
  it("handles a final row without a newline", () => {
    expect(parseCsv("a\n1")).toEqual([["a"], ["1"]]);
  });
});

describe("importContacts", () => {
  beforeEach(() => {
    store.length = 0;
  });
  const now = new Date("2026-01-01T00:00:00Z");

  it("creates contacts, stores extra columns as attributes, dedupes within the file", async () => {
    const csv = "phone,name,tags,opt_in,city\n98765 43210,Asha,vip;north,yes,Shimla\n+919876543210,Dup,,,\nbad,X,,,\n";
    const report = await importContacts("t1", csv, { now });
    expect(report).toEqual({ created: 1, updated: 0, skipped: 1, errors: [{ row: 4, reason: "Invalid phone number." }] });
    expect(store[0]).toMatchObject({
      phone: "+919876543210",
      tags: ["vip", "north"],
      attributes: { city: "Shimla" },
      optIn: true,
      optInSource: "csv_import",
      optInAt: now,
    });
  });

  it("upserts against existing contacts and merges tags", async () => {
    store.push({ id: "c1", tenantId: "t1", phone: "+919876543210", name: "Old", tags: ["a"], attributes: {}, optIn: false, optedOutAt: null });
    const report = await importContacts("t1", "phone,name,tags,opt_in,opt_in_source\n9876543210,New,b,true,web_form\n", { now });
    expect(report.updated).toBe(1);
    expect(store[0]).toMatchObject({ name: "New", tags: ["a", "b"], optIn: true, optInSource: "web_form" });
  });

  it("never re-opts-in an opted-out contact", async () => {
    const out = new Date("2025-06-01T00:00:00Z");
    store.push({ id: "c1", tenantId: "t1", phone: "+919876543210", name: "X", tags: [], attributes: {}, optIn: false, optedOutAt: out });
    await importContacts("t1", "phone,opt_in\n9876543210,yes\n", { now });
    expect(store[0].optIn).toBe(false);
    expect(store[0].optedOutAt).toBe(out);
  });

  it("does not touch another tenant's contacts", async () => {
    store.push({ id: "c1", tenantId: "t2", phone: "+919876543210", name: "Theirs", tags: [], attributes: {}, optIn: false, optedOutAt: null });
    const report = await importContacts("t1", "phone,name\n9876543210,Mine\n", { now });
    expect(report.created).toBe(1);
    expect(store.find((c) => c.tenantId === "t2")!.name).toBe("Theirs");
  });

  it("rejects missing phone column and oversize files", async () => {
    await expect(importContacts("t1", "name\nA\n")).rejects.toMatchObject({ status: 400 });
    const big = "phone\n" + Array.from({ length: 10_001 }, (_, i) => `98${String(i).padStart(8, "0")}`).join("\n");
    await expect(importContacts("t1", big)).rejects.toMatchObject({ status: 400 });
  });
});

describe("updateContact", () => {
  beforeEach(() => {
    store.length = 0;
  });
  const actor = { userId: "u", tenantId: "t1", role: "admin" as const };

  it("requires a source to opt in and refuses opted-out contacts", async () => {
    store.push({ id: "c1", tenantId: "t1", phone: "+911", optIn: false, optedOutAt: new Date() });
    await expect(updateContact(actor, "c1", { optIn: true })).rejects.toMatchObject({ status: 400 });
    await expect(updateContact(actor, "c1", { optIn: true, optInSource: "form" })).rejects.toMatchObject({ status: 409 });
  });

  it("404s for another tenant's contact", async () => {
    store.push({ id: "c9", tenantId: "t2", phone: "+912", optIn: false, optedOutAt: null });
    await expect(updateContact(actor, "c9", { name: "x" })).rejects.toMatchObject({ status: 404 });
  });
});
