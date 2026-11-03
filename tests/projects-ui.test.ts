import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectsPage, { metadata } from "@/app/(app)/app/projects/page";
import { ProjectCard } from "@/components/projects/ProjectCard";
import { ProjectsView } from "@/components/projects/ProjectsView";
import { AFTER_SWITCH, createProjectRequest, switchToProject } from "@/components/projects/switch";
import type { ProjectSummary } from "@/lib/projects/types";

const root = path.join(__dirname, "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");

const project = (over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: "t2",
  name: "Mehta Motors",
  role: "admin",
  current: false,
  billing: { state: "trialing", planName: null, endsAt: "2026-11-05T00:00:00.000Z", endKind: "trial_ends", daysLeftInTrial: 2 },
  whatsapp: { state: "connected", numbers: 1, display: "+91 98765 43210" },
  unreadConversations: 12,
  newLeads: 3,
  adSpendMonth: { amounts: [{ minor: "120000", currency: "INR", formatted: "₹1,200" }], accounts: 1, tracked: 1 },
  ...over,
});

const card = (p: ProjectSummary, extra: { switching?: boolean; disabled?: boolean } = {}) =>
  renderToStaticMarkup(createElement(ProjectCard, { project: p, leadsWindowDays: 7, switching: extra.switching ?? false, disabled: extra.disabled ?? false, onSwitch: () => undefined }));

describe("project card", () => {
  it("names the project as a heading the card is labelled by, with the role and every figure", () => {
    const html = card(project());
    const id = html.match(/<article aria-labelledby="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`<h2 id="${id}"`);
    expect(html).toContain("Mehta Motors</h2>");
    expect(html).toContain("Your role: Admin");
    expect(html).toContain("Free trial");
    expect(html).toMatch(/Trial ends on .+ \(2 days left\)/);
    for (const [label, value] of [["WhatsApp number", "+91 98765 43210"], ["Unread chats", "12"], ["New leads, last 7 days", "3"], ["Ad spend this month", "₹1,200"]]) {
      expect(html).toMatch(new RegExp(`<dt[^>]*>${label.replace(/[+]/g, "\\+")}</dt><dd[^>]*>${value.replace(/[+]/g, "\\+")}</dd>`));
    }
  });

  it("offers Switch, whose name says which project, and shows progress while it runs", () => {
    const html = card(project());
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Switch<span class="sr-only"> to Mehta Motors<\/span><\/button>/);
    expect(card(project(), { switching: true })).toContain('aria-busy="true"');
    expect(card(project(), { disabled: true })).toMatch(/<button[^>]*disabled=""/);
  });

  it("marks the current project in words and links to its dashboard instead of a Switch button", () => {
    const html = card(project({ current: true, role: "owner" }));
    expect(html).toContain("Current");
    expect(html).toContain('href="/app"');
    expect(html).toContain("Open dashboard");
    expect(html).not.toContain("Switch");
  });

  it("says Not available for a figure that could not be loaded, and the plan name for a paid project", () => {
    const html = card(project({ whatsapp: null, unreadConversations: null, newLeads: null, adSpendMonth: null, billing: { state: "active", planName: "Growth", endsAt: null, endKind: null, daysLeftInTrial: null } }));
    expect(html.match(/Not available/g)).toHaveLength(4);
    expect(html).toContain("Active");
    expect(html).toContain("Growth");
  });

  it("says Not tracked, not None, for ad accounts Edwyz does not read", () => {
    const spend = (adSpendMonth: ProjectSummary["adSpendMonth"]) => card(project({ adSpendMonth })).match(/<dt[^>]*>Ad spend this month<\/dt><dd[^>]*>([^<]*)<\/dd>/)?.[1];
    expect(spend({ amounts: [], accounts: 2, tracked: 0 })).toBe("Not tracked");
    expect(spend({ amounts: [], accounts: 1, tracked: 1 })).toBe("None");
    expect(spend({ amounts: [], accounts: 0, tracked: 0 })).toBe("No ad account");
  });

  it("works on a 360 px phone: one column of figures pairs, long names wrap instead of overflowing", () => {
    const html = card(project({ name: "A very long project name that goes on and on for a client" }));
    expect(html).toContain("grid-cols-2");
    expect(html).toContain("break-words");
    expect(html).toContain("w-full sm:w-auto");
  });
});

describe("All projects page", () => {
  it("is titled All projects and opens the New project form for ?new=1 only", async () => {
    expect(metadata.title).toBe("All projects");
    const withNew = await ProjectsPage({ searchParams: Promise.resolve({ new: "1" }) });
    const plain = await ProjectsPage({ searchParams: Promise.resolve({}) });
    const listy = await ProjectsPage({ searchParams: Promise.resolve({ new: ["1", "x"] }) });
    const other = await ProjectsPage({ searchParams: Promise.resolve({ new: "yes" }) });
    for (const el of [withNew, plain, listy, other]) expect(isValidElement(el) && el.type).toBe(ProjectsView);
    expect([withNew, plain, listy, other].map((el) => (el.props as { startNew: boolean }).startNew)).toEqual([true, false, true, false]);
  });

  it("lays the cards out mobile first as a list, with one h1, loading, error and live status", () => {
    const view = source("src/components/projects/ProjectsView.tsx");
    expect(view).toContain('<ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">');
    expect(view).toContain('title="All projects"');
    expect(view).toContain("<ErrorState");
    expect(view).toContain("Try again");
    expect(view).toMatch(/<div role="status"[^>]*>\s*<span className="sr-only">Loading your projects<\/span>/);
    expect(view).toContain('aria-live="polite"');
    expect(view).toContain('apiFetch<ProjectsOverview>("/api/projects/overview")');
    // Filter-empty state says what was filtered and offers the way back.
    expect(view).toContain("Clear search");
  });

  it("the New project form labels its field, checks itself, announces progress and keeps one primary action", () => {
    const dialog = source("src/components/projects/NewProjectDialog.tsx");
    expect(dialog).toContain("<Dialog");
    expect(dialog).toContain('label="Project name"');
    expect(dialog).toContain("noValidate");
    expect(dialog).toContain('role="status" aria-live="polite"');
    expect(dialog).toContain("dismissible={!busy}");
    expect(dialog.match(/<Button /g)).toHaveLength(2);
    expect(dialog).toContain('variant="secondary" onClick={onClose}');
    expect(dialog).toContain("Create project");
    // The same rule as the server, from the shared module.
    expect(dialog).toContain('from "@/lib/projects/names"');
  });

  it("the workspace switcher ends with the project links", () => {
    const switcher = source("src/components/app/WorkspaceSwitcher.tsx");
    expect(switcher).toContain('import { projectMenuItems } from "@/components/projects/links";');
    expect(switcher).toContain("...projectMenuItems()");
  });
});

describe("switching and creating from the page", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("switches through the existing switch-workspace route, then opens the dashboard", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ tenantId: "t2", role: "admin" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.fn();
    await switchToProject("t2", navigate);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/switch-workspace", expect.objectContaining({ method: "POST", body: JSON.stringify({ tenantId: "t2" }), credentials: "same-origin" }));
    expect(navigate).toHaveBeenCalledWith(AFTER_SWITCH);
    expect(AFTER_SWITCH).toBe("/app");
  });

  it("does not navigate when the switch is refused, and passes the server's words on", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "That workspace has been deleted, so you cannot switch to it." }), { status: 403 })));
    const navigate = vi.fn();
    await expect(switchToProject("t9", navigate)).rejects.toThrow("That workspace has been deleted");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("creates with the name only, and keeps the field the server named on a refusal", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "Taken", field: "name" }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await createProjectRequest("Acme").catch((e: unknown) => e);
    expect(fetchMock).toHaveBeenCalledWith("/api/projects", expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "Acme" }) }));
    expect(err).toMatchObject({ message: "Taken", body: { field: "name" } });
  });
});
