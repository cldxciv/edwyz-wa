import { describe, expect, it } from "vitest";
import { buildCommands } from "@/components/app/commands";
import { fuzzyMatch, fuzzyRank, highlightRuns } from "@/components/app/fuzzy";

describe("fuzzyMatch", () => {
  it("matches subsequences case-insensitively and rejects non-matches", () => {
    expect(fuzzyMatch("bcast", "Broadcasts")).not.toBeNull();
    expect(fuzzyMatch("INBX", "Inbox")).not.toBeNull();
    expect(fuzzyMatch("xyz", "Inbox")).toBeNull();
    expect(fuzzyMatch("inboxes", "Inbox")).toBeNull();
  });

  it("treats an empty query as a match with no highlights", () => {
    expect(fuzzyMatch("  ", "Inbox")).toEqual({ score: 0, indices: [] });
  });

  it("scores prefix and contiguous matches above scattered ones", () => {
    const prefix = fuzzyMatch("tem", "Templates")!;
    const scattered = fuzzyMatch("tem", "Total email manager")!;
    expect(prefix.score).toBeGreaterThan(scattered.score);
    expect(prefix.indices).toEqual([0, 1, 2]);
  });
});

describe("fuzzyRank", () => {
  const items = ["Contacts", "Content calendar", "Connect WhatsApp", "Billing"];
  it("ranks the best label first and drops misses", () => {
    const out = fuzzyRank(items, "cont", (s) => s).map((r) => r.item);
    expect(out[0]).toBe("Contacts");
    expect(out).not.toContain("Billing");
  });

  it("can match on extra search terms", () => {
    const out = fuzzyRank(items, "invoice", (s) => s, (s) => (s === "Billing" ? ["invoice", "plan"] : []));
    expect(out.map((r) => r.item)).toEqual(["Billing"]);
    expect(out[0].indices).toEqual([]);
  });

  it("keeps the original order for an empty query", () => {
    expect(fuzzyRank(items, "", (s) => s).map((r) => r.item)).toEqual(items);
  });
});

describe("highlightRuns", () => {
  it("splits text into plain and matched runs", () => {
    expect(highlightRuns("Inbox", [0, 1])).toEqual([
      { text: "In", match: true },
      { text: "box", match: false },
    ]);
    expect(highlightRuns("Inbox", [])).toEqual([{ text: "Inbox", match: false }]);
  });
});

describe("command list", () => {
  it("offers the requested quick actions to admins", () => {
    const labels = buildCommands("admin").filter((c) => c.group === "Quick actions").map((c) => c.label);
    for (const l of ["New broadcast", "New template", "Add contact", "New chatbot", "Invite teammate", "Go to inbox", "Toggle theme", "Sign out"]) {
      expect(labels).toContain(l);
    }
  });

  it("hides admin-only actions and pages from agents", () => {
    const all = buildCommands("agent");
    const labels = all.map((c) => c.label);
    expect(labels).not.toContain("New broadcast");
    expect(labels).not.toContain("Invite teammate");
    expect(all.some((c) => c.href === "/app/billing")).toBe(false);
    expect(all.some((c) => c.href === "/app/inbox" && c.group === "Pages")).toBe(true);
  });

  it("finds a page by a loose query", () => {
    const ranked = fuzzyRank(buildCommands("owner"), "bil", (c) => c.label, (c) => c.keywords);
    expect(ranked[0].item.href).toBe("/app/billing");
  });

  it("has unique ids and either a link or an action on every command", () => {
    const all = buildCommands("owner");
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    expect(all.every((c) => Boolean(c.href) !== Boolean(c.run))).toBe(true);
  });
});
