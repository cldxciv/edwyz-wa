import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PrivacyPage, { metadata as privacyMeta } from "@/app/(site)/privacy/page";
import TermsPage, { metadata as termsMeta } from "@/app/(site)/terms/page";
import DeletionPage, { metadata as deletionMeta } from "@/app/(site)/data-deletion/page";
import { COMPANY } from "@/lib/config";
import { LEGAL, PRIVACY_SECTIONS, TERMS_SECTIONS } from "@/lib/legal";
import { RETENTION_DEFAULTS as R } from "@/lib/lifecycle/personal-data";

const render = (page: () => React.ReactElement) => renderToStaticMarkup(createElement(page));

describe("legal constants", () => {
  it("has no empty required values", () => {
    for (const key of ["version", "effectiveDate", "lastUpdated", "jurisdictionCity", "jurisdictionState", "grievanceEmail"] as const) {
      expect(LEGAL[key].trim()).not.toBe("");
    }
    expect(LEGAL.requestResponseDays).toBeGreaterThan(0);
    expect(LEGAL.liabilityCapMonths).toBeGreaterThan(0);
    expect(COMPANY.address).toContain(LEGAL.jurisdictionCity);
  });
});

describe.each([
  ["privacy", PrivacyPage, PRIVACY_SECTIONS, privacyMeta, "/privacy"],
  ["terms", TermsPage, TERMS_SECTIONS, termsMeta, "/terms"],
])("%s page", (_name, page, sections, meta, path) => {
  const html = render(page as () => React.ReactElement);

  it("renders every section heading and a matching table of contents anchor", () => {
    for (const s of sections) {
      expect(html).toContain(`id="${s.id}"`);
      expect(html).toContain(`href="#${s.id}"`);
      expect(html).toContain(`>${s.title}</h2>`);
    }
  });
  it("shows last updated, version, summary box and the not-legal-advice note", () => {
    expect(html).toContain(`Last updated ${LEGAL.lastUpdated}`);
    expect(html).toContain(`Version ${LEGAL.version}`);
    expect(html).toContain("In short");
    expect(html).toContain("not legal advice");
    expect(html).toContain(COMPANY.legalName);
    expect(html).toContain(COMPANY.email);
  });
  it("is indexable with a canonical url and its own share tags", () => {
    expect(meta.robots).toEqual({ index: true, follow: true });
    expect(String(meta.alternates?.canonical)).toMatch(new RegExp(`${path}$`));
    expect((meta.openGraph as { url?: string }).url).toBe(`https://wa.edwyz.com${path}`);
    expect(JSON.stringify(meta.openGraph)).toContain("/og.png");
    expect(html).not.toMatch(/\[\[|TODO|undefined|null</);
  });
});

describe("privacy content", () => {
  const html = render(PrivacyPage);
  it("covers required topics", () => {
    for (const text of ["Razorpay", "Meta", "DPDP", "GDPR", "AES-256-GCM", "TOTP", "grievance", "/api/meta/data-deletion", "/data-deletion/status", "wa_access"]) {
      expect(html.toLowerCase()).toContain(text.toLowerCase());
    }
  });
});

describe("terms content", () => {
  const html = render(TermsPage);
  it("covers required topics", () => {
    for (const text of ["WhatsApp Business Messaging Policy", "Commerce Policy", "INR", "GST", "Razorpay", "opt-in", LEGAL.jurisdictionCity]) {
      expect(html).toContain(text);
    }
  });
});

describe("data deletion page", () => {
  const html = render(DeletionPage);
  it("explains both routes and links to status", () => {
    expect(html).toContain("Remove the app on Facebook");
    expect(html).toContain("Ask by email");
    expect(html).toContain('href="/data-deletion/status"');
    expect(html).toContain("Edwyz API");
    expect(deletionMeta.robots).toEqual({ index: true, follow: true });
  });
});

describe("version 1.2: Eddy and owner spending alerts (docs/EDDY-SPEC.md 7.9, 12.1a decision 7; SPEND 3.5, 7.4)", () => {
  const privacy = render(PrivacyPage);
  const terms = render(TermsPage);
  const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

  it("bumps the version that switching Eddy on records", () => {
    expect(LEGAL.version).toBe("1.2");
    expect(LEGAL.lastUpdated).toBe("29 October 2026");
  });

  it("the privacy page has the Eddy paragraph with its retention, deletion and permission promises", () => {
    const t = text(privacy);
    expect(t).toContain("Eddy, the in-app assistant.");
    expect(t).toContain("The workspace owner turns it on.");
    expect(t).toContain(`We keep Eddy conversations for ${R.eddyHistoryDays} days so people can scroll back, then delete them.`);
    expect(t).toContain("Each person can delete their own Eddy history at any time, and erasing a contact also erases Eddy conversations that included that contact.");
    expect(t).toContain(`a record of the actions they confirmed (including the text of messages they approved) is kept for ${R.actionRecordDays} days`);
    expect(t).toContain("asks for confirmation before it messages customers, spends money or deletes anything");
    expect(t).toContain("Admins of a workspace cannot read their teammates' Eddy conversations");
    expect(privacy).toContain('id="eddy"');
  });

  it("lists every feature that sends text to Anthropic, and says what is logged in the 7.9 words", () => {
    const t = text(privacy);
    for (const feature of ["AI agent (WhatsApp replies).", "Inbox reply suggestions.", "Chatbot escalation check.", "Creative studio"]) expect(t).toContain(feature);
    expect(t).toContain("We do not write the content of prompts or answers to our application logs. Eddy conversations are stored as described below.");
    expect(t).not.toContain("We do not log the content of prompts or answers");
    expect(t).toContain("Anthropic, PBC: AI processing, for workspaces that turn on AI features, including Eddy");
    expect(t).toContain("AI features are off until a customer turns them on.");
  });

  it("publishes only confirmed statements: no training claim, no Anthropic retention period, no transfer basis (legal items 12 and 16)", () => {
    const t = text(privacy).toLowerCase();
    expect(t).not.toMatch(/train(ing)? (its|their) models|not used to train|used for (model )?training/);
    expect(t).not.toMatch(/zero data retention|anthropic keeps .* for \d+ days|retains? .* for \d+ days/);
    expect(t).not.toMatch(/\[confirm/);
    expect(t).not.toMatch(/standard contractual clauses for anthropic|transfer basis/);
  });

  it("names owners' WhatsApp alert numbers as personal data, with their retention", () => {
    const t = text(privacy);
    expect(t).toContain("Spending alert numbers:");
    expect(t).toContain("the record of their consent");
    expect(t).toContain("never the workspace's customer data");
    expect(t).toContain("Spending alert numbers stay while the person is a member of the workspace and are removed when they leave or the workspace is erased");
  });

  it("the terms have the Eddy bullet", () => {
    expect(text(terms)).toContain("Eddy. Eddy acts on your instructions and your confirmations. Check each preview before you confirm; you are responsible for messages and changes you approve. Eddy's answers may be inaccurate.");
  });
});
