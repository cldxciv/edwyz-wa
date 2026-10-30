import { describe, expect, it } from "vitest";
import { MAX_PASSWORD_LENGTH as SERVER_MAX, MIN_PASSWORD_LENGTH as SERVER_MIN } from "@/lib/auth/password";
import { COMPANY } from "@/lib/config";
import {
  COMING_SOON,
  DEVELOPER_POINTS,
  EDDY_EXAMPLES,
  EDDY_POINTS,
  FAQS,
  FEATURE_GROUPS,
  HIGHLIGHTS,
  NAV_LINKS,
  SECTION,
  SECURITY_FACTS,
  SPEND_POINTS,
  SPEND_PREVIEW,
  STATUS_LABEL,
  STEPS,
} from "@/components/site/content";
import {
  type PublicPlan,
  aiCreditsText,
  aiFairUseNote,
  chooseBilling,
  comparisonRows,
  formatPrice,
  hasBothIntervals,
  limitText,
  offersFor,
  planLimitLines,
  plansFor,
  publicPlans,
  taxNote,
} from "@/components/site/pricing";
import {
  HOME_DESCRIPTION,
  HOME_TITLE,
  SITEMAP_ENTRIES,
  TAGLINE,
  faqLd,
  organizationLd,
  pageMetadata,
  serializeJsonLd,
  sitemapEntries,
  softwareApplicationLd,
} from "@/components/site/seo";
import sitemap from "@/app/sitemap";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  passwordStrength,
  validateCurrentPassword,
  validateEmail,
  validateName,
  validateNewPassword,
  validateWorkspace,
} from "@/components/site/validate";

const plan = (over: Partial<PublicPlan> = {}): PublicPlan => ({
  id: "p1",
  code: "starter",
  name: "Starter",
  description: null,
  pricePaise: 99900,
  currency: "INR",
  intervalMonths: 1,
  seatLimit: 3,
  contactLimit: 1000,
  monthlyBroadcastLimit: null,
  aiCreditsMonthly: 500,
  adAccountLimit: 1,
  ...over,
});

describe("form validation", () => {
  it("keeps the client limits equal to the server limits", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(SERVER_MIN);
    expect(MAX_PASSWORD_LENGTH).toBe(SERVER_MAX);
  });

  it("validates emails with specific messages", () => {
    expect(validateEmail("")).toMatch(/Enter your email/);
    expect(validateEmail("nope")).toMatch(/valid email/);
    expect(validateEmail("a@b")).toMatch(/valid email/);
    expect(validateEmail("  owner@shop.in ")).toBe("");
  });

  it("validates names, workspace and passwords", () => {
    expect(validateName("  ")).not.toBe("");
    expect(validateName("Asha")).toBe("");
    expect(validateName("x".repeat(101))).not.toBe("");
    expect(validateWorkspace("")).not.toBe("");
    expect(validateWorkspace("Hill Stays")).toBe("");
    expect(validateCurrentPassword("")).not.toBe("");
    expect(validateCurrentPassword("a")).toBe("");
    expect(validateNewPassword("")).not.toBe("");
    expect(validateNewPassword("short")).toContain("Add 5 more");
    expect(validateNewPassword("a".repeat(10))).toBe("");
    expect(validateNewPassword("a".repeat(MAX_PASSWORD_LENGTH + 1))).not.toBe("");
  });
});

describe("password strength hint", () => {
  it("asks for more characters below the minimum", () => {
    const s = passwordStrength("abc");
    expect(s.score).toBe(0);
    expect(s.label).toBe("Too short");
    expect(s.hint).toContain("7 more characters");
    expect(passwordStrength("a".repeat(9)).hint).toContain("1 more character.");
  });

  it("is empty-friendly", () => {
    expect(passwordStrength("")).toMatchObject({ score: 0, label: "" });
  });

  it("flags common words, repeats and personal details", () => {
    expect(passwordStrength("password12345").label).toBe("Weak");
    expect(passwordStrength("aaaaaaaaaaaa").label).toBe("Weak");
    expect(passwordStrength("ashasharma99", ["asha"]).label).toBe("Weak");
  });

  it("rewards length and variety", () => {
    expect(passwordStrength("tulipvalley").score).toBe(1);
    expect(passwordStrength("tulipvalleysky").score).toBeGreaterThanOrEqual(2);
    expect(passwordStrength("Tulip valley sky 42!").score).toBe(4);
  });
});

describe("pricing helpers", () => {
  it("shows the toggle only when both monthly and yearly plans exist", () => {
    const monthly = plan();
    const yearly = plan({ id: "p2", intervalMonths: 12 });
    expect(hasBothIntervals([monthly])).toBe(false);
    expect(chooseBilling([monthly], "yearly")).toBeNull();
    expect(chooseBilling([yearly], undefined)).toBeNull();
    expect(chooseBilling([monthly, yearly], undefined)).toBe("monthly");
    expect(chooseBilling([monthly, yearly], "yearly")).toBe("yearly");
    expect(chooseBilling([monthly, yearly], "garbage")).toBe("monthly");
  });

  it("filters by the chosen period and lists everything without a toggle", () => {
    const all = [plan(), plan({ id: "p2", intervalMonths: 12 }), plan({ id: "p3", intervalMonths: 3 })];
    expect(plansFor(all, "yearly").map((p) => p.id)).toEqual(["p2"]);
    expect(plansFor(all, "monthly").map((p) => p.id)).toEqual(["p1"]);
    expect(plansFor(all, null)).toHaveLength(3);
  });

  it("formats prices from paise without inventing amounts", () => {
    expect(formatPrice(plan({ pricePaise: 99900 }))).toEqual({ amount: "Rs 999", per: "month" });
    expect(formatPrice(plan({ pricePaise: 150050, intervalMonths: 12 }))).toEqual({ amount: "Rs 1,500.50", per: "year" });
    expect(formatPrice(plan({ currency: "USD", pricePaise: 1000 })).amount).toBe("USD 10");
  });

  it("builds the comparison table from plan fields, with null meaning no limit", () => {
    const rows = comparisonRows([plan(), plan({ id: "p2", seatLimit: null, adAccountLimit: 5 })]);
    expect(rows.map((r) => r.label)).toEqual([
      "Team seats",
      "Contacts",
      "Broadcast messages per month",
      "AI credits per month",
    ]);
    expect(rows[0].values).toEqual(["3", "No fixed limit"]);
    expect(rows[2].values).toEqual(["No fixed limit", "No fixed limit"]);
    expect(rows).toHaveLength(4);
    expect(limitText(12000)).toBe("12,000");
  });

  it("words plan limits in plain language", () => {
    expect(planLimitLines(plan({ adAccountLimit: 1, seatLimit: 1, aiCreditsMonthly: null }))).toEqual([
      "1 team seat",
      "1,000 contacts",
      "No fixed limit on broadcast messages",
      "Fair-use limit on AI credits",
    ]);
  });

  it("never calls a null AI credit allowance unlimited", () => {
    expect(aiCreditsText(null)).toBe("Fair-use limit");
    expect(aiCreditsText(null, { aiDefaultCredits: 200 })).toBe("200 (fair-use limit)");
    expect(aiCreditsText(0, { aiDefaultCredits: 200 })).toBe("0");
    expect(aiCreditsText(1500, { aiDefaultCredits: 200 })).toBe("1,500");
    expect(planLimitLines(plan({ aiCreditsMonthly: null }), { aiDefaultCredits: 200 })[3]).toBe("200 AI credits a month (fair-use limit)");
    expect(planLimitLines(plan({ aiCreditsMonthly: null }), { aiDefaultCredits: 1 })[3]).toBe("1 AI credit a month (fair-use limit)");
    for (const opts of [{}, { aiDefaultCredits: 200 }]) {
      expect(planLimitLines(plan({ aiCreditsMonthly: null, seatLimit: null, contactLimit: null, monthlyBroadcastLimit: null, adAccountLimit: null }), opts).join(" ")).not.toMatch(/unlimited/i);
    }
  });

  it("explains the AI fair-use limit only when a plan relies on it", () => {
    expect(aiFairUseNote([plan({ aiCreditsMonthly: 500 }), plan({ aiCreditsMonthly: 0 })])).toBeNull();
    expect(aiFairUseNote([plan({ aiCreditsMonthly: null })])).toMatch(/fair-use limit\.$/);
    expect(aiFairUseNote([plan({ aiCreditsMonthly: 5 }), plan({ aiCreditsMonthly: null })], { aiDefaultCredits: 200 })).toContain("of 200 AI credits a month");
  });

  it("keeps the trial allowance off the public list", () => {
    expect(publicPlans([{ code: "trial" }, { code: "starter" }]).map((p) => p.code)).toEqual(["starter"]);
  });

  it("renders every comparison cell correctly for nulls, zeros and set limits together", () => {
    const plans = [
      plan({ id: "a", seatLimit: 0, contactLimit: 0, monthlyBroadcastLimit: 0, aiCreditsMonthly: 0, adAccountLimit: 0 }),
      plan({ id: "b", seatLimit: null, contactLimit: null, monthlyBroadcastLimit: null, aiCreditsMonthly: null, adAccountLimit: null }),
      plan({ id: "c", seatLimit: 1, contactLimit: 1234567, monthlyBroadcastLimit: 50, aiCreditsMonthly: 2500, adAccountLimit: 10 }),
    ];
    const rows = comparisonRows(plans, { aiDefaultCredits: 200 });
    expect(rows.map((r) => [r.key, r.values])).toEqual([
      ["seats", ["0", "No fixed limit", "1"]],
      ["contacts", ["0", "No fixed limit", "12,34,567"]],
      ["broadcasts", ["0", "No fixed limit", "50"]],
      ["ai", ["0", "200 (fair-use limit)", "2,500"]],
    ]);
    expect(planLimitLines(plans[0])).toEqual(["0 team seats", "0 contacts", "0 broadcast messages a month", "0 AI credits a month"]);
    expect(rows.every((r) => r.values.length === plans.length)).toBe(true);
  });

  it("writes the tax note from platform settings", () => {
    const withGstin = taxNote({ gstRateBps: 1800, sellerGstin: "22AAAAA0000A1Z5" }, [plan()]);
    expect(withGstin.main).toBe("Prices are in Indian rupees (INR) and include GST at 18 percent.");
    expect(withGstin.proforma).toBeNull();
    const without = taxNote({ gstRateBps: 1250, sellerGstin: " " }, [plan()]);
    expect(without.main).toContain("12.5 percent");
    expect(without.proforma).toMatch(/proforma/);
    expect(taxNote({ gstRateBps: 1800, sellerGstin: "x" }, [plan({ currency: "USD" })]).main).not.toContain("rupees");
  });

  it("passes real prices to structured data", () => {
    expect(offersFor([plan()])).toEqual([{ name: "Starter", pricePaise: 99900, currency: "INR" }]);
  });
});

describe("metadata and structured data", () => {
  it("builds canonical, Open Graph and Twitter tags with a preview image", () => {
    const m = pageMetadata({ title: "Pricing", description: "Plans.", path: "/pricing" });
    expect(m.alternates?.canonical).toBe("https://wa.edwyz.com/pricing");
    expect(m.title).toBe("Pricing");
    expect(m.openGraph).toMatchObject({
      url: "https://wa.edwyz.com/pricing",
      title: "Pricing | Edwyz WA",
      siteName: "Edwyz WA",
      images: [{ url: "https://wa.edwyz.com/og.png", width: 1200, height: 630 }],
    });
    expect(m.twitter).toMatchObject({ card: "summary_large_image", title: "Pricing | Edwyz WA", images: ["https://wa.edwyz.com/og.png"] });
    expect(m.robots).toEqual({ index: true, follow: true });
  });

  it("supports absolute titles and noindex", () => {
    const m = pageMetadata({ title: HOME_TITLE, description: HOME_DESCRIPTION, path: "", absoluteTitle: true });
    expect(m.title).toEqual({ absolute: HOME_TITLE });
    expect(m.alternates?.canonical).toBe("https://wa.edwyz.com");
    expect(pageMetadata({ title: "x", description: "y", path: "/z", noindex: true }).robots).toEqual({ index: false, follow: false });
  });

  it("keeps titles and descriptions a sensible length", () => {
    expect(HOME_TITLE.length).toBeLessThanOrEqual(75);
    expect(HOME_DESCRIPTION.length).toBeLessThanOrEqual(165);
  });

  it("lists the public pages in the sitemap and none of the private ones", () => {
    const urls = sitemap().map((e) => e.url);
    for (const p of ["", "/pricing", "/signup", "/docs", "/login", "/privacy", "/terms", "/data-deletion"]) {
      expect(urls).toContain(`https://wa.edwyz.com${p}`);
    }
    expect(urls.some((u) => /\/(api|app|admin|oauth|webhooks|approve|reset-password|verify-email|accept-invite)/.test(u))).toBe(false);
    expect(sitemapEntries()).toHaveLength(SITEMAP_ENTRIES.length);
  });

  it("describes the organisation and the software without ratings", () => {
    const org = organizationLd();
    expect(org["@type"]).toBe("Organization");
    expect(org.name).toBe(COMPANY.legalName);
    const app = softwareApplicationLd();
    expect(app["@type"]).toBe("SoftwareApplication");
    expect(JSON.stringify(app)).not.toMatch(/aggregateRating|ratingValue|reviewCount|"review"/);
    expect(app).not.toHaveProperty("offers");
    const priced = softwareApplicationLd(offersFor([plan()])) as { offers: { price: string; priceCurrency: string }[] };
    expect(priced.offers[0]).toMatchObject({ price: "999.00", priceCurrency: "INR" });
  });

  it("builds FAQ structured data from the visible questions and escapes script-breaking text", () => {
    const ld = faqLd(FAQS);
    expect(ld.mainEntity).toHaveLength(FAQS.length);
    const out = serializeJsonLd({ t: "</script><script>alert(1)</script>" });
    expect(out).not.toContain("</script>");
    expect(JSON.parse(out).t).toBe("</script><script>alert(1)</script>");
  });
});

describe("landing content", () => {
  const all = [HIGHLIGHTS, STEPS, FEATURE_GROUPS, EDDY_POINTS, EDDY_EXAMPLES, SPEND_POINTS, SPEND_PREVIEW, COMING_SOON, DEVELOPER_POINTS, SECURITY_FACTS, FAQS];
  const text = JSON.stringify(all);
  /** What the page presents as working today. Coming soon items are deliberately left out. */
  const live = JSON.stringify([HIGHLIGHTS, STEPS, FEATURE_GROUPS, EDDY_POINTS, EDDY_EXAMPLES, DEVELOPER_POINTS, SECURITY_FACTS]);
  const featureTitles = FEATURE_GROUPS.flatMap((g) => g.features.map((f) => f.title));

  it("groups live features by outcome", () => {
    expect(FEATURE_GROUPS.map((g) => g.outcome)).toEqual(["Talk to customers", "Automate the busy work", "Run your team and see results"]);
    for (const g of FEATURE_GROUPS) expect(g.features.length).toBeGreaterThanOrEqual(4);
    expect(new Set(featureTitles).size).toBe(featureTitles.length);
  });

  it("explains how it works in three steps: connect, team, automate", () => {
    expect(STEPS.map((s) => s.title)).toEqual(["Connect your number", "Bring your team", "Automate the routine"]);
    expect(STEPS[0].body).toContain("Meta's own sign-up window");
    expect(STEPS[0].body).toContain("about 5 minutes");
  });

  it("covers every live feature the owner listed", () => {
    for (const t of [
      "Shared team inbox",
      "Message templates",
      "Broadcasts with clear results",
      "Contacts and segments",
      "Automation rules",
      "Chatbots with a visual builder",
      "AI agent that knows your business",
      "Shopify abandoned-cart recovery",
      "Roles and teams",
      "Reports",
      "API, webhooks and MCP",
    ]) {
      expect(featureTitles).toContain(t);
    }
    const inbox = FEATURE_GROUPS[0].features[0].body;
    for (const word of ["Assign", "private notes", "quick replies", "many chats at once"]) expect(inbox).toContain(word);
  });

  it("keeps ads and the Android app out of everything presented as live", () => {
    expect(live).not.toMatch(/instagram|facebook page|boost|lead form|click-to-whatsapp|android|google play|ad campaign/i);
    expect(COMING_SOON.map((c) => c.title)).toEqual(["Boost a reel or post", "Lead forms", "Click-to-WhatsApp from Instagram", "Android app on Google Play"]);
  });

  it("describes the product in the title and description without claiming ads", () => {
    for (const s of [HOME_TITLE, HOME_DESCRIPTION, TAGLINE]) expect(s).not.toMatch(/\bads?\b|instagram|facebook/i);
  });

  it("labels statuses in words", () => {
    expect(STATUS_LABEL).toEqual({ new: "New", soon: "Coming soon" });
  });

  it("gives Eddy a Hinglish and an English example that ask before sending", () => {
    expect(EDDY_EXAMPLES.map((e) => [e.label, e.lang])).toEqual([
      ["Hinglish", "hi-Latn"],
      ["English", "en"],
    ]);
    for (const e of EDDY_EXAMPLES) expect(e.turns[0].from).toBe("you");
    const card = EDDY_EXAMPLES[1].turns.find((t) => t.card)?.card;
    expect(card?.actions).toEqual(["Send", "Edit", "Cancel"]);
    expect(card?.note).toBe("Nothing is sent until you tap Send.");
    expect(EDDY_EXAMPLES[0].turns.some((t) => t.undo)).toBe(true);
    expect(JSON.stringify(EDDY_POINTS)).toContain("English, Hindi or Hinglish");
  });

  it("explains the spending controls without amounts", () => {
    expect(SPEND_POINTS.map((p) => p.title)).toEqual([
      "Monthly and daily limits",
      "Approvals for bigger steps",
      "Automatic safety stops",
      "One button to stop everything",
      "Your money stays with you",
      "Everyone can see the limits",
    ]);
    expect(SPEND_POINTS[0].body).toMatch(/ads, WhatsApp messages and AI/);
    for (const p of SPEND_PREVIEW) {
      expect(p.percent).toBeGreaterThanOrEqual(0);
      expect(p.percent).toBeLessThanOrEqual(100);
    }
  });

  it("asks and answers six to eight real questions", () => {
    expect(FAQS.length).toBeGreaterThanOrEqual(6);
    expect(FAQS.length).toBeLessThanOrEqual(8);
    const qs = FAQS.map((f) => f.q.toLowerCase()).join("|");
    for (const topic of ["pricing", "free trial", "whatsapp cost", "get started", "languages", "permission", "countries", "delete my data"]) expect(qs).toContain(topic);
    const meta = FAQS.find((f) => f.q.toLowerCase().includes("whatsapp cost"));
    expect(meta?.a).toMatch(/You pay Meta directly/);
    const languages = FAQS.find((f) => f.q.toLowerCase().includes("languages"));
    expect(languages?.a).toMatch(/English, Hindi and Hinglish/);
  });

  it("makes no certification claims, names no competitors and quotes no prices", () => {
    expect(text).not.toMatch(/SOC ?2|ISO ?27001|HIPAA|PCI|GDPR[- ]compliant|certified|guarantee/i);
    expect(text).not.toMatch(/wati|interakt|twilio|gupshup|respond\.io|zoko|aisensy/i);
    expect(text).not.toMatch(/Rs ?\d|₹|\$\d/);
  });

  it("invents no testimonials, partnerships, ratings, awards or user counts", () => {
    expect(text).not.toMatch(/testimonial|trusted by|award|partner|tech provider|\bBSP\b|rated \d|\d ?stars?\b|\b[\d,]+\+/i);
  });

  it("names each in-page section once, and the navigation points at real sections", () => {
    const ids = Object.values(SECTION);
    expect(new Set(ids).size).toBe(ids.length);
    for (const l of NAV_LINKS) {
      const hash = l.href.split("#")[1];
      if (hash) expect(ids).toContain(hash);
    }
  });

  it("has the requested navigation", () => {
    expect(NAV_LINKS.map((l) => l.href)).toEqual(["/#features", "/pricing", "/docs"]);
  });
});
