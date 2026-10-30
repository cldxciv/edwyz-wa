import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("@/lib/db", () => ({
  prisma: {
    accessToken: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        rows.push({ id: `t${rows.length}`, ...data });
        return { id: `t${rows.length - 1}` };
      }),
      findFirst: vi.fn(async () => rows[rows.length - 1] ?? null),
    },
  },
}));

import { decrypt, encrypt, getAccessToken, storeAccessToken } from "@/lib/crypto/tokens";

const key = randomBytes(32);

beforeEach(() => {
  rows.length = 0;
  process.env.ENCRYPTION_KEY = key.toString("base64");
});

describe("token crypto", () => {
  it("round trips and uses a fresh 12 byte iv each time", () => {
    const a = encrypt("secret-token", key);
    const b = encrypt("secret-token", key);
    expect(Buffer.from(a.iv, "base64")).toHaveLength(12);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toContain("secret");
    expect(decrypt(a, key)).toBe("secret-token");
    expect(a.keyVersion).toBe(1);
  });

  it("fails on tampered ciphertext or auth tag", () => {
    const a = encrypt("abc", key);
    const flipped = Buffer.from(a.ciphertext, "base64");
    flipped[0] ^= 1;
    expect(() => decrypt({ ...a, ciphertext: flipped.toString("base64") }, key)).toThrow();
    expect(() => decrypt({ ...a, authTag: randomBytes(16).toString("base64") }, key)).toThrow();
  });

  it("fails with the wrong key", () => {
    expect(() => decrypt(encrypt("abc", key), randomBytes(32))).toThrow();
  });

  it("fails loudly when the key is missing or the wrong length", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encrypt("x")).toThrow(/ENCRYPTION_KEY/);
    process.env.ENCRYPTION_KEY = randomBytes(16).toString("base64");
    expect(() => encrypt("x")).toThrow(/32 bytes/);
  });

  it("stores encrypted and reads back through getAccessToken", async () => {
    await storeAccessToken("tenant1", null, "EAAB-token");
    expect(JSON.stringify(rows)).not.toContain("EAAB-token");
    await expect(getAccessToken("tenant1")).resolves.toBe("EAAB-token");
  });

  it("throws a clear 409 that routes can show as-is when no token exists", async () => {
    await expect(getAccessToken("tenant1")).rejects.toThrow(/WhatsApp is not connected/);
    await expect(getAccessToken("tenant1")).rejects.toMatchObject({ status: 409 });
  });
});

describe("F20 AES-GCM hardening", () => {
  it("binds access tokens to the tenant id and rejects a row moved to another tenant", async () => {
    await storeAccessToken("tenant1", null, "EAAB-token");
    expect(rows[0].keyVersion).toBe(2);
    await expect(getAccessToken("tenant1")).resolves.toBe("EAAB-token");
    const stolen = { ...rows[0] };
    rows.length = 0;
    rows.push(stolen);
    await expect(getAccessToken("tenant2")).rejects.toThrow(/Could not decrypt/);
  });

  it("still decrypts legacy keyVersion 1 values written without AAD", () => {
    const legacy = encrypt("old", key);
    expect(legacy.keyVersion).toBe(1);
    expect(decrypt(legacy, key, "ignored")).toBe("old");
  });

  it("requires the AAD for version 2 values and rejects wrong or truncated tags", () => {
    const v2 = encrypt("secret", key, "tenantA");
    expect(v2.keyVersion).toBe(2);
    expect(decrypt(v2, key, "tenantA")).toBe("secret");
    expect(() => decrypt(v2, key)).toThrow();
    expect(() => decrypt(v2, key, "tenantB")).toThrow();
    const short = Buffer.from(v2.authTag, "base64").subarray(0, 4).toString("base64");
    expect(() => decrypt({ ...v2, authTag: short }, key, "tenantA")).toThrow();
  });
});
