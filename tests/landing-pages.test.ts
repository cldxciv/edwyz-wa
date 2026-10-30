import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listActivePlans = vi.fn();
const getSettings = vi.fn();

vi.mock("@/lib/billing/service", () => ({ listActivePlans: () => listActivePlans() }));
vi.mock("@/lib/platform-settings", () => ({ getSettings: () => getSettings() }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
// The auth pages look for a live session; tests/auth-signed-in-notice.test.ts covers what they show when there is one.
vi.mock("@/lib/auth/signed-in", () => ({ signedInUser: async () => null }));

import Home, { metadata as homeMeta } from "@/app/(site)/page";
import NotFound, { metadata as notFoundMeta } from "@/app/not-found";
import PricingPage from "@/app/(site)/pricing/page";
import LoginPage from "@/app/(auth)/login/page";
import SignupPage from "@/app/(auth)/signup/page";
import { metadata as forgotMeta } from "@/app/(auth)/forgot-password/page";
import ResetPasswordPage from "@/app/(auth)/reset-password/page";
import AuthLayout from "@/app/(auth)/layout";
import { Footer, Header } from "@/components/shell";
import { COMPANY } from "@/lib/config";
import { COMING_SOON, FAQS, SECTION } from "@/components/site/content";
import { HOME_DESCRIPTION, HOME_TITLE } from "@/components/site/seo";
import type { PublicPlan } from "@/components/site/pricing";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

const plan = (over: Partial<PublicPlan> = {}): PublicPlan => ({
  id: "p1",
  code: "starter",
  name: "Starter",
  description: "For one business",
  pricePaise: 99900,
  currency: "INR",
  intervalMonths: 1,
  seatLimit: 3,
  contactLimit: 1000,
  monthlyBroadcastLimit: 5000,
  aiCreditsMonthly: null,
  adAccountLimit: 1,
  ...over,
});

beforeEach(() => {
  listActivePlans.mockReset();
  getSettings.mockReset();
  getSettings.mockResolvedValue({ trialDays: 7, graceDays: 3, gstRateBps: 1800, sellerGstin: "" });
});

describe("landing page", () => {
  const out = html(createElement(Home));
  /** One top-level section of the page by its id (sections are never nested). */
  const section = (id: string) => out.match(new RegExp(`<section[^>]*id="${id}"[^]*?</section>`))?.[0] ?? "";
  /** Visible text: no scripts, no tags, entities that matter here decoded. */
  const visible = (s: string) =>
    s
      .replace(/<script[^]*?<\/script>/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ");
  const text = visible(out);
  const ids = new Set([...out.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

  it("has one h1 with the headline, and both calls to action", () => {
    expect(out.match(/<h1/g)).toHaveLength(1);
    expect(out).toMatch(/<h1[^>]*>Run customer chats on WhatsApp as a team, and automate the rest<\/h1>/);
    const signups = [...out.matchAll(/<a[^>]+href="\/signup"[^>]*>([^]*?)<\/a>/g)].map((m) => visible(m[1]).trim());
    expect(signups.length).toBeGreaterThanOrEqual(2);
    for (const label of signups) expect(label).toBe("Start free trial");
    expect(out).toMatch(/<a[^>]+href="#how-it-works"[^>]*>See how it works/);
  });

  it("has every section, each labelled by its own heading", () => {
    for (const id of Object.values(SECTION)) {
      const s = section(id);
      expect(s, id).not.toBe("");
      const labelledBy = s.match(/aria-labelledby="([^"]+)"/)?.[1];
      expect(labelledBy && ids.has(labelledBy), id).toBe(true);
    }
    expect(out.match(/<main/g)).toHaveLength(1);
  });

  it("resolves every in-page link, including the ones in the header and footer", () => {
    const hashes = [...out.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    const shell = html(createElement(Header)) + html(createElement(Footer));
    const fromShell = [...shell.matchAll(/href="\/#([^"]+)"/g)].map((m) => m[1]);
    expect(hashes.length + fromShell.length).toBeGreaterThan(0);
    for (const id of [...hashes, ...fromShell]) expect(ids.has(id), `#${id}`).toBe(true);
  });

  it("marks Eddy and spending limits as New, and says who switches Eddy on", () => {
    expect(section(SECTION.eddy)).toMatch(/>New</);
    expect(visible(section(SECTION.eddy))).toContain("The workspace owner switches Eddy on.");
    expect(section(SECTION.spending)).toMatch(/>New</);
    expect(visible(section(SECTION.spending))).toContain("You stay in control of spending");
  });

  it("keeps ads and the Android app inside the Coming soon section, with no way to start them", () => {
    const soon = section(SECTION.comingSoon);
    const soonText = visible(soon);
    expect(soonText).toContain("Coming soon");
    expect(soonText).toContain("not available yet");
    for (const t of ["Boost a reel or post", "Lead forms", "Click-to-WhatsApp from Instagram", "Android app on Google Play"]) expect(soonText).toContain(t);
    // Every card in it carries the label, and nothing in it links anywhere.
    expect(soon.match(/>Coming soon</g)?.length).toBe(COMING_SOON.length + 1);
    expect(soon).not.toMatch(/<a\s/);
    const rest = visible(out.replace(soon, ""));
    expect(rest).not.toMatch(/Coming soon|Instagram|boost|lead form|Click-to-WhatsApp|Android|Google Play/i);
  });

  it("labels the Eddy conversations as examples, in Hinglish and English", () => {
    const eddy = section(SECTION.eddy);
    expect(visible(eddy)).toContain("Example conversations. Illustrations only: names and numbers are made up.");
    expect(eddy).toContain('lang="hi-Latn"');
    expect(eddy).toContain('aria-label="Example in Hinglish"');
    expect(eddy).toContain('aria-label="Example in English"');
    expect(visible(eddy)).toContain("Nothing is sent until you tap Send.");
  });

  it("invents no social proof, partnership, award or price", () => {
    expect(text).not.toMatch(/testimonial|trusted by|award|\b\d+(\.\d+)?\s*(\/\s*5|out of 5|stars?)\b|\b[\d,]+\+?\s+(businesses|companies|customers|users|teams)\b/i);
    expect(text).not.toMatch(/Meta (Business )?Partner|Tech Provider|\bBSP\b|official partner|endorsed/i);
    expect(text).not.toMatch(/Rs ?\d|₹|\$\d/);
    expect(out).not.toMatch(/<img/);
    expect(out).toContain("<svg");
  });

  it("shows a real first API request against this site", () => {
    expect(section(SECTION.developers)).toContain("https://wa.edwyz.com/api/ext/v3/contacts?page_size=5");
    expect(section(SECTION.developers)).toMatch(/<pre[^>]+tabindex="0"[^>]+role="region"[^>]+aria-label="Example API request"/i);
    for (const href of ["/docs", "/docs/webhooks"]) expect(section(SECTION.developers)).toContain(`href="${href}"`);
  });

  it("keeps the links to the legal pages and pricing", () => {
    for (const href of ["/privacy", "/terms", "/data-deletion", "/pricing"]) expect(out).toContain(`href="${href}"`);
  });

  it("renders the FAQ as native disclosure elements", () => {
    const details = out.match(/<details/g)?.length ?? 0;
    expect(details).toBeGreaterThanOrEqual(6);
    expect(details).toBeLessThanOrEqual(8);
    expect(out.match(/<summary/g)?.length).toBe(details);
  });

  it("embeds Organization, SoftwareApplication and FAQ structured data", () => {
    const blocks = [...out.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    expect(blocks.map((b) => b["@type"])).toEqual(["Organization", "SoftwareApplication", "FAQPage"]);
    expect(blocks[2].mainEntity).toHaveLength(FAQS.length);
    expect(JSON.stringify(blocks)).not.toMatch(/aggregateRating|ratingValue|reviewCount/);
  });

  it("exports metadata with a canonical link", () => {
    expect(homeMeta.title).toEqual({ absolute: HOME_TITLE });
    expect(homeMeta.description).toBe(HOME_DESCRIPTION);
    expect(homeMeta.alternates?.canonical).toBe("https://wa.edwyz.com");
    expect(homeMeta.openGraph).toBeDefined();
    expect(homeMeta.twitter).toBeDefined();
  });
});

describe("not found page", () => {
  const out = html(createElement(NotFound));

  it("keeps the site shell and offers a way back in plain words", () => {
    expect(out).toContain("<header");
    expect(out).toContain("<footer");
    expect(out.match(/<h1/g)).toHaveLength(1);
    expect(out).toMatch(/<h1[^>]*>We could not find that page|<h1[^>]*>We cannot find that page/);
    const main = out.match(/<main[^]*?<\/main>/)?.[0] ?? "";
    // A way home and a way in, inside the page itself (the header and footer add Pricing and Docs).
    expect(main).toMatch(/<a[^>]+href="\/"[^>]*>/);
    expect(main).toMatch(/<a[^>]+href="\/login"[^>]*>Sign in</);
    for (const href of ["/pricing", "/docs"]) expect(out).toContain(`href="${href}"`);
    expect(notFoundMeta.title).toBe("Page not found");
    expect(notFoundMeta.robots).toEqual({ index: false, follow: false });
  });

  it("stays generic so it can also hide the admin console", () => {
    expect(out).not.toMatch(/platform admin|tenants|audit log|two-step|authenticator|enrol|admin/i);
  });
});

describe("header and footer", () => {
  it("links the main pages and shows the company details", () => {
    const head = html(createElement(Header));
    for (const href of ["/#features", "/pricing", "/docs", "/login", "/signup"]) expect(head).toContain(`href="${href}"`);
    expect(head).toContain('aria-label="Open menu"');
    const foot = html(createElement(Footer));
    for (const href of ["/privacy", "/terms", "/data-deletion"]) expect(foot).toContain(`href="${href}"`);
    expect(foot).toContain(COMPANY.legalName);
    expect(foot).toContain(COMPANY.address);
    expect(foot).toContain(COMPANY.email);
    expect(foot).toMatch(/not affiliated with or endorsed by Meta or WhatsApp/);
  });
});

describe("pricing page", () => {
  const render = async (billing?: string) =>
    html(await PricingPage({ searchParams: Promise.resolve({ billing }) }));

  it("says prices are not published when there are no plans", async () => {
    listActivePlans.mockResolvedValue([]);
    const out = await render();
    expect(out).toContain("Prices not published yet, contact us");
    expect(out).toContain(COMPANY.email);
    expect(out).not.toContain("<table");
    expect(out).not.toContain("Billing period");
  });

  it("treats a database failure like no plans", async () => {
    listActivePlans.mockRejectedValue(new Error("db down"));
    expect(await render()).toContain("Prices not published yet");
  });

  it("shows plans, the comparison table and the tax note, without a toggle for one period", async () => {
    listActivePlans.mockResolvedValue([plan(), plan({ id: "p2", name: "Growth", pricePaise: 249900, seatLimit: null })]);
    const out = await render();
    expect(out).toContain("Rs 999");
    expect(out).toContain("Rs 2,499");
    expect(out).toContain("<table");
    for (const label of ["Team seats", "Contacts", "Broadcast messages per month", "AI credits per month"]) expect(out).toContain(label);
    expect(out).toContain("No fixed limit on team seats");
    // adAccountLimit is set on the sample plan but nothing enforces it, so the public page must not advertise it.
    expect(out).not.toMatch(/connected ad accounts|\d ad accounts?|limit on ad accounts/i);
    expect(out).not.toMatch(/unlimited (team|contacts|broadcast|ad)/i);
    expect(out).not.toMatch(/Unlimited AI/i);
    expect(out).toContain("No fixed limit");
    expect(out).toContain("include GST at 18 percent");
    expect(out).toMatch(/proforma/);
    expect(out).toContain("7-day free trial");
    expect(out).not.toContain("Billing period");
  });

  it("says fair-use, not unlimited, for a plan with no AI credit allowance, and explains it", async () => {
    delete process.env.AI_DEFAULT_MONTHLY_CREDITS;
    listActivePlans.mockResolvedValue([plan({ aiCreditsMonthly: null }), plan({ id: "p2", name: "Pro", aiCreditsMonthly: 5000 })]);
    const out = await render();
    // The platform default is 1,500 credits a month (EDDY-SPEC 12.1a decision 2; it was 200 before Eddy).
    expect(out).toContain("1,500 AI credits a month (fair-use limit)");
    expect(out).toContain("1,500 (fair-use limit)");
    expect(out).toContain("5,000 AI credits a month");
    expect(out).toContain("AI replies are never unlimited");
    expect(out).not.toMatch(/Unlimited AI/i);
    process.env.AI_DEFAULT_MONTHLY_CREDITS = "75";
    try {
      expect(await render()).toContain("75 AI credits a month (fair-use limit)");
    } finally {
      delete process.env.AI_DEFAULT_MONTHLY_CREDITS;
    }
  });

  it("omits the AI footnote when every plan sets its own allowance, and shows zeros as zeros", async () => {
    listActivePlans.mockResolvedValue([plan({ aiCreditsMonthly: 0, seatLimit: 0 })]);
    const out = await render();
    expect(out).not.toContain("AI replies are never unlimited");
    expect(out).toContain("0 AI credits a month");
    expect(out).toContain("0 team seats");
    expect(out).toMatch(/<td[^>]*>0<\/td>/);
  });

  it("does not list the trial allowance as a plan", async () => {
    listActivePlans.mockResolvedValue([plan({ id: "t", code: "trial", name: "Free trial", pricePaise: 0 }), plan()]);
    const out = await render();
    expect(out).not.toContain("Free trial");
    expect(out).toContain("Starter");
  });

  it("offers the monthly and yearly toggle only when both exist", async () => {
    listActivePlans.mockResolvedValue([plan(), plan({ id: "p2", name: "Starter yearly", intervalMonths: 12, pricePaise: 999900 })]);
    const monthly = await render();
    expect(monthly).toContain('aria-label="Billing period"');
    expect(monthly).toContain("Rs 999</span>");
    expect(monthly).not.toContain("Starter yearly");
    const yearly = await render("yearly");
    expect(yearly).toContain("Starter yearly");
    expect(yearly).toContain("per year");
  });
});

describe("auth pages", () => {
  const login = async () => html(await LoginPage({ searchParams: Promise.resolve({}) }));

  it("uses correct autocomplete attributes", async () => {
    const l = await login();
    expect(l).toContain('autoComplete="username"');
    expect(l).toContain('autoComplete="current-password"');
    const s = html(await SignupPage());
    for (const ac of ["name", "email", "organization", "new-password"]) expect(s).toContain(`autoComplete="${ac}"`);
    const r = html(await ResetPasswordPage({ searchParams: Promise.resolve({ token: "abc" }) }));
    expect(r).toContain('autoComplete="new-password"');
  });

  it("signup keeps the Terms and Privacy line and shows a password hint and toggle", async () => {
    const s = html(await SignupPage());
    expect(s).toMatch(/href="\/terms"[^>]*>Terms of Service/);
    expect(s).toMatch(/href="\/privacy"[^>]*>Privacy Policy/);
    expect(s).toContain("Use at least 10 characters");
    expect(s).toContain('aria-label="Show password"');
    expect(s).toContain("noValidate");
  });

  it("login links to password reset and signup", async () => {
    const l = await login();
    expect(l).toContain('href="/forgot-password"');
    expect(l).toContain('href="/signup"');
  });

  it("asks for a full reset link when the token is missing", async () => {
    const r = html(await ResetPasswordPage({ searchParams: Promise.resolve({}) }));
    expect(r).toContain("incomplete");
    expect(r).not.toContain("<form");
  });

  it("noindexes pages that carry tokens or no search value", () => {
    expect(forgotMeta.robots).toEqual({ index: false, follow: false });
  });

  it("wraps every auth page in the split layout with a benefits panel and trust line", () => {
    const out = html(createElement(AuthLayout, null, createElement("p", null, "child")));
    expect(out).toContain("child");
    expect(out).toContain('aria-label="Why Edwyz WA"');
    expect(out).toContain("official WhatsApp Business Platform");
    expect(out.match(/<main/g)).toHaveLength(1);
  });
});
