import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "@/lib/log";
import {
  contactEmail,
  CUSTOMER_SCHEMA,
  customerRow,
  IDENTITY_SCHEMA,
  identityRow,
  isHashed,
  normalizeCountry,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  sha256Hex,
  splitName,
} from "@/lib/promote/hashing";

/**
 * docs/IG-PAGE-ADS-SPEC.md 4.2 A2 to A4, D17 and PRM-11 acceptance 1 (promote-hashing): Meta's normalisation, then SHA-256 hex.
 * Email trimmed and lowercased; phone digits with the country code and no leading zeros (+91 by default); names lowercased
 * with Unicode kept; COUNTRY a 2-letter lowercase code. Nothing is logged, so no plain value can reach a log.
 */
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Hashes computed once from the normal forms (and checked against node's own SHA-256 below). */
const VECTORS = {
  "john.doe@example.com": "836f82db99121b3481011f16b49dfa5fbc714a0d1b1b9f784a1ebbbf5b39577f",
  "919876543210": "92b5072176e723878b5e06ff3ca61898e4eb74e8c46642a0f2db800b17364ab0",
  "16505551234": "6069d14bf122fdfd931dc7beb58e5dfbba395b1faf05bdcd42d12358d63d8599",
  mary: "6915771be1c5aa0c886870b6951b03d7eafc121fea0e80a5ea83beb7c449f4ec",
  "josé": "d994e1d001886fe5b45b1267bd1fa2b752ac50742579bd3dad7b2a2aa0ed6866",
  "राहुल": "e322a0dbd11906e29e18b7efae1336372dc9a3ff71fed7bf7f06d3546072ac4d",
  in: "582967534d0f909d196b97f9e6921342777aea87b46fa52df165389db1fb8ccf",
} as const;

describe("SHA-256 hex", () => {
  it("matches the standard vector and node's own hash, in lowercase hex", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    for (const [plain, hex] of Object.entries(VECTORS)) {
      expect(sha256Hex(plain), plain).toBe(hex);
      expect(sha(plain), plain).toBe(hex);
      expect(isHashed(hex)).toBe(true);
    }
    expect(isHashed("ABC")).toBe(false);
    expect(isHashed(VECTORS.mary.toUpperCase())).toBe(false);
  });
});

describe("Meta's normalisation", () => {
  it("email: trimmed and lowercased; anything that is not an address is dropped", () => {
    expect(normalizeEmail("  John.Doe@Example.COM ")).toBe("john.doe@example.com");
    expect(normalizeEmail("JOHN.DOE@EXAMPLE.COM")).toBe("john.doe@example.com");
    expect(normalizeEmail("not an email")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull();
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });

  it("phone: digits with the country code; +91 by default; leading zeros stripped", () => {
    for (const input of ["+91 98765 43210", "+91-98765-43210", "+91 (98765) 43210", "919876543210", "9876543210", "098765 43210", "0091 98765 43210", "00919876543210"]) {
      expect(normalizePhone(input), input).toBe("919876543210");
    }
    expect(normalizePhone("+1 (650) 555-1234")).toBe("16505551234");
    // Another workspace default: a number without a country code gets it.
    expect(normalizePhone("6505551234", "1")).toBe("16505551234");
    // An invalid default falls back to India rather than inventing a code.
    expect(normalizePhone("9876543210", "abc")).toBe("919876543210");
    expect(normalizePhone("call me")).toBeNull();
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });

  it("names: lowercased, Unicode kept (NFC), punctuation and symbols removed", () => {
    expect(normalizeName("  Mary ")).toBe("mary");
    expect(normalizeName("MARY")).toBe("mary");
    expect(normalizeName("José")).toBe("josé");
    // The same name typed with a combining accent (NFD) hashes the same.
    expect(normalizeName("José")).toBe("josé");
    expect(normalizeName("राहुल")).toBe("राहुल");
    expect(normalizeName("O'Brien")).toBe("obrien");
    expect(normalizeName("Dr. Anne-Marie!")).toBe("dr annemarie");
    expect(normalizeName("...")).toBeNull();
    expect(normalizeName(7)).toBeNull();
    expect(splitName("  Rahul Kumar Sharma ")).toEqual({ first: "rahul", last: "sharma" });
    expect(splitName("Rahul")).toEqual({ first: "rahul", last: null });
    expect(splitName("")).toEqual({ first: null, last: null });
  });

  it("country: a 2-letter lowercase code", () => {
    expect(normalizeCountry("IN")).toBe("in");
    expect(normalizeCountry(" us ")).toBe("us");
    expect(normalizeCountry("IND")).toBeNull();
    expect(normalizeCountry("I1")).toBeNull();
    expect(normalizeCountry(null)).toBeNull();
  });
});

describe("rows", () => {
  it("a customer row is EMAIL, PHONE, FN, LN, COUNTRY, every value hashed", () => {
    expect(CUSTOMER_SCHEMA).toEqual(["EMAIL", "PHONE", "FN", "LN", "COUNTRY"]);
    const row = customerRow({ email: " John.Doe@Example.COM", phone: "098765 43210", name: "Mary José" });
    expect(row).toEqual([VECTORS["john.doe@example.com"], VECTORS["919876543210"], VECTORS.mary, VECTORS["josé"], VECTORS.in]);
    for (const value of row!) expect(isHashed(value)).toBe(true);
  });

  it("COUNTRY comes from the phone's calling code, else the workspace's (in)", () => {
    expect(customerRow({ phone: "+1 650 555 1234" })![4]).toBe(sha("us"));
    expect(customerRow({ email: "a@b.co" })![4]).toBe(VECTORS.in);
    expect(customerRow({ email: "a@b.co" }, { country: "AE" })![4]).toBe(sha("ae"));
    expect(customerRow({ email: "a@b.co", country: "GB" })![4]).toBe(sha("gb"));
  });

  it("an unknown value is an empty string, and a person with neither email nor phone has no row", () => {
    expect(customerRow({ email: "a@b.co" })).toEqual([sha("a@b.co"), "", "", "", VECTORS.in]);
    expect(customerRow({ name: "Mary" })).toBeNull();
    expect(customerRow({ email: "nope", phone: "nope" })).toBeNull();
  });

  it("a removal row is EMAIL and PHONE only", () => {
    expect(IDENTITY_SCHEMA).toEqual(["EMAIL", "PHONE"]);
    expect(identityRow({ email: "John.Doe@example.com", phone: "+91 98765 43210" })).toEqual([VECTORS["john.doe@example.com"], VECTORS["919876543210"]]);
    expect(identityRow({ phone: "9876543210" })).toEqual(["", VECTORS["919876543210"]]);
    expect(identityRow({})).toBeNull();
  });

  it("reads the contact's email from its attributes", () => {
    expect(contactEmail({ email: "x@y.in", city: "Pune" })).toBe("x@y.in");
    expect(contactEmail({ email: 5 })).toBeNull();
    expect(contactEmail(null)).toBeNull();
    expect(contactEmail(["x@y.in"])).toBeNull();
  });
});

describe("plaintext is never logged", () => {
  afterEach(() => vi.restoreAllMocks());

  it("hashing a list writes nothing to the console or the app log", () => {
    const spies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "debug"),
      vi.spyOn(log, "debug"),
      vi.spyOn(log, "info"),
      vi.spyOn(log, "warn"),
      vi.spyOn(log, "error"),
    ];
    const people = [
      { email: "secret.person@example.com", phone: "+91 99999 11111", name: "Secret Person" },
      { email: "bad", phone: "bad", name: "Nobody" },
      { email: null, phone: "0091 88888 22222", name: null },
    ];
    for (const p of people) {
      customerRow(p);
      identityRow(p);
      normalizeEmail(p.email);
      normalizePhone(p.phone);
      normalizeName(p.name);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("the module has no logging call at all", () => {
    const src = readFileSync(path.join(process.cwd(), "src/lib/promote/hashing.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/\bconsole\.|\blog\.(debug|info|warn|error)\(|from "@\/lib\/log"/);
  });
});
