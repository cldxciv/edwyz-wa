import { createHmac, timingSafeEqual } from "node:crypto";

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Verifies the X-Hub-Signature-256 header over the exact raw request body. */
export function verifyWebhookSignature(rawBody: string, header: string | null, appSecret: string | undefined): boolean {
  if (!appSecret || !header || !header.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`;
  return safeEqual(header, expected);
}

export type VerifyResult = { ok: true; challenge: string } | { ok: false };

/** Handles Meta's GET handshake when the webhook URL is saved in the dashboard. */
export function checkWebhookHandshake(params: URLSearchParams, verifyToken: string | undefined): VerifyResult {
  if (!verifyToken || params.get("hub.mode") !== "subscribe") return { ok: false };
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  if (!token || !challenge || !safeEqual(token, verifyToken)) return { ok: false };
  return { ok: true, challenge };
}

const fromBase64Url = (value: string) => Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** Parses and verifies Meta's signed_request (used by the data-deletion callback). Returns null if invalid. */
export function parseSignedRequest(signedRequest: string, appSecret: string | undefined): Record<string, unknown> | null {
  if (!appSecret) return null;
  const [signature, payload, ...rest] = signedRequest.split(".");
  if (!signature || !payload || rest.length > 0) return null;
  const expected = createHmac("sha256", appSecret).update(payload).digest();
  const given = fromBase64Url(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(fromBase64Url(payload).toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const algorithm = (parsed as { algorithm?: unknown }).algorithm;
    if (algorithm !== undefined && String(algorithm).toUpperCase() !== "HMAC-SHA256") return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
