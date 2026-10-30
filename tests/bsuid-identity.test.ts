import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countProbeCases } from "./helpers/bsuid-cases";
import {
  avatarHint,
  displayName,
  displaySubtitle,
  hasPhone,
  identitySearchFilter,
  normalizeBsuid,
  normalizeIdentity,
  normalizeUsername,
  phoneFromWaId,
  recipientAddress,
  shortBsuid,
  templateBlockedFor,
} from "@/lib/contacts/identity";
import { countryOfBsuid, countryOfPhone, countryProbe } from "@/lib/broadcasts/country";
import { initials } from "@/components/inbox/ux";

const BSUID = "US.13491208655302741918";

describe("BSUID migration and schema", () => {
  const sql = readFileSync(join(__dirname, "..", "prisma", "migrations", "0007_bsuid", "migration.sql"), "utf8");
  const schema = readFileSync(join(__dirname, "..", "prisma", "schema.prisma"), "utf8");

  it("only drops the NOT NULL on Contact.phone and leaves the unique indexes alone", () => {
    const statements = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--") && l.trim())
      .join(" ")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toEqual(['ALTER TABLE "Contact" ALTER COLUMN "phone" DROP NOT NULL']);
    expect(statements.join(" ")).not.toMatch(/DROP\s+INDEX|UNIQUE/i);
  });

  it("keeps both unique keys in the Prisma schema and makes phone optional", () => {
    const model = schema.slice(schema.indexOf("model Contact {"), schema.indexOf("model Conversation {"));
    expect(model).toMatch(/phone\s+String\?/);
    expect(model).toContain("@@unique([tenantId, phone])");
    expect(model).toContain("@@unique([tenantId, bsuid])");
  });
});

describe("normalizing identifiers", () => {
  it("accepts a BSUID with a country prefix and rejects anything else", () => {
    expect(normalizeBsuid(` ${BSUID} `)).toBe(BSUID);
    expect(normalizeBsuid("IN.abc123")).toBe("IN.abc123");
    for (const bad of ["", "+919876543210", "919876543210", "US.", "USA.123", "US.12 34", 42, null, `US.${"1".repeat(200)}`]) expect(normalizeBsuid(bad)).toBeNull();
  });

  it("strips the @ from usernames and rejects spaces", () => {
    expect(normalizeUsername("@asha.bakes")).toBe("asha.bakes");
    expect(normalizeUsername("asha")).toBe("asha");
    expect(normalizeUsername("two words")).toBeNull();
    expect(normalizeUsername("")).toBeNull();
  });

  it("reads a wa_id as a phone number", () => {
    expect(phoneFromWaId("919876543210")).toBe("+919876543210");
    expect(phoneFromWaId("+919876543210")).toBe("+919876543210");
    expect(phoneFromWaId("123")).toBeNull();
    expect(phoneFromWaId(BSUID)).toBeNull();
  });

  it("sorts what a webhook carries: phone only, both, or BSUID only", () => {
    expect(normalizeIdentity({ from: "919876543210" })).toEqual({ phone: "+919876543210", bsuid: null, username: null, waId: "919876543210" });
    expect(normalizeIdentity({ from: "919876543210", bsuid: BSUID, username: "@asha" })).toEqual({ phone: "+919876543210", bsuid: BSUID, username: "asha", waId: "919876543210" });
    expect(normalizeIdentity({ bsuid: BSUID })).toEqual({ phone: null, bsuid: BSUID, username: null, waId: null });
  });

  it("is tolerant: a BSUID placed in the old from or wa_id field is still read as a BSUID", () => {
    expect(normalizeIdentity({ from: BSUID })).toMatchObject({ phone: null, bsuid: BSUID });
    expect(normalizeIdentity({ waId: BSUID, from: "919876543210" })).toMatchObject({ phone: "+919876543210", bsuid: BSUID });
    expect(normalizeIdentity({})).toEqual({ phone: null, bsuid: null, username: null, waId: null });
  });
});

describe("display helpers", () => {
  it("names a contact by name, then username, then phone, then a short BSUID", () => {
    expect(displayName({ name: "Asha", username: "asha", phone: "+91987", bsuid: BSUID })).toBe("Asha");
    expect(displayName({ name: " ", username: "asha", phone: "+91987", bsuid: BSUID })).toBe("@asha");
    expect(displayName({ username: "@asha" })).toBe("@asha");
    expect(displayName({ phone: "+919876543210", bsuid: BSUID })).toBe("+919876543210");
    expect(displayName({ bsuid: BSUID })).toBe("US....741918");
    expect(displayName({})).toBe("Unknown contact");
  });

  it("shortens a long BSUID but leaves a short one alone", () => {
    expect(shortBsuid(BSUID)).toBe("US....741918");
    expect(shortBsuid("IN.abc")).toBe("IN.abc");
  });

  it("shows the next most useful identifier under the title", () => {
    expect(displaySubtitle({ name: "Asha", phone: "+91987", username: "asha" })).toBe("+91987");
    expect(displaySubtitle({ name: "Asha", username: "asha", bsuid: BSUID })).toBe("@asha");
    expect(displaySubtitle({ username: "asha", bsuid: BSUID })).toBe("US....741918");
    expect(displaySubtitle({ phone: "+91987" })).toBe("");
  });

  it("picks avatar initials from a username when there is no name or phone", () => {
    expect(avatarHint({ username: "zed" })).toBe("@zed");
    expect(initials(null, avatarHint({ username: "zed" }))).toBe("Z");
    expect(initials(null, avatarHint({ phone: "+919876543210" }))).toBe("10");
    expect(initials("Asha Rao", avatarHint({}))).toBe("AR");
  });
});

describe("addressing", () => {
  it("addresses by phone when one is stored, else by BSUID, else nobody", () => {
    expect(recipientAddress({ phone: "+919876543210", bsuid: BSUID })).toEqual({ phone: "+919876543210" });
    expect(recipientAddress({ phone: null, bsuid: BSUID })).toEqual({ bsuid: BSUID });
    expect(recipientAddress({ phone: "", bsuid: BSUID })).toEqual({ bsuid: BSUID });
    expect(recipientAddress({ phone: null, bsuid: null })).toBeNull();
    expect(hasPhone({ phone: null })).toBe(false);
    expect(hasPhone({ phone: "+91987" })).toBe(true);
  });

  it("blocks login-code (authentication) templates for a contact without a phone, and only those", () => {
    expect(templateBlockedFor("AUTHENTICATION", { phone: null, bsuid: BSUID })).toMatch(/phone number/);
    expect(templateBlockedFor("authentication", { phone: null, bsuid: BSUID })).toMatch(/phone number/);
    expect(templateBlockedFor("AUTHENTICATION", { phone: "+91987", bsuid: BSUID })).toBeNull();
    expect(templateBlockedFor("MARKETING", { phone: null, bsuid: BSUID })).toBeNull();
    expect(templateBlockedFor("UTILITY", { phone: null, bsuid: BSUID })).toBeNull();
    expect(templateBlockedFor(undefined, { phone: null, bsuid: BSUID })).toBeNull();
    expect(templateBlockedFor("UTILITY", { phone: null, bsuid: null })).toMatch(/cannot be messaged/);
  });
});

describe("search", () => {
  it("matches name, phone digits, username and BSUID", () => {
    expect(identitySearchFilter("  @asha  ")).toEqual([
      { name: { contains: "@asha", mode: "insensitive" } },
      { username: { contains: "asha", mode: "insensitive" } },
      { bsuid: { contains: "@asha", mode: "insensitive" } },
    ]);
    const withDigits = identitySearchFilter("+91 98765");
    expect(withDigits).toContainEqual({ phone: { contains: "+9198765" } });
    expect(identitySearchFilter("   ")).toEqual([]);
  });
});

describe("country of a contact with no phone", () => {
  it("reads the country from the BSUID prefix", () => {
    expect(countryOfBsuid("IN.123")).toBe("IN");
    expect(countryOfBsuid("us.123")).toBe("US");
    expect(countryOfBsuid("123")).toBeNull();
    for (const c of countProbeCases) expect(countryOfPhone(countryProbe(c.contact))).toBe(c.country);
  });
});
