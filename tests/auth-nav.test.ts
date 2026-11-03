import { describe, expect, it } from "vitest";
import { HOME_ITEM, NAV_ITEMS, activeHref, activeSection, groupNav, isActive, mobileTabs, moreIsCurrent, navFor } from "@/components/app/nav";

describe("app navigation", () => {
  it("shows agents the inbox and read-only lists only", () => {
    expect(navFor("agent").map((i) => i.label)).toEqual([
      "Inbox", "Contacts", "Segments", "Leads", "Templates", "Creative Studio", "Content calendar",
      "Automation", "Chatbots", "AI agent", "Reply materials", "Shopify recovery", "Reports", "Ad insights", "All projects", "Meta connections", "Spending limits",
    ]);
  });

  it("shows admins and owners everything", () => {
    expect(navFor("admin")).toHaveLength(29);
    expect(navFor("owner")).toHaveLength(29);
    expect(NAV_ITEMS).toHaveLength(29);
  });

  it("keeps the original item shape and adds a section and icon to every link", () => {
    for (const item of NAV_ITEMS) {
      expect(item.href.startsWith("/app/")).toBe(true);
      expect(["agent", "admin", "owner"]).toContain(item.minRole);
      expect(item.section).toBeTruthy();
      expect(item.icon).toBeTruthy();
    }
    expect(NAV_ITEMS.filter((i) => i.group === "settings").every((i) => i.section === "settings")).toBe(true);
  });

  it("shows Spending limits to every member: owner, admin and team member (docs/SPEND-CONTROLS-SPEC.md 8.1)", () => {
    for (const role of ["owner", "admin", "agent"] as const) expect(navFor(role).some((i) => i.href === "/app/settings/spending")).toBe(true);
    expect(NAV_ITEMS.find((i) => i.href === "/app/settings/spending")).toEqual({
      href: "/app/settings/spending",
      label: "Spending limits",
      minRole: "agent",
      group: "settings",
      section: "settings",
      icon: "card",
      keywords: ["budget", "limit", "spend", "cap", "money", "approvals", "assistants", "stop"],
    });
    expect(activeHref("/app/settings/spending", navFor("agent"))).toBe("/app/settings/spending");
    expect(activeSection("/app/settings/spending", "agent")).toBe("settings");
  });

  it("matches active links by path prefix", () => {
    expect(isActive("/app/inbox/abc", "/app/inbox")).toBe(true);
    expect(isActive("/app/inboxes", "/app/inbox")).toBe(false);
  });

  it("marks Home current on the dashboard only, not on every page under /app (a 404, Getting started)", () => {
    expect(isActive("/app", "/app")).toBe(true);
    expect(isActive("/app/does-not-exist", "/app")).toBe(false);
    expect(isActive("/app/getting-started", "/app")).toBe(false);
    const withHome = [HOME_ITEM, ...navFor("owner")];
    expect(activeHref("/app", withHome)).toBe("/app");
    expect(activeHref("/app/does-not-exist", withHome)).toBeNull();
    expect(activeHref("/app/getting-started", withHome)).toBeNull();
    expect(activeHref("/app/inbox", withHome)).toBe("/app/inbox");
  });

  it("highlights only the most specific link for nested pages", () => {
    const items = navFor("admin");
    expect(activeHref("/app/ads/insights", items)).toBe("/app/ads/insights");
    expect(activeHref("/app/ads/new", items)).toBe("/app/ads");
    expect(activeHref("/app/automation/chatbots/42", items)).toBe("/app/automation/chatbots");
    expect(activeHref("/app", items)).toBeNull();
    expect(activeSection("/app/settings/api", "admin")).toBe("settings");
  });
});

describe("grouped navigation", () => {
  it("orders sections and pages as designed for admins", () => {
    expect(groupNav("admin").map((g) => [g.label, g.items.map((i) => i.label)])).toEqual([
      ["Conversations", ["Inbox"]],
      ["Customers", ["Contacts", "Segments", "Leads"]],
      ["Campaigns", ["Broadcasts", "Templates", "Ad campaigns", "Creative Studio", "Content calendar"]],
      ["Automation", ["Automation", "Chatbots", "AI agent", "Reply materials", "Shopify recovery"]],
      ["Insights", ["Reports", "Ad insights", "Optimiser", "Conversions", "All projects"]],
      ["Settings", ["Team", "Teams", "Chat routing", "Connect WhatsApp", "Meta connections", "AI tools", "MCP connection", "API and webhooks", "Billing", "Spending limits"]],
    ]);
  });

  it("filters by role and drops empty sections", () => {
    const agent = groupNav("agent");
    expect(agent.find((g) => g.id === "campaigns")?.items.map((i) => i.label)).toEqual(["Templates", "Creative Studio", "Content calendar"]);
    expect(agent.find((g) => g.id === "settings")?.items.map((i) => i.label)).toEqual(["Meta connections", "Spending limits"]);
    expect(groupNav("agent").flatMap((g) => g.items)).toHaveLength(17);
  });

  it("picks five mobile tabs the role may open", () => {
    expect(mobileTabs("owner").map((i) => i.label)).toEqual(["Inbox", "Contacts", "Broadcasts", "Automation", "Reports"]);
    expect(mobileTabs("agent").map((i) => i.label)).toEqual(["Inbox", "Contacts", "Templates", "Automation", "Reports"]);
  });

  it("shows More as the current place for menu pages without a tab", () => {
    for (const path of ["/app/leads", "/app/leads/sequences", "/app/leads/forms", "/app", "/app/settings/team"]) expect(moreIsCurrent(path, "owner"), path).toBe(true);
    for (const path of ["/app/contacts", "/app/contacts/segments", "/app/inbox/c1", "/app/reports", "/app/nope", "/app/setup"]) expect(moreIsCurrent(path, "owner"), path).toBe(false);
    expect(moreIsCurrent("/app/templates", "owner")).toBe(true); // in More for owners
    expect(moreIsCurrent("/app/templates", "agent")).toBe(false); // agents have a Templates tab
  });
});
