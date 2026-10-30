import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DecidedNotice, DecisionForm, Intro, InvalidLink, SummaryCard } from "@/components/approvals/ApprovalPage";
import { decidedCopy, noticeCopy, plainKind, plainRow, plainRows, plainTitle, reviewIntro } from "@/components/approvals/present";

const html = (node: React.ReactNode) => renderToStaticMarkup(node as React.ReactElement);

describe("approval page wording", () => {
  it("names what is being reviewed in the heading", () => {
    expect(reviewIntro("Ad creative").title).toBe("Please review this ad");
    expect(reviewIntro("Social post").title).toBe("Please review this post");
    expect(reviewIntro("Something new").title).toBe("Please review this");
  });

  it("replaces internal labels and codes in the facts list", () => {
    expect(plainRow({ label: "Format", value: "image" })).toEqual({ label: "Type", value: "Picture" });
    expect(plainRow({ label: "Format", value: "copy" })).toEqual({ label: "Type", value: "Ad text" });
    expect(plainRow({ label: "Placement", value: "story" })).toEqual({ label: "Where it will show", value: "Story" });
    expect(plainRow({ label: "Placement", value: "new_surface" })).toEqual({ label: "Where it will show", value: "New surface" });
    expect(plainRow({ label: "Goal", value: "leads" })).toEqual({ label: "Goal", value: "Get enquiries" });
    expect(plainRow({ label: "Objective", value: "OUTCOME_LEADS" })).toEqual({ label: "Goal", value: "Leads" });
    expect(plainRow({ label: "Attachments", value: "2" })).toEqual({ label: "Pictures or videos", value: "2" });
    expect(plainRow({ label: "Daily budget", value: "Rs 500" })).toEqual({ label: "Daily budget", value: "Rs 500" });
    expect(plainRows([{ label: "Format", value: "image" }])).toHaveLength(1);
  });

  it("answers every decision with a calm confirmation", () => {
    for (const d of ["approved", "changes_requested", "rejected", "revoked", "something_else"]) {
      const c = decidedCopy(d);
      expect(c.title.length).toBeGreaterThan(5);
      expect(`${c.label} ${c.title} ${c.text}`).not.toMatch(/_|!/);
    }
    expect(decidedCopy("approved").tone).toBe("good");
    expect(decidedCopy("rejected").label).toBe("Declined");
  });
});

describe("approval page markup", () => {
  it("offers big Approve and Request changes choices with no login", () => {
    const out = html(DecisionForm({ token: "tok123", nonce: "n-1" }));
    expect(out).toContain("Approve");
    expect(out).toContain("Request changes");
    expect(out).toContain('action="/api/approvals/tok123/decide"');
    expect(out).toMatch(/<button[^>]*value="approved"[^>]*name="decision"|<button[^>]*name="decision"[^>]*value="approved"/);
    expect(out).toMatch(/<button[^>]*value="changes_requested"[^>]*name="decision"|<button[^>]*name="decision"[^>]*value="changes_requested"/);
    expect(out.match(/name="nonce" value="n-1"/g)).toHaveLength(2);
    expect(out).toContain("min-h-14");
    expect(out).not.toMatch(/<script/i);
  });

  it("requires a comment for changes but lets declining skip the form check", () => {
    const out = html(DecisionForm({ token: "t", nonce: "n" }));
    expect(out).toMatch(/<textarea[^>]*name="comment"[^>]*required/);
    expect(out).toMatch(/<button[^>]*formNoValidate[^>]*value="rejected"|<button[^>]*value="rejected"[^>]*formNoValidate/i);
    expect(out).toContain('maxLength="1000"');
  });

  it("keeps the request changes form out of the approve form so Approve never needs a comment", () => {
    const out = html(DecisionForm({ token: "t", nonce: "n" }));
    const approve = out.slice(0, out.indexOf("<details"));
    expect(approve).not.toContain("<textarea");
  });

  it("encodes the token in the form address", () => {
    expect(html(DecisionForm({ token: "a/b c", nonce: "n" }))).toContain('action="/api/approvals/a%2Fb%20c/decide"');
  });

  it("shows plain facts and escapes hostile text", () => {
    const out = html(
      SummaryCard({
        summary: { kindLabel: "Ad creative", title: "<b>Sale</b>", text: "<script>x()</script>", rows: [{ label: "Placement", value: "feed" }, { label: "Format", value: "image" }], imageUrl: "https://cdn.example.com/a.png" },
      }),
    );
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<b>Sale");
    expect(out).toContain("&lt;b&gt;Sale");
    expect(out).toContain("Feed post");
    expect(out).toContain("Picture");
    expect(out).not.toMatch(/>image<|>feed</);
    expect(out).toContain('src="https://cdn.example.com/a.png"');
    expect(out).toContain("Preview of");
  });

  it("has exactly one h1 in each state", () => {
    const summary = { kindLabel: "Ad creative", title: "T", rows: [] };
    const pending = html([Intro({ kindLabel: "Ad creative" }), SummaryCard({ summary }), DecisionForm({ token: "t", nonce: "n" })]);
    expect(pending.match(/<h1/g)).toHaveLength(1);
    const decided = html([DecidedNotice({ decision: "approved" }), SummaryCard({ summary })]);
    expect(decided.match(/<h1/g)).toHaveLength(1);
    expect(html(InvalidLink()).match(/<h1/g)).toHaveLength(1);
  });

  it("shows no ids or raw codes on the decided screen", () => {
    const out = html(DecidedNotice({ decision: "changes_requested" }));
    expect(out).toContain("Changes requested");
    expect(out).not.toContain("changes_requested");
  });
});

describe("approval page after a failed decision", () => {
  it("explains each way a decision can fail in plain words", () => {
    for (const code of ["expired", "retry", "busy", "comment"]) {
      const n = noticeCopy(code);
      expect(n, code).not.toBeNull();
      expect(`${n!.title} ${n!.text}`).not.toMatch(/_|!|nonce|token|error|[45]\d\d/i);
    }
    expect(noticeCopy("expired")?.text).toContain("tap the button again");
    expect(noticeCopy("unknown")).toBeNull();
    expect(noticeCopy(null)).toBeNull();
  });

  it("shows the notice as an alert above the buttons and opens the changes form for a missing comment", () => {
    const plain = html(DecisionForm({ token: "t", nonce: "n" }));
    expect(plain).not.toContain('role="alert"');
    const out = html(DecisionForm({ token: "t", nonce: "n", notice: "expired" }));
    expect(out).toContain('role="alert"');
    expect(out.indexOf('role="alert"')).toBeLessThan(out.indexOf('value="approved"'));
    expect(out).not.toMatch(/<details[^>]* open/);
    expect(html(DecisionForm({ token: "t", nonce: "n", notice: "comment" }))).toMatch(/<details[^>]* open/);
  });

  it("tells the client what to do when nothing seems to happen", () => {
    expect(html(DecisionForm({ token: "t", nonce: "n" }))).toContain("reload this page and tap again");
  });

  it("asks before declining and keeps the 16 px comment box", () => {
    const out = html(DecisionForm({ token: "t", nonce: "n" }));
    expect(out).toContain("Yes, decline this");
    expect(out).toContain("cannot undo");
    expect(out.indexOf("Not right at all? Decline this")).toBeLessThan(out.indexOf('value="rejected"'));
    expect(out).toMatch(/<textarea[^>]*class="[^"]*text-base!/);
    expect(out).not.toMatch(/value="rejected"[^>]*class="[^"]*(text-sm|text-base)/);
  });
});

describe("approval page wording for an offer", () => {
  it("does not call an offer a brief", () => {
    expect(reviewIntro("Creative brief").title).toBe("Please review this offer");
    expect(plainKind("Creative brief")).toBe("Offer and goal");
    expect(plainTitle("Creative brief", "Creative brief")).not.toMatch(/brief/i);
    expect(plainTitle("Ad creative", "Spring sale")).toBe("Spring sale");
    const out = html(SummaryCard({ summary: { kindLabel: "Creative brief", title: "Creative brief", rows: [{ label: "Goal", value: "leads" }], text: "Free class" } }));
    expect(out).not.toMatch(/brief/i);
  });
});
