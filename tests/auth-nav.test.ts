import { describe, expect, it } from "vitest";
import { NAV_ITEMS, activeHref, activeSection, groupNav, isActive, mobileTabs, navFor } from "@/components/app/nav";

describe("app navigation", () => {
  it("shows agents the inbox and read-only lists only", () => {
    expect(navFor("agent").map((i) => i.label)).toEqual([
      "Inbox", "Contacts", "Segments", "Leads", "Templates", "Creative Studio", "Content calendar",
      "Automation", "Chatbots", "AI agent", "Reply materials", "Shopify recovery", "Reports", "Ad insights", "Meta connections", "Spending limits",
    ]);
  });

  it("shows admins and owners everything", () => {
    expect(navFor("admin")).toHaveLength(28);
    expect(navFor("owner")).toHaveLength(28);
    expect(NAV_ITEMS).toHaveLength(28);
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
      ["Insights", ["Reports", "Ad insights", "Optimiser", "Conversions"]],
      ["Settings", ["Team", "Teams", "Chat routing", "Connect WhatsApp", "Meta connections", "AI tools", "MCP connection", "API and webhooks", "Billing", "Spending limits"]],
    ]);
  });

  it("filters by role and drops empty sections", () => {
    const agent = groupNav("agent");
    expect(agent.find((g) => g.id === "campaigns")?.items.map((i) => i.label)).toEqual(["Templates", "Creative Studio", "Content calendar"]);
    expect(agent.find((g) => g.id === "settings")?.items.map((i) => i.label)).toEqual(["Meta connections", "Spending limits"]);
    expect(groupNav("agent").flatMap((g) => g.items)).toHaveLength(16);
  });

  it("picks five mobile tabs the role may open", () => {
    expect(mobileTabs("owner").map((i) => i.label)).toEqual(["Inbox", "Contacts", "Broadcasts", "Automation", "Reports"]);
    expect(mobileTabs("agent").map((i) => i.label)).toEqual(["Inbox", "Contacts", "Templates", "Automation", "Reports"]);
  });
});
