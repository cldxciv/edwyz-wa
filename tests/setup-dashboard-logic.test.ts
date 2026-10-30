import { describe, expect, it } from "vitest";
import { deltaLabel, describeSeries, formatCount, formatReplyTime, greetingFor, quickActionsFor, shortDay, sparkGeometry } from "@/components/dashboard/helpers";
import { hasSeenWelcome, markWelcomeSeen, welcomeKey } from "@/components/setup/welcome";
import { ringDash } from "@/components/setup/ring";
import { buildAttention, connectionAlert, contactLabel, formatWait, sum, trendPct, type AttentionInput } from "@/lib/setup/dashboard-logic";

const quiet: AttentionInput = {
  unassigned: 0,
  waiting: { count: 0, oldest: null },
  failedSends: 0,
  rejectedTemplates: { count: 0, names: [] },
  connection: null,
};

describe("trendPct", () => {
  it("compares to the previous period and refuses to divide by nothing", () => {
    expect(trendPct(150, 100)).toBe(50);
    expect(trendPct(50, 100)).toBe(-50);
    expect(trendPct(10, 0)).toBeNull();
    expect(trendPct(null, 10)).toBeNull();
    expect(trendPct(10, null)).toBeNull();
  });
  it("sums series with gaps", () => {
    expect(sum([1, null, 3])).toBe(4);
  });
});

describe("labels", () => {
  it("never shows a full phone number", () => {
    expect(contactLabel("  Asha ", "919876543210")).toBe("Asha");
    expect(contactLabel(null, "+91 98765 43210")).toBe("Contact ending 3210");
    expect(contactLabel("", "12")).toBe("Unnamed contact");
  });
  it("describes waits in plain words", () => {
    expect(formatWait(20)).toBe("under a minute");
    expect(formatWait(600)).toBe("10 min");
    expect(formatWait(3600 * 3 + 600)).toBe("3 h 10 min");
    expect(formatWait(3600 * 12)).toBe("12 h");
    expect(formatWait(86_400)).toBe("1 day");
    expect(formatWait(86_400 * 3)).toBe("3 days");
  });
  it("formats numbers for tiles", () => {
    expect(formatCount(950)).toBe("950");
    expect(formatCount(12_400)).toBe("12.4k");
    expect(formatCount(250_000)).toBe("250k");
    expect(formatReplyTime(null)).toBe("No data yet");
    expect(formatReplyTime(40)).toBe("40 sec");
    expect(formatReplyTime(300)).toBe("5 min");
    expect(formatReplyTime(5400)).toBe("1 h 30 min");
  });
  it("greets by time of day, with or without a name", () => {
    expect(greetingFor(8, "Asha")).toBe("Good morning, Asha");
    expect(greetingFor(14, "Asha")).toBe("Good afternoon, Asha");
    expect(greetingFor(19, "")).toBe("Good evening");
    expect(greetingFor(2, "Asha")).toBe("Hello, Asha");
  });
  it("labels days without timezone drift", () => {
    expect(shortDay("2026-03-02")).toBe("Mon 2");
  });
});

describe("deltaLabel", () => {
  it("colours by whether up is good for the measure", () => {
    expect(deltaLabel({ deltaPct: 12, betterWhen: "up" })).toEqual({ text: "Up 12% on last week", tone: "good" });
    expect(deltaLabel({ deltaPct: 12, betterWhen: "down" })).toEqual({ text: "Up 12% on last week", tone: "bad" });
    expect(deltaLabel({ deltaPct: -30, betterWhen: "down" })).toEqual({ text: "Down 30% on last week", tone: "good" });
    expect(deltaLabel({ deltaPct: 0, betterWhen: "up" })?.tone).toBe("neutral");
    expect(deltaLabel({ deltaPct: null, betterWhen: "up" })).toBeNull();
  });
});

describe("sparkGeometry", () => {
  it("draws nothing without data", () => {
    expect(sparkGeometry([], 120, 36).line).toBe("");
    expect(sparkGeometry([null, null], 120, 36).points).toEqual([]);
  });
  it("maps the highest value to the top and the lowest to the baseline", () => {
    const g = sparkGeometry([0, 5, 10], 120, 36, 3);
    expect(g.points).toHaveLength(3);
    expect(g.points[0]).toEqual({ x: 3, y: 33 });
    expect(g.points[2]).toEqual({ x: 117, y: 3 });
    expect(g.last).toEqual(g.points[2]);
    expect(g.line.startsWith("M3 33")).toBe(true);
    expect(g.area.endsWith("Z")).toBe(true);
  });
  it("breaks the line at days with no data", () => {
    const g = sparkGeometry([4, null, 6, 8], 120, 36);
    expect(g.line.match(/M/g)).toHaveLength(2);
    expect(g.points).toHaveLength(3);
  });
  it("does not divide by zero on a flat series or a single point", () => {
    const flat = sparkGeometry([0, 0, 0], 120, 36);
    expect(flat.points.every((p) => Number.isFinite(p.y))).toBe(true);
    const one = sparkGeometry([7], 120, 36);
    expect(one.points).toHaveLength(1);
    expect(one.area).toBe("");
  });
  it("describes the series for screen readers", () => {
    expect(describeSeries("Messages", [1, 9, 3], String)).toBe("Messages over the last 7 days. Highest 9. Latest 3.");
    expect(describeSeries("Messages", [null], String)).toBe("Messages: no data in the last 7 days.");
  });
});

describe("quick actions", () => {
  it("gives agents only pages they can use", () => {
    const hrefs = quickActionsFor("agent", true).map((a) => a.href);
    expect(hrefs).not.toContain("/app/broadcasts/new");
    expect(hrefs).not.toContain("/app/settings/team");
    expect(hrefs).toContain("/app/inbox");
  });
  it("puts connecting first for admins until a number is live", () => {
    expect(quickActionsFor("owner", false)[0].href).toBe("/app/settings/connect");
    expect(quickActionsFor("admin", true).some((a) => a.href === "/app/broadcasts/new")).toBe(true);
  });
});

describe("connectionAlert", () => {
  const now = new Date("2026-10-27T00:00:00Z");
  const days = (n: number) => new Date(now.getTime() + n * 86_400_000);
  it("is quiet for healthy connections", () => {
    expect(connectionAlert([{ status: "active", tokenExpiresAt: days(60) }, { status: "active", tokenExpiresAt: null }], now)).toBeNull();
    expect(connectionAlert([], now)).toBeNull();
  });
  it("warns about tokens expiring within a week and reports the soonest", () => {
    expect(connectionAlert([{ status: "active", tokenExpiresAt: days(5) }, { status: "expiring", tokenExpiresAt: days(2) }], now)).toEqual({ kind: "expiring", count: 2, days: 2 });
  });
  it("treats expired, revoked and past-date tokens as needing a reconnect, and that outranks expiring", () => {
    expect(connectionAlert([{ status: "expired", tokenExpiresAt: null }, { status: "active", tokenExpiresAt: days(1) }], now)).toEqual({ kind: "expired", count: 1, days: null });
    expect(connectionAlert([{ status: "active", tokenExpiresAt: days(-1) }], now)?.kind).toBe("expired");
    expect(connectionAlert([{ status: "revoked", tokenExpiresAt: null }], now)?.kind).toBe("expired");
  });
});

describe("buildAttention", () => {
  it("returns nothing when all is well", () => {
    expect(buildAttention(quiet)).toEqual([]);
  });
  it("lists every problem with a link and sorts urgent first", () => {
    const items = buildAttention({
      unassigned: 3,
      waiting: { count: 2, oldest: { id: "c", name: "Asha", waitingSeconds: 6 * 3600, assignedTo: null } },
      failedSends: 4,
      rejectedTemplates: { count: 1, names: ["diwali_offer"] },
      connection: { kind: "expired", count: 1, days: null },
    });
    expect(items.map((i) => i.id)).toEqual(["waiting", "token", "unassigned", "failed", "templates"]);
    expect(items[0]).toMatchObject({ severity: "urgent", title: "2 customers waiting for a reply", detail: "The longest wait is 6 h." });
    expect(items.every((i) => i.href.startsWith("/app/"))).toBe(true);
    expect(items.find((i) => i.id === "templates")?.detail).toContain("diwali_offer");
  });
  it("only calls a wait urgent after four hours", () => {
    const wait = (s: number) => buildAttention({ ...quiet, waiting: { count: 1, oldest: { id: "c", name: "A", waitingSeconds: s, assignedTo: null } } })[0].severity;
    expect(wait(600)).toBe("warn");
    expect(wait(5 * 3600)).toBe("urgent");
  });
  it("uses singular wording for one item", () => {
    const [a] = buildAttention({ ...quiet, unassigned: 1 });
    expect(a.title).toBe("1 chat with nobody assigned");
    const [t] = buildAttention({ ...quiet, rejectedTemplates: { count: 1, names: [] } });
    expect(t.title).toBe("A template was turned down by Meta");
  });
  it("describes an expiring token with the days left", () => {
    const [a] = buildAttention({ ...quiet, connection: { kind: "expiring", count: 1, days: 3 } });
    expect(a.detail).toContain("3 days");
    expect(a.severity).toBe("warn");
  });
});

describe("ringDash", () => {
  it("fills proportionally and clamps bad input", () => {
    const full = ringDash(100, 26);
    const half = ringDash(50, 26);
    expect(full.offset).toBeCloseTo(0);
    expect(half.offset).toBeCloseTo(full.circumference / 2);
    expect(ringDash(-20, 26).percent).toBe(0);
    expect(ringDash(250, 26).percent).toBe(100);
    expect(ringDash(Number.NaN, 26).offset).toBeCloseTo(full.circumference);
  });
});

describe("welcome dialog storage", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };
  it("shows once per person", () => {
    const store = memory();
    expect(hasSeenWelcome("u1", store)).toBe(false);
    markWelcomeSeen("u1", store);
    expect(hasSeenWelcome("u1", store)).toBe(true);
    expect(hasSeenWelcome("u2", store)).toBe(false);
    expect(welcomeKey("u1")).toContain("u1");
  });
  it("never shows (and never throws) when storage is blocked", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(hasSeenWelcome("u1", broken)).toBe(true);
    expect(() => markWelcomeSeen("u1", broken)).not.toThrow();
    expect(hasSeenWelcome("u1", null)).toBe(true);
  });
});
