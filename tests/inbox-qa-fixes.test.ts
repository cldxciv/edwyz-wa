import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { phoneProblem } from "@/components/inbox/NewChatDialog";
import { SidePanel } from "@/components/inbox/SidePanel";
import { noPlanNote } from "@/components/reports/UsageMeter";
import { MIN_TEXT_SEARCH, shortSearchHint } from "@/lib/inbox/search";

/** Fixes from the live QA pass of the home and inbox pages (2026-10-30). */

describe("inbox search: a query too short to search message text says so", () => {
  it("names the three character rule while one or two characters are typed, and nothing otherwise", () => {
    expect(MIN_TEXT_SEARCH).toBe(3);
    expect(shortSearchHint("hi")).toBe("Names and numbers match now. Type at least 3 characters to search messages too.");
    expect(shortSearchHint(" h ")).not.toBeNull();
    expect(shortSearchHint("")).toBeNull();
    expect(shortSearchHint("   ")).toBeNull();
    expect(shortSearchHint("edw")).toBeNull();
  });
});

describe("New chat: the WhatsApp number is checked by the server's rule", () => {
  it("flags letters and too-short numbers, and accepts numbers with or without the country code", () => {
    expect(phoneProblem("12ab")).toBe("Enter a number with country code, like +91 98765 43210.");
    expect(phoneProblem("12")).not.toBeNull();
    expect(phoneProblem("+91 98765 43210")).toBeNull();
    expect(phoneProblem("98765 43210")).toBeNull();
    // An empty field is "required", said on send; it is not a format problem.
    expect(phoneProblem("")).toBeNull();
  });
});

describe("Contact panel", () => {
  const conversation = {
    id: "cv1",
    status: "open",
    assignedToId: null,
    tags: [],
    lastInboundAt: null,
    lastMessageAt: null,
    contact: { id: "c1", name: "Asha", phone: "+919876543210", attributes: {}, optIn: false, optedOutAt: null },
  } as unknown as Parameters<typeof SidePanel>[0]["conversation"];
  const render = (canBlock?: boolean) =>
    renderToStaticMarkup(createElement(SidePanel, { conversation, members: [], canBlock, onClose: () => undefined, onChanged: () => undefined }));

  it("keeps Add (tags) disabled until a tag is typed, like Save and Add note", () => {
    const html = render();
    const add = html.match(/<button[^>]*>Add<\/button>/)?.[0] ?? "";
    expect(add).toContain("disabled");
  });

  it("offers Blocked to owners and admins only, as the chat header does", () => {
    expect(render(true)).toContain('<option value="blocked">Blocked</option>');
    expect(render(false)).not.toContain('value="blocked"');
  });
});

describe("Plan usage on the dashboard without a plan", () => {
  it("says no plan is chosen yet, with the trial days left, never that the plan has no limit", () => {
    expect(noPlanNote({ state: "trialing", trialDaysLeft: 4 })).toBe("You are on the free trial, with 4 days left. You have not chosen a plan yet, so no plan limits apply.");
    expect(noPlanNote({ state: "trialing", trialDaysLeft: 1 })).toContain("with 1 day left");
    expect(noPlanNote({ state: "active", trialDaysLeft: null })).toBe("You have not chosen a plan yet, so no plan limits apply.");
    expect(noPlanNote(undefined)).toBe("You have not chosen a plan yet, so no plan limits apply.");
    expect(noPlanNote({ state: "exempt", trialDaysLeft: null })).toBe("Your workspace does not need a plan, so these are not limited.");
    for (const state of ["trialing", "active", "exempt"] as const) expect(noPlanNote({ state, trialDaysLeft: 4 })).not.toMatch(/has no limit/);
  });
});
