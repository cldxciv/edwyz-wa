import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PinnedRequest, PinnedResponse } from "@/lib/creative/pinned";
import { fetchSiteText, htmlToText, parseRobots, robotsAllows, sameHostLinks } from "@/lib/creative/site";

const publicResolve = async () => ["93.184.216.34"];
const reply = (body: string, contentType: string, status = 200, location: string | null = null): PinnedResponse => ({ status, contentType, location, body });
const html = (body: string) => reply(body, "text/html");
const transport = vi.fn<(req: PinnedRequest) => Promise<PinnedResponse>>();
const fetchSpy = vi.fn();

beforeEach(() => {
  transport.mockReset();
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});

describe("robots", () => {
  it("honours disallow, allow overrides and our own group", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: EdwyzBot\nDisallow: /nope");
    expect(robotsAllows(rules, "/nope/x")).toBe(false);
    expect(robotsAllows(rules, "/private")).toBe(true);
    const star = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/ok");
    expect(robotsAllows(star, "/private/a")).toBe(false);
    expect(robotsAllows(star, "/private/ok")).toBe(true);
    expect(robotsAllows(parseRobots("User-agent: *\nDisallow: /"), "/")).toBe(false);
  });
});

describe("html helpers", () => {
  it("strips scripts and tags", () => {
    expect(htmlToText("<p>Hi &amp; bye</p><script>evil()</script><style>x{}</style>")).toBe("Hi & bye");
  });
  it("keeps only same-host https links, max 3, no files", () => {
    const page = `<a href="/about">a</a><a href="https://other.com/x">o</a><a href="/a.pdf">p</a><a href="/services">s</a><a href="/x1">1</a><a href="/x2">2</a><a href="/pricing#t">3</a><a href="http://shop.example.com/h">h</a>`;
    const links = sameHostLinks(page, new URL("https://shop.example.com/"));
    expect(links).toHaveLength(3);
    expect(links.every((l) => l.startsWith("https://shop.example.com/") && !l.endsWith(".pdf"))).toBe(true);
  });
});

describe("fetchSiteText", () => {
  it("fetches robots, the page and same-host links, skipping disallowed ones", async () => {
    transport.mockImplementation(async ({ url }) => {
      if (url.pathname === "/robots.txt") return reply("User-agent: *\nDisallow: /secret", "text/plain");
      if (url.pathname === "/") return html('<h1>Home</h1><a href="/about">A</a><a href="/secret">S</a><a href="/services">V</a>');
      return html("<p>sub page</p>");
    });
    const out = await fetchSiteText("https://site.example.com/", publicResolve, transport);
    expect(out.pages.map((p) => p.url).sort()).toEqual(["https://site.example.com/", "https://site.example.com/about", "https://site.example.com/services"]);
    expect(out.skipped).toContain("https://site.example.com/secret");
  });

  it("connects only to the address that was validated, and never uses the global fetch (DNS rebinding)", async () => {
    let lookups = 0;
    const rebinding = async () => (lookups++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"]);
    transport.mockResolvedValue(reply("", "text/plain", 404));
    await fetchSiteText("https://site.example.com/", rebinding, transport);
    expect(transport).toHaveBeenCalled();
    for (const [req] of transport.mock.calls) expect(req.address).toBe("93.184.216.34");
    expect(req0(transport).userAgent).toContain("EdwyzBot");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not fetch the page when robots disallows it", async () => {
    transport.mockResolvedValue(reply("User-agent: *\nDisallow: /", "text/plain"));
    const out = await fetchSiteText("https://site.example.com/", publicResolve, transport);
    expect(out.pages).toEqual([]);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("refuses private addresses without any request", async () => {
    const out = await fetchSiteText("https://internal.example.com/", async () => ["10.0.0.5"], transport);
    expect(out.pages).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });

  it("re-validates redirects and never contacts a private hop", async () => {
    const resolve = async (h: string) => (h === "evil.example.com" ? ["169.254.169.254"] : ["93.184.216.34"]);
    transport.mockImplementation(async ({ url }) => {
      if (url.pathname === "/robots.txt") return reply("", "text/plain", 404);
      return reply("", "text/html", 302, "https://evil.example.com/meta");
    });
    const out = await fetchSiteText("https://site.example.com/", resolve, transport);
    expect(out.pages).toEqual([]);
    expect(transport.mock.calls.some(([r]) => r.url.hostname === "evil.example.com")).toBe(false);
  });

  it("shares one time budget across all hops, so a slow server cannot hold the read open for minutes", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const timeouts: number[] = [];
    transport.mockImplementation(async ({ url, timeoutMs }) => {
      timeouts.push(timeoutMs);
      now += 12_000;
      if (url.pathname === "/robots.txt") return reply("", "text/plain", 404);
      return html('<a href="/about">a</a><a href="/services">s</a><a href="/pricing">p</a>');
    });
    try {
      await fetchSiteText("https://site.example.com/", publicResolve, transport);
    } finally {
      clock.mockRestore();
    }
    expect(timeouts.every((t) => t <= 10_000)).toBe(true);
    expect(timeouts[2]).toBeLessThan(10_000);
    expect(timeouts.length).toBeLessThan(5);
  });

  it("asks the transport for at most 300 KB", async () => {
    transport.mockImplementation(async ({ url, maxBytes }) => (url.pathname === "/robots.txt" ? reply("", "text/plain", 404) : html("<p>" + "a".repeat(maxBytes) + "</p>")));
    const out = await fetchSiteText("https://site.example.com/", publicResolve, transport);
    expect(transport.mock.calls.every(([r]) => r.maxBytes === 300 * 1024)).toBe(true);
    expect(out.pages.length).toBe(1);
  });
});

function req0(t: typeof transport): PinnedRequest {
  return t.mock.calls[0][0];
}
