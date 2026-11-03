import { describe, expect, it } from "vitest";
import { buildCommands } from "@/components/app/commands";
import { NAV_ITEMS, activeHref, navFor } from "@/components/app/nav";
import { accountMenuItems } from "@/components/app/UserMenu";
import {
  billingDateText,
  billingLine,
  countText,
  createRefusal,
  createdButNotOpenedText,
  filterProjects,
  listSummary,
  NO_AD_ACCOUNT,
  NOT_AVAILABLE,
  NOT_TRACKED,
  SPEND_HINT,
  spendText,
  whatsappText,
} from "@/components/projects/helpers";
import { NEW_PROJECT_HREF, PROJECTS_HREF, projectMenuItems } from "@/components/projects/links";
import { NAME_BAD_CHARACTER, NAME_NEEDS_LETTER, NAME_REQUIRED, NAME_TOO_LONG, normalizeProjectName, projectNameProblem, sameProjectName } from "@/lib/projects/names";
import { isUnpaidState, newProjectAccess, newProjectRefusal, PROJECT_COPY, ProjectFieldError, projectBilling, projectNameFrom, type BillingFacts } from "@/lib/projects/rules";
import { MAX_OWNED_PROJECTS, MAX_UNPAID_PROJECTS, PROJECT_NAME_MAX, type ProjectBilling, type ProjectBillingState } from "@/lib/projects/types";
import { HttpError } from "@/lib/tenancy";

const D = (s: string) => new Date(s);

describe("project names (the signup workspace-name rule)", () => {
  it("requires a name and caps it at the signup length", () => {
    expect(projectNameProblem(undefined)).toBe(NAME_REQUIRED);
    expect(projectNameProblem(null)).toBe(NAME_REQUIRED);
    expect(projectNameProblem("")).toBe(NAME_REQUIRED);
    expect(projectNameProblem("   \n\t ")).toBe(NAME_REQUIRED);
    expect(projectNameProblem("a".repeat(PROJECT_NAME_MAX))).toBeNull();
    expect(projectNameProblem("a".repeat(PROJECT_NAME_MAX + 1))).toBe(NAME_TOO_LONG);
    expect(PROJECT_NAME_MAX).toBe(100);
  });

  it("refuses names with no letter or number, with invisible characters, or that are not text", () => {
    expect(projectNameProblem("---")).toBe(NAME_NEEDS_LETTER);
    expect(projectNameProblem("!!!")).toBe(NAME_NEEDS_LETTER);
    expect(projectNameProblem(`Shop${String.fromCharCode(0)}`)).toBe(NAME_BAD_CHARACTER);
    expect(projectNameProblem(`Shop${String.fromCharCode(0x200b)}One`)).toBe(NAME_BAD_CHARACTER);
    expect(projectNameProblem(`Shop${String.fromCharCode(0x202e)}`)).toBe(NAME_BAD_CHARACTER);
    expect(projectNameProblem(42)).toBe(NAME_BAD_CHARACTER);
    expect(projectNameProblem({ name: "x" })).toBe(NAME_BAD_CHARACTER);
  });

  it("accepts names in any script and with punctuation", () => {
    for (const ok of ["Sharma Sweets", "शर्मा स्वीट्स", "Café & Co.", "7-Eleven", "A"]) expect(projectNameProblem(ok), ok).toBeNull();
  });

  it("saves the name trimmed with runs of whitespace as one space, and compares names loosely", () => {
    expect(normalizeProjectName("  Sharma \n\t Sweets  ")).toBe("Sharma Sweets");
    expect(sameProjectName("sharma  sweets", " Sharma Sweets")).toBe(true);
    expect(sameProjectName("Sharma Sweets", "Sharma Sweet")).toBe(false);
  });

  it("projectNameFrom returns the saved form or throws a name-field 400 with the form's words", () => {
    expect(projectNameFrom({ name: "  Acme   Retail " })).toBe("Acme Retail");
    for (const [body, message] of [[{}, NAME_REQUIRED], [{ name: "" }, NAME_REQUIRED], [{ name: 5 }, NAME_BAD_CHARACTER], [{ name: "x".repeat(101) }, NAME_TOO_LONG]] as const) {
      let error: unknown;
      try {
        projectNameFrom(body as Record<string, unknown>);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ProjectFieldError);
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ status: 400, message, field: "name" });
    }
  });
});

describe("who may start a project", () => {
  const facts = (over: Partial<Parameters<typeof newProjectRefusal>[0]> = {}) => ({ verificationRequired: true, emailVerifiedAt: D("2026-10-01"), ownedStates: ["active"] as ProjectBillingState[], ...over });

  it("lets a confirmed person with paid or few unpaid projects start one", () => {
    expect(newProjectRefusal(facts())).toBeNull();
    expect(newProjectRefusal(facts({ ownedStates: [] }))).toBeNull();
    expect(newProjectRefusal(facts({ ownedStates: Array(MAX_UNPAID_PROJECTS - 1).fill("trialing") }))).toBeNull();
    expect(newProjectAccess(facts())).toEqual({ allowed: true, reason: null });
  });

  it("needs a confirmed email address when the platform requires one (same rule as other writes)", () => {
    expect(newProjectRefusal(facts({ emailVerifiedAt: null }))).toEqual({ status: 403, message: PROJECT_COPY.verify });
    // Mail cannot be delivered (no SMTP): nobody can confirm, so nobody is held back.
    expect(newProjectRefusal(facts({ emailVerifiedAt: null, verificationRequired: false }))).toBeNull();
    // Not loaded is unknown, not unconfirmed (assertEmailVerifiedForWrite does the same).
    expect(newProjectRefusal(facts({ emailVerifiedAt: undefined }))).toBeNull();
  });

  it("refuses while one of the person's projects is suspended", () => {
    expect(newProjectRefusal(facts({ ownedStates: ["active", "suspended"] }))).toEqual({ status: 403, message: PROJECT_COPY.suspended });
  });

  it("caps owned projects and projects without a paid plan, so trials cannot be chained", () => {
    expect(newProjectRefusal(facts({ ownedStates: Array(MAX_OWNED_PROJECTS).fill("active") }))).toEqual({ status: 409, message: PROJECT_COPY.ownedCap });
    expect(newProjectRefusal(facts({ ownedStates: ["active", ...Array(MAX_UNPAID_PROJECTS).fill("trialing")] }))).toEqual({ status: 409, message: PROJECT_COPY.unpaidCap });
    expect(newProjectRefusal(facts({ ownedStates: ["trialing", "locked", "locked"] }))?.message).toBe(PROJECT_COPY.unpaidCap);
    // Paid, payment-retry and complimentary projects never count as unpaid.
    expect(newProjectRefusal(facts({ ownedStates: ["active", "past_due_grace", "exempt", "trialing", "locked"] }))).toBeNull();
    expect(["trialing", "locked"].every((s) => isUnpaidState(s as ProjectBillingState))).toBe(true);
    expect(["active", "past_due_grace", "exempt", "suspended"].some((s) => isUnpaidState(s as ProjectBillingState))).toBe(false);
    expect(newProjectAccess(facts({ ownedStates: Array(MAX_UNPAID_PROJECTS).fill("trialing") }))).toEqual({ allowed: false, reason: PROJECT_COPY.unpaidCap });
  });

  it("orders the reasons the way they are fixed: email first, then suspension, then the caps", () => {
    expect(newProjectRefusal(facts({ emailVerifiedAt: null, ownedStates: ["suspended"] }))?.message).toBe(PROJECT_COPY.verify);
    expect(newProjectRefusal(facts({ ownedStates: ["suspended", ...Array(MAX_UNPAID_PROJECTS).fill("trialing")] }))?.message).toBe(PROJECT_COPY.suspended);
  });

  it("speaks plainly: no jargon, every refusal says what to do", () => {
    for (const text of [PROJECT_COPY.verify, PROJECT_COPY.suspended, PROJECT_COPY.ownedCap, PROJECT_COPY.unpaidCap, PROJECT_COPY.perUserLimit, PROJECT_COPY.perConnectionLimit, PROJECT_COPY.duplicate("Acme")]) {
      expect(text).not.toMatch(/tenant|workspaceId|trialEndsAt|429|402|rate limit|!/i);
      expect(text.length).toBeGreaterThan(20);
    }
    expect(PROJECT_COPY.duplicate("Acme")).toBe('You already have a project called "Acme". Choose a different name.');
  });
});

describe("a project's plan line", () => {
  const base = (over: Partial<BillingFacts> = {}): BillingFacts => ({ state: "active", trialEndsAt: null, daysLeftInTrial: null, planName: "Growth", subscription: null, graceDays: 3, ...over });
  const sub = (over: Partial<NonNullable<BillingFacts["subscription"]>> = {}): NonNullable<BillingFacts["subscription"]> => ({
    status: "active",
    currentPeriodEnd: D("2026-11-30T00:00:00Z"),
    pastDueSince: null,
    cancelAtPeriodEnd: false,
    manual: false,
    ...over,
  });

  it("trial: the trial end date and days left, and no plan name", () => {
    expect(projectBilling(base({ state: "trialing", trialEndsAt: D("2026-11-05T10:00:00Z"), daysLeftInTrial: 5, planName: null }))).toEqual({
      state: "trialing",
      planName: null,
      endsAt: "2026-11-05T10:00:00.000Z",
      endKind: "trial_ends",
      daysLeftInTrial: 5,
    });
  });

  it("paid: renews, or ends when cancelled, set up by hand, or already stopped", () => {
    expect(projectBilling(base({ subscription: sub() }))).toMatchObject({ state: "active", planName: "Growth", endsAt: "2026-11-30T00:00:00.000Z", endKind: "renews" });
    expect(projectBilling(base({ subscription: sub({ cancelAtPeriodEnd: true }) })).endKind).toBe("ends");
    expect(projectBilling(base({ subscription: sub({ manual: true }) })).endKind).toBe("ends");
    expect(projectBilling(base({ subscription: sub({ status: "canceled" }) })).endKind).toBe("ends");
    expect(projectBilling(base({ subscription: sub({ currentPeriodEnd: null }) }))).toMatchObject({ endsAt: null, endKind: null });
  });

  it("payment failed: read-only from the end of the grace period", () => {
    const b = projectBilling(base({ state: "past_due_grace", subscription: sub({ status: "past_due", pastDueSince: D("2026-10-30T00:00:00Z") }), graceDays: 3 }));
    expect(b).toMatchObject({ state: "past_due_grace", endsAt: "2026-11-02T00:00:00.000Z", endKind: "read_only_from" });
  });

  it("read-only: when the trial, plan or grace period ended", () => {
    expect(projectBilling(base({ state: "locked", trialEndsAt: D("2026-10-20T00:00:00Z"), planName: null }))).toMatchObject({ endKind: "ended", endsAt: "2026-10-20T00:00:00.000Z", planName: null });
    expect(projectBilling(base({ state: "locked", subscription: sub({ status: "expired", currentPeriodEnd: D("2026-10-01T00:00:00Z") }) }))).toMatchObject({ endKind: "ended", endsAt: "2026-10-01T00:00:00.000Z" });
    expect(projectBilling(base({ state: "locked", subscription: sub({ status: "past_due", pastDueSince: D("2026-10-01T00:00:00Z") }), graceDays: 3 }))).toMatchObject({ endKind: "ended", endsAt: "2026-10-04T00:00:00.000Z" });
    expect(projectBilling(base({ state: "locked", trialEndsAt: null, planName: null }))).toMatchObject({ endsAt: null, endKind: null });
  });

  it("complimentary and suspended projects carry no date", () => {
    expect(projectBilling(base({ state: "exempt" }))).toMatchObject({ endsAt: null, endKind: null });
    expect(projectBilling(base({ state: "suspended", subscription: sub() }))).toMatchObject({ endsAt: null, endKind: null });
  });
});

describe("All projects card words", () => {
  const billing = (over: Partial<ProjectBilling>): ProjectBilling => ({ state: "active", planName: null, endsAt: null, endKind: null, daysLeftInTrial: null, ...over });

  it("uses the Billing page's state words and tones", () => {
    expect(billingLine(billing({ state: "trialing" }))).toMatchObject({ label: "Free trial", tone: "info" });
    expect(billingLine(billing({ state: "active", planName: "Growth" }))).toMatchObject({ label: "Active", tone: "good", plan: "Growth" });
    expect(billingLine(billing({ state: "past_due_grace" }))).toMatchObject({ label: "Payment failed", tone: "warn" });
    expect(billingLine(billing({ state: "locked" }))).toMatchObject({ label: "Read-only", tone: "bad" });
    expect(billingLine(billing({ state: "suspended" }))).toMatchObject({ label: "Suspended", tone: "bad" });
    expect(billingLine(billing({ state: "exempt" }))).toMatchObject({ label: "Complimentary", tone: "good" });
  });

  it("says what the date means", () => {
    const at = "2026-11-05T10:00:00.000Z";
    expect(billingDateText(billing({ endsAt: at, endKind: "trial_ends", daysLeftInTrial: 9 }))).toMatch(/^Trial ends on \d{2} Nov 2026$/);
    expect(billingDateText(billing({ endsAt: at, endKind: "trial_ends", daysLeftInTrial: 1 }))).toMatch(/^Trial ends on .+ \(1 day left\)$/);
    expect(billingDateText(billing({ endsAt: at, endKind: "trial_ends", daysLeftInTrial: 3 }))).toMatch(/\(3 days left\)$/);
    expect(billingDateText(billing({ endsAt: at, endKind: "renews" }))).toMatch(/^Renews on /);
    expect(billingDateText(billing({ endsAt: at, endKind: "ends" }))).toMatch(/^Ends on /);
    expect(billingDateText(billing({ endsAt: at, endKind: "read_only_from" }))).toMatch(/^Becomes read-only on .+ unless the payment goes through$/);
    expect(billingDateText(billing({ endsAt: at, endKind: "ended" }))).toMatch(/^Ended on /);
    expect(billingDateText(billing({ endsAt: null, endKind: "renews" }))).toBeNull();
    expect(billingDateText(billing({ endsAt: at, endKind: null }))).toBeNull();
  });

  it("describes the WhatsApp number, counts and ad spend, and says Not available when a figure failed", () => {
    expect(whatsappText(null)).toBe(NOT_AVAILABLE);
    expect(whatsappText({ state: "none", numbers: 0, display: null })).toBe("Not connected");
    expect(whatsappText({ state: "setup", numbers: 1, display: "+91 90000 00001" })).toBe("Not connected yet");
    expect(whatsappText({ state: "connected", numbers: 1, display: "+91 90000 00001" })).toBe("+91 90000 00001");
    expect(whatsappText({ state: "connected", numbers: 3, display: "+91 90000 00001" })).toBe("+91 90000 00001 and 2 more");
    expect(whatsappText({ state: "connected", numbers: 1, display: null })).toBe("Connected");
    expect(countText(null)).toBe(NOT_AVAILABLE);
    expect(countText(0)).toBe("0");
    expect(countText(123456)).toBe("1,23,456");
    expect(spendText(null)).toBe(NOT_AVAILABLE);
    const two = [{ minor: "120000", currency: "INR", formatted: "₹1,200" }, { minor: "4000", currency: "USD", formatted: "$40" }];
    expect(spendText({ amounts: two, accounts: 2, tracked: 2 })).toBe("₹1,200 + $40");
  });

  it("tells nothing spent apart from not tracked: None only when every ad account is tracked", () => {
    expect(spendText({ amounts: [], accounts: 0, tracked: 0 })).toBe(NO_AD_ACCOUNT);
    expect(spendText({ amounts: [], accounts: 2, tracked: 2 })).toBe("None");
    // Connected ad accounts Edwyz does not read (no Edwyz ad running, no limit set here): not "None", not ₹0.
    expect(spendText({ amounts: [], accounts: 1, tracked: 0 })).toBe(NOT_TRACKED);
    expect(spendText({ amounts: [], accounts: 3, tracked: 0 })).toBe(NOT_TRACKED);
    // Some tracked: their spend, and how many accounts it leaves out.
    expect(spendText({ amounts: [{ minor: "120000", currency: "INR", formatted: "₹1,200" }], accounts: 3, tracked: 1 })).toBe("₹1,200 (2 of 3 ad accounts not tracked)");
    expect(spendText({ amounts: [], accounts: 2, tracked: 1 })).toBe("None (1 of 2 ad accounts not tracked)");
    expect(NOT_TRACKED).toBe("Not tracked");
    // The hint says where the figure comes from and why an account can be not tracked.
    expect(SPEND_HINT).toMatch(/spending controls/);
    expect(SPEND_HINT).toMatch(/not tracked/);
    expect(SPEND_HINT).not.toMatch(/tenant|SpendDaily|commitment|sync/i);
  });

  it("finds projects by every word of the query and sums up the list", () => {
    const list = [{ name: "Sharma Sweets" }, { name: "Mehta Motors" }, { name: "Sharma Textiles" }];
    expect(filterProjects(list, "")).toBe(list);
    expect(filterProjects(list, "sharma").map((p) => p.name)).toEqual(["Sharma Sweets", "Sharma Textiles"]);
    expect(filterProjects(list, "SHARMA tex").map((p) => p.name)).toEqual(["Sharma Textiles"]);
    expect(filterProjects(list, "nope")).toEqual([]);
    expect(listSummary(1, 1, "")).toBe("1 project");
    expect(listSummary(3, 3, "  ")).toBe("3 projects");
    expect(listSummary(2, 3, "sharma")).toBe('2 of 3 projects match "sharma"');
    expect(listSummary(0, 3, "nope ")).toBe('No projects match "nope"');
  });

  it("puts a name refusal under the field and anything else above the form", () => {
    expect(createRefusal(Object.assign(new Error("You already have a project called \"A\". Choose a different name."), { body: { field: "name" } }))).toEqual({ field: 'You already have a project called "A". Choose a different name.', form: null });
    expect(createRefusal(Object.assign(new Error(PROJECT_COPY.unpaidCap), { body: { error: PROJECT_COPY.unpaidCap } }))).toEqual({ field: null, form: PROJECT_COPY.unpaidCap });
    expect(createRefusal("boom").form).toMatch(/Check your connection/);
    expect(createdButNotOpenedText("Acme", "Try again.")).toBe("Acme is ready, but we could not open it. Try again. Switch to it from All projects.");
  });
});

describe("where All projects and New project are reached", () => {
  it("the workspace switcher ends with All projects and New project, as links (not workspace choices)", () => {
    const items = projectMenuItems();
    expect(items[0]).toEqual({ separator: true });
    expect(items.slice(1)).toEqual([
      expect.objectContaining({ label: "All projects", href: PROJECTS_HREF, icon: "grid" }),
      expect.objectContaining({ label: "New project", href: NEW_PROJECT_HREF, icon: "plus" }),
    ]);
    // No `checked`: they render as menuitem, so the workspace list keeps its menuitemradio count.
    for (const i of items) expect("checked" in i).toBe(false);
    expect(NEW_PROJECT_HREF).toBe("/app/projects?new=1");
  });

  it("the account menu links every member to All projects, after the role's own items and before Sign out", () => {
    for (const role of ["agent", "admin", "owner"] as const) {
      const items = accountMenuItems(role, () => undefined);
      const at = items.findIndex((i) => !("separator" in i) && i.href === PROJECTS_HREF);
      expect(at, role).toBeGreaterThan(0);
      expect(items[at + 1]).toEqual({ separator: true });
    }
  });

  it("is one navigation entry every member sees, so the sidebar, the drawer and the command palette list it", () => {
    const entries = NAV_ITEMS.filter((i) => i.href === PROJECTS_HREF);
    expect(entries).toEqual([expect.objectContaining({ label: "All projects", minRole: "agent", section: "insights", icon: "grid" })]);
    for (const role of ["agent", "admin", "owner"] as const) {
      expect(navFor(role).some((i) => i.href === PROJECTS_HREF), role).toBe(true);
      const command = buildCommands(role).find((c) => c.href === PROJECTS_HREF);
      expect(command, role).toMatchObject({ group: "Pages", label: "All projects" });
      expect(command?.keywords).toEqual(expect.arrayContaining(["workspaces", "clients", "new project"]));
    }
    expect(activeHref("/app/projects", navFor("agent"))).toBe(PROJECTS_HREF);
  });
});
