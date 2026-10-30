import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkWebhookHandshake, parseSignedRequest, verifyWebhookSignature } from "@/lib/meta";
import { createState, verifyState } from "@/lib/oauth-state";

const secret = "test-app-secret";
const sig = (body: string, key = secret) => `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("verifyWebhookSignature", () => {
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

  it("accepts a correct signature over the raw body", () => {
    expect(verifyWebhookSignature(body, sig(body), secret)).toBe(true);
  });
  it("rejects a body that was changed after signing", () => {
    expect(verifyWebhookSignature(`${body} `, sig(body), secret)).toBe(false);
  });
  it("rejects a signature made with another secret", () => {
    expect(verifyWebhookSignature(body, sig(body, "other"), secret)).toBe(false);
  });
  it("rejects missing, malformed or wrongly sized headers", () => {
    expect(verifyWebhookSignature(body, null, secret)).toBe(false);
    expect(verifyWebhookSignature(body, "abc", secret)).toBe(false);
    expect(verifyWebhookSignature(body, "sha256=abc", secret)).toBe(false);
  });
  it("rejects everything when no app secret is configured", () => {
    expect(verifyWebhookSignature(body, sig(body), undefined)).toBe(false);
    expect(verifyWebhookSignature(body, sig(body, ""), "")).toBe(false);
  });
});

describe("checkWebhookHandshake", () => {
  const params = (o: Record<string, string>) => new URLSearchParams(o);
  it("returns the challenge for a valid subscribe request", () => {
    const r = checkWebhookHandshake(params({ "hub.mode": "subscribe", "hub.verify_token": "tok", "hub.challenge": "12345" }), "tok");
    expect(r).toEqual({ ok: true, challenge: "12345" });
  });
  it("refuses a wrong token, wrong mode, missing challenge or unset token", () => {
    expect(checkWebhookHandshake(params({ "hub.mode": "subscribe", "hub.verify_token": "bad", "hub.challenge": "1" }), "tok").ok).toBe(false);
    expect(checkWebhookHandshake(params({ "hub.mode": "unsubscribe", "hub.verify_token": "tok", "hub.challenge": "1" }), "tok").ok).toBe(false);
    expect(checkWebhookHandshake(params({ "hub.mode": "subscribe", "hub.verify_token": "tok" }), "tok").ok).toBe(false);
    expect(checkWebhookHandshake(params({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "1" }), "").ok).toBe(false);
  });
});

describe("parseSignedRequest", () => {
  const make = (payload: object, key = secret) => {
    const p = b64url(JSON.stringify(payload));
    return `${b64url(createHmac("sha256", key).update(p).digest())}.${p}`;
  };
  it("returns the payload when the signature is valid", () => {
    expect(parseSignedRequest(make({ user_id: "42", algorithm: "HMAC-SHA256" }), secret)).toMatchObject({ user_id: "42" });
  });
  it("returns null for a forged, malformed or unconfigured request", () => {
    expect(parseSignedRequest(make({ user_id: "42" }, "wrong"), secret)).toBeNull();
    expect(parseSignedRequest("not-a-signed-request", secret)).toBeNull();
    expect(parseSignedRequest("a.b.c", secret)).toBeNull();
    expect(parseSignedRequest(make({ user_id: "42" }), undefined)).toBeNull();
  });
});

describe("oauth state", () => {
  const now = 1_800_000_000_000;
  it("accepts a fresh state signed with the same secret", () => {
    expect(verifyState(createState("s", now), "s", now + 1000)).toBe(true);
  });
  it("rejects tampered, expired, future, wrong-secret and malformed states", () => {
    const state = createState("s", now);
    expect(verifyState(`${state}0`, "s", now + 1000)).toBe(false);
    expect(verifyState(state, "other", now + 1000)).toBe(false);
    expect(verifyState(state, "s", now + 11 * 60_000)).toBe(false);
    expect(verifyState(state, "s", now - 1000)).toBe(false);
    expect(verifyState("a.b", "s", now)).toBe(false);
    expect(verifyState(undefined, "s", now)).toBe(false);
    expect(verifyState(state, undefined, now)).toBe(false);
  });
});
