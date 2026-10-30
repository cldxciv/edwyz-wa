import { createHmac, timingSafeEqual } from "node:crypto";

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;

/** Returns the lowercase myshopify.com domain, or null when the input is not a plain shop domain. */
export function normalizeShopDomain(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase();
  return SHOP_DOMAIN.test(value) ? value : null;
}

/** Shopify signs the raw body with HMAC-SHA256 and sends the base64 digest. */
export function verifyShopifyHmac(rawBody: string, header: string | null, secret: string | null | undefined): boolean {
  if (!header || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const given = Buffer.from(header.trim(), "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
