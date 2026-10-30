import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, consumeRecoveryHash, generateRecoveryCodes, generateSecret, hashRecoveryCode, hotp, otpauthUri, stepAt, verifyTotp } from "@/lib/admin/totp";

const sha1Secret = Buffer.from("12345678901234567890", "ascii");
const sha256Secret = Buffer.from("12345678901234567890123456789012", "ascii");
const sha512Secret = Buffer.from("1234567890123456789012345678901234567890123456789012345678901234", "ascii");

const vectors: [number, string, string, string][] = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

describe("RFC 6238 appendix B", () => {
  it.each(vectors)("time %i", (t, sha1, sha256, sha512) => {
    const step = Math.floor(t / 30);
    expect(hotp(sha1Secret, step, 8, "sha1")).toBe(sha1);
    expect(hotp(sha256Secret, step, 8, "sha256")).toBe(sha256);
    expect(hotp(sha512Secret, step, 8, "sha512")).toBe(sha512);
  });
});

describe("verifyTotp", () => {
  const secret = base32Encode(sha1Secret);
  const now = 1111111109 * 1000;
  const code = hotp(sha1Secret, stepAt(now));

  it("round trips base32", () => {
    expect(base32Decode(secret).equals(sha1Secret)).toBe(true);
    expect(base32Decode(generateSecret())).toHaveLength(20);
  });
  it("accepts current, previous and next step, rejects others", () => {
    expect(verifyTotp(secret, code, now)).toBe(stepAt(now));
    expect(verifyTotp(secret, hotp(sha1Secret, stepAt(now) - 1), now)).toBe(stepAt(now) - 1);
    expect(verifyTotp(secret, hotp(sha1Secret, stepAt(now) + 1), now)).toBe(stepAt(now) + 1);
    expect(verifyTotp(secret, hotp(sha1Secret, stepAt(now) - 2), now)).toBeNull();
    expect(verifyTotp(secret, "12345", now)).toBeNull();
    expect(verifyTotp(secret, "abcdef", now)).toBeNull();
  });
  it("rejects reuse of the same or an older step", () => {
    const step = verifyTotp(secret, code, now)!;
    expect(verifyTotp(secret, code, now, step)).toBeNull();
    expect(verifyTotp(secret, hotp(sha1Secret, step - 1), now, step)).toBeNull();
    expect(verifyTotp(secret, hotp(sha1Secret, step + 1), now, step)).toBe(step + 1);
  });
  it("builds an otpauth uri", () => {
    expect(otpauthUri(secret, "a@b.com")).toMatch(/^otpauth:\/\/totp\/Edwyz%20WA%3Aa%40b\.com\?secret=.+&issuer=Edwyz%20WA/);
  });
});

describe("recovery codes", () => {
  it("makes 8 distinct codes with hashes only for storage", () => {
    const { codes, hashes } = generateRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    expect(hashes).toEqual(codes.map(hashRecoveryCode));
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
  });
  it("is single use and tolerant of case and dashes", () => {
    const { codes, hashes } = generateRecoveryCodes();
    const left = consumeRecoveryHash(hashes, codes[0].toUpperCase())!;
    expect(left).toHaveLength(7);
    expect(consumeRecoveryHash(left, codes[0])).toBeNull();
    expect(consumeRecoveryHash(left, codes[1].replace("-", ""))).toHaveLength(6);
    expect(consumeRecoveryHash(hashes, "nope-nope1")).toBeNull();
  });
});
