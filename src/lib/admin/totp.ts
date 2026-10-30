import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const RECOVERY_CODE_COUNT = 8;

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 4226 HOTP over an 8 byte big-endian counter, dynamic truncation. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS, algorithm: "sha1" | "sha256" | "sha512" = "sha1"): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac(algorithm, secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const stepAt = (nowMs: number) => Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);

export function totpAt(secret: Buffer, nowMs: number, digits = TOTP_DIGITS, algorithm: "sha1" | "sha256" | "sha512" = "sha1"): string {
  return hotp(secret, stepAt(nowMs), digits, algorithm);
}

const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Returns the matched time step (current, previous or next) or null.
 * A step at or below `lastUsedStep` is rejected so a code cannot be used twice.
 */
export function verifyTotp(secretBase32: string, code: string, nowMs = Date.now(), lastUsedStep: number | null = null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const now = stepAt(nowMs);
  let matched: number | null = null;
  for (const step of [now - 1, now, now + 1]) {
    const ok = safeEq(hotp(secret, step), code);
    if (ok && matched === null && (lastUsedStep === null || step > lastUsedStep)) matched = step;
  }
  return matched;
}

export function otpauthUri(secretBase32: string, account: string, issuer = "Edwyz WA"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

export const normalizeRecoveryCode = (code: string) => code.replace(/[\s-]/g, "").toLowerCase();
export const hashRecoveryCode = (code: string) => createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");

/** Eight codes like "k3f9a-72xqd". Shown once; only hashes are stored. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): { codes: string[]; hashes: string[] } {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  const pick = (n: number) => Array.from({ length: n }, () => chars[randomInt(chars.length)]).join("");
  const codes = Array.from({ length: count }, () => `${pick(5)}-${pick(5)}`);
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

/** Pure: returns the remaining hashes when the code matches one, otherwise null. */
export function consumeRecoveryHash(hashes: string[], code: string): string[] | null {
  const given = hashRecoveryCode(code);
  const idx = hashes.findIndex((h) => safeEq(h, given));
  return idx < 0 ? null : hashes.filter((_, i) => i !== idx);
}
