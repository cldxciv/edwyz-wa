import { describe, expect, it, vi } from "vitest";
import type { PinnedRequest, PinnedResponse } from "@/lib/creative/pinned";
import { verifyShopOwnership } from "@/lib/commerce/admin-verify";

const DOMAIN = "victim.myshopify.com";
const TOKEN = "shpat_0123456789abcdef";
const publicResolve = async () => ["23.227.38.65"];
const json = (body: unknown, status = 200): PinnedResponse => ({ status, contentType: "application/json", location: null, body: JSON.stringify(body) });
const run = (res: PinnedResponse | Error, resolve = publicResolve) => {
  const transport = vi.fn<(req: PinnedRequest) => Promise<PinnedResponse>>(async () => {
    if (res instanceof Error) throw res;
    return res;
  });
  return { transport, done: verifyShopOwnership(DOMAIN, TOKEN, { transport, resolve }) };
};

describe("verifyShopOwnership (P3-10)", () => {
  it("sends the token only to the shop's own host, pinned to the validated address", async () => {
    const { transport, done } = run(json({ shop: { myshopify_domain: DOMAIN } }));
    await expect(done).resolves.toBeUndefined();
    const req = transport.mock.calls[0][0];
    expect(req.url.href).toMatch(/^https:\/\/victim\.myshopify\.com\/admin\/api\/2024-10\/shop\.json$/);
    expect(req.address).toBe("23.227.38.65");
    expect(req.headers).toMatchObject({ "x-shopify-access-token": TOKEN });
    expect(req.url.port).toBe("");
    expect(req).toMatchObject({ timeoutMs: 8000, maxBytes: 64 * 1024 });
  });

  it("compares the domain Shopify reports with the pasted one, ignoring letter case only", async () => {
    await expect(run(json({ shop: { myshopify_domain: "Victim.MyShopify.com" } })).done).resolves.toBeUndefined();
  });

  it("refuses with a plain 422 when Shopify names a different shop", async () => {
    const other = run(json({ shop: { myshopify_domain: "attacker.myshopify.com" } }));
    await expect(other.done).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/different store/i) });
    // a custom domain is not the myshopify domain, so it does not prove the pasted one
    await expect(run(json({ shop: { myshopify_domain: "victim.myshopify.com.evil.com" } })).done).rejects.toMatchObject({ status: 422 });
    await expect(run(json({ shop: { domain: DOMAIN } })).done).rejects.toMatchObject({ status: 422 });
    await expect(run(json({ shop: {} })).done).rejects.toMatchObject({ status: 422 });
    await expect(run({ status: 200, contentType: "text/html", location: null, body: "<html>" }).done).rejects.toMatchObject({ status: 422 });
  });

  it("maps a rejected token, other Shopify statuses, redirects and network trouble to 422 without echoing the token", async () => {
    for (const status of [401, 403]) await expect(run(json({}, status)).done).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/rejected the access token/i) });
    for (const status of [404, 429, 500]) await expect(run(json({}, status)).done).rejects.toMatchObject({ status: 422 });
    const redirect = run({ status: 302, contentType: "", location: "https://evil.example/", body: "" });
    await expect(redirect.done).rejects.toMatchObject({ status: 422 });
    expect(redirect.transport).toHaveBeenCalledTimes(1);
    const failed = run(new Error(`connect failed ${TOKEN}`));
    await expect(failed.done).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/could not reach shopify/i) });
    await failed.done.catch((e: Error) => expect(e.message).not.toContain(TOKEN));
  });

  it("does not connect when the shop name resolves to a private address", async () => {
    const { transport, done } = run(json({ shop: { myshopify_domain: DOMAIN } }), async () => ["127.0.0.1"]);
    await expect(done).rejects.toMatchObject({ status: 422 });
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects tokens that are not plain tokens before any request", async () => {
    const transport = vi.fn();
    for (const bad of ["", "short", "has space in it 123", "x".repeat(300)]) {
      await expect(verifyShopOwnership(DOMAIN, bad, { transport, resolve: publicResolve })).rejects.toMatchObject({ status: 422 });
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses anything but a bare myshopify.com handle before resolving or connecting (SSRF attempts)", async () => {
    const transport = vi.fn();
    const resolve = vi.fn(publicResolve);
    const attempts = [
      "evil.com", "myshopify.com", ".myshopify.com", "victim.myshopify.com.evil.com", "evil.com#.myshopify.com", "evil.com?.myshopify.com",
      "127.0.0.1", "169.254.169.254", "[::1]", "10.0.0.1.myshopify.com.", "0x7f000001", "2130706433",
      "user@victim.myshopify.com", "user:pass@victim.myshopify.com", "victim.myshopify.com@evil.com", "victim.myshopify.com:443", "victim.myshopify.com:8443",
      "victim.myshopify.com/admin", "https://victim.myshopify.com", "a.b.myshopify.com", "-victim.myshopify.com", "victim.myshopify.com\n.evil.com",
      "victim_x.myshopify.com", "VICTIM.myshopify.com", " victim.myshopify.com", `${"a".repeat(62)}.myshopify.com`, "",
    ];
    for (const bad of attempts) {
      await expect(verifyShopOwnership(bad, TOKEN, { transport, resolve })).rejects.toMatchObject({ status: 422 });
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("verifyShopOwnership resilience", () => {
  const ok = json({ shop: { myshopify_domain: DOMAIN } });

  it("tries the IPv4 address first and falls back to the other validated address when the connection fails outright", async () => {
    const calls: string[] = [];
    const transport = vi.fn<(req: PinnedRequest) => Promise<PinnedResponse>>(async (req) => {
      calls.push(req.address);
      if (calls.length === 1) throw new Error("connect failed");
      return ok;
    });
    const resolve = async () => ["2606:4700:4700::1111", "23.227.38.65"];
    await expect(verifyShopOwnership(DOMAIN, TOKEN, { transport, resolve })).resolves.toBeUndefined();
    expect(calls).toEqual(["23.227.38.65", "2606:4700:4700::1111"]);
  });

  it("works when only the IPv6 address connects, and still reads as unreachable when every address fails", async () => {
    const v6only = vi.fn<(req: PinnedRequest) => Promise<PinnedResponse>>(async (req) => {
      if (!req.address.includes(":")) throw new Error("ENETUNREACH");
      return ok;
    });
    await expect(verifyShopOwnership(DOMAIN, TOKEN, { transport: v6only, resolve: async () => ["2606:4700:4700::1111", "23.227.38.65"] })).resolves.toBeUndefined();
    const dead = vi.fn<(req: PinnedRequest) => Promise<PinnedResponse>>(async () => {
      throw new Error("down");
    });
    await expect(verifyShopOwnership(DOMAIN, TOKEN, { transport: dead, resolve: async () => ["23.227.38.65", "23.227.38.66", "23.227.38.67"] })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/could not reach shopify/i) });
    expect(dead).toHaveBeenCalledTimes(2);
  });

  it("never retries an HTTP answer on another address, and never sends the token to an address it did not validate", async () => {
    const transport = vi.fn<(req: PinnedRequest) => Promise<PinnedResponse>>(async () => json({}, 500));
    await expect(verifyShopOwnership(DOMAIN, TOKEN, { transport, resolve: async () => ["23.227.38.65", "23.227.38.66"] })).rejects.toMatchObject({ status: 422 });
    expect(transport).toHaveBeenCalledTimes(1);
    const mixed = vi.fn<(req: PinnedRequest) => Promise<PinnedResponse>>(async () => ok);
    await expect(verifyShopOwnership(DOMAIN, TOKEN, { transport: mixed, resolve: async () => ["23.227.38.65", "10.0.0.5"] })).rejects.toMatchObject({ status: 422 });
    expect(mixed).not.toHaveBeenCalled();
  });

  it("reports an answer cut off at the 64 KB cap as unreachable, not as a domain mismatch", async () => {
    const cut = { status: 200, contentType: "application/json", location: null, body: `{"shop":{"note":"${"x".repeat(64 * 1024)}` };
    await expect(run(cut).done).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/could not reach shopify/i) });
    await expect(run(cut).done).rejects.not.toMatchObject({ message: expect.stringMatching(/different store/i) });
  });

  it("reports an unreadable 200 answer as such, not as a domain mismatch", async () => {
    const html = { status: 200, contentType: "text/html", location: null, body: "<html>maintenance</html>" };
    await expect(run(html).done).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/could not be read/i) });
  });

  it("does not wait on a resolver that never answers: name resolution has its own limit", async () => {
    vi.useFakeTimers();
    try {
      const transport = vi.fn();
      const pending = verifyShopOwnership(DOMAIN, TOKEN, { transport, resolve: () => new Promise<string[]>(() => undefined) }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(3_100);
      await expect(pending).resolves.toMatchObject({ status: 422, message: expect.stringMatching(/could not reach shopify/i) });
      expect(transport).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
