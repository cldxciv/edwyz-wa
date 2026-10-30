import { describe, expect, it, vi } from "vitest";
import { assertPublicUrl, isPrivateAddress, parseWebhookUrl } from "@/lib/integrations/ssrf";

const publicResolver = async () => ["93.184.216.34"];

describe("isPrivateAddress", () => {
  it.each([
    "0.0.0.0",
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "169.254.0.1",
    "100.64.0.1",
    "192.0.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "[::1]",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.1.2.3",
    "::ffff:a9fe:a9fe",
    "::ffff:169.254.169.254",
    "0:0:0:0:0:ffff:c0a8:0101",
    "64:ff9b::7f00:1",
    "2002:7f00:1::1",
    "2001:db8::1",
    "not-an-ip",
    "",
  ])("treats %j as private", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "172.15.0.1", "172.32.0.1", "11.0.0.1", "100.63.255.255", "2606:2800:220:1:248:1893:25c8:1946", "::ffff:8.8.8.8", "2001:4860:4860::8888"])("treats %j as public", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe("parseWebhookUrl", () => {
  it.each([
    ["http://example.com/hook", "https"],
    ["ftp://example.com/hook", "https"],
    ["https://example.com:8080/hook", "port"],
    ["https://example.com:80/hook", "port"],
    ["https://example.com:22/hook", "port"],
    ["https://user:pass@example.com/hook", "credentials"],
    ["https://127.0.0.1/hook", "not allowed"],
    ["https://10.0.0.5/hook", "not allowed"],
    ["https://169.254.169.254/latest/meta-data", "not allowed"],
    ["https://[::1]/hook", "not allowed"],
    ["https://[::ffff:127.0.0.1]/hook", "not allowed"],
    ["https://[::ffff:7f00:1]/hook", "not allowed"],
    ["https://localhost/hook", "not allowed"],
    ["https://app.localhost/hook", "not allowed"],
    ["https://metadata.google.internal/computeMetadata", "not allowed"],
    ["https://printer.local/hook", "not allowed"],
    ["https://2130706433/hook", "not allowed"],
    ["https://0x7f.1/hook", "not allowed"],
    ["not a url", "valid URL"],
  ])("rejects %s", (url, message) => {
    expect(() => parseWebhookUrl(url)).toThrow(message);
  });

  it("names what the URL is for in its messages", () => {
    expect(() => parseWebhookUrl("http://example.com/", "Server URLs")).toThrow("Server URLs must use https.");
    expect(() => parseWebhookUrl("https://example.com:8080/", "Server URLs")).toThrow("Server URLs must use port");
    expect(() => parseWebhookUrl("https://u:p@example.com/", "Server URLs")).toThrow("Server URLs cannot contain credentials.");
    expect(() => parseWebhookUrl("http://example.com/")).toThrow("Webhook URLs must use https.");
  });

  it("accepts https on 443 and 8443", () => {
    expect(parseWebhookUrl("https://hooks.example.com/a?b=1").port).toBe(443);
    expect(parseWebhookUrl("https://hooks.example.com:8443/a").port).toBe(8443);
  });
});

describe("assertPublicUrl", () => {
  it("rejects a hostname that resolves to a private address", async () => {
    await expect(assertPublicUrl("https://evil.example.com/hook", async () => ["10.0.0.7"])).rejects.toThrow("private");
    await expect(assertPublicUrl("https://evil.example.com/hook", async () => ["127.0.0.1"])).rejects.toThrow("private");
    await expect(assertPublicUrl("https://evil.example.com/hook", async () => ["::ffff:169.254.169.254"])).rejects.toThrow("private");
  });
  it("rejects when ANY resolved address is private", async () => {
    await expect(assertPublicUrl("https://mixed.example.com/hook", async () => ["93.184.216.34", "192.168.0.9"])).rejects.toThrow("private");
  });
  it("rejects unresolvable hosts and empty answers", async () => {
    await expect(assertPublicUrl("https://nx.example.com/", vi.fn().mockRejectedValue(new Error("ENOTFOUND")))).rejects.toThrow("resolved");
    await expect(assertPublicUrl("https://empty.example.com/", async () => [])).rejects.toThrow("private");
  });
  it("returns the validated addresses for pinning", async () => {
    const result = await assertPublicUrl("https://ok.example.com/hook", publicResolver);
    expect(result.addresses).toEqual(["93.184.216.34"]);
    expect(result.url.pathname).toBe("/hook");
  });
  it("applies the static checks before resolving anything", async () => {
    const resolver = vi.fn();
    await expect(assertPublicUrl("http://example.com/", resolver)).rejects.toThrow("https");
    expect(resolver).not.toHaveBeenCalled();
  });
});
