import { HttpError } from "@/lib/tenancy";

const HEX = /^[0-9a-f]+$/i;

/** A deployment problem, never the caller's: public routes answer 404 and log a fixed line instead of showing this message. */
export class MediaSecretError extends HttpError {
  constructor(message: string) {
    super(503, message);
    this.name = "MediaSecretError";
  }
}

/** 32 random bytes is 64 hex characters or about 43 base64 characters; repeated or tiny alphabets are refused. */
export function hasEnoughEntropy(value: string): boolean {
  const min = HEX.test(value) ? 64 : 43;
  return value.length >= min && new Set(value).size >= 10;
}

/**
 * Signing key for public media links. Production requires the dedicated variable (no fallback to STATE_SECRET, which roots other key
 * material). Development and tests may fall back to STATE_SECRET. Whatever is used must carry at least 32 bytes of entropy.
 */
export function mediaSigningSecret(envName: "CREATIVE_MEDIA_SECRET" | "CONTENT_MEDIA_SECRET"): string {
  const dedicated = process.env[envName];
  const production = process.env.NODE_ENV === "production";
  const value = dedicated || (production ? "" : process.env.STATE_SECRET || "");
  if (!value) throw new MediaSecretError(`${envName} is not configured. Set it to 32 random bytes, for example the output of: openssl rand -hex 32`);
  if (!hasEnoughEntropy(value)) throw new MediaSecretError(`${envName} is too weak. Use at least 32 random bytes, for example the output of: openssl rand -hex 32`);
  return value;
}
