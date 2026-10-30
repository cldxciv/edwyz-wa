import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  membership: { findMany: vi.fn() },
  team: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));

import { ReplyTimes } from "@/components/reports/ReplyTimes";
import { memberSummary, teamLabel, teamNameProblem, type TeamRow } from "@/components/teams/helpers";
import { extraSummary, isExtraDirty, parseStages, toExtraBody, toExtraForm, validateExtraForm } from "@/components/routing/extra-helpers";
import { parseRange } from "@/lib/reports/range";
import { groupBy, responseTimes, summarise, type ResponseRow } from "@/lib/reports/response-times";
import { DEFAULT_EXTRA } from "@/lib/routing/extra";

const range = parseRange({ from: "2026-03-01", to: "2026-03-03", tz: "UTC" });
const row = (secs: number, uid: string | null = "u1", team: string | null = null, isFirst = false): ResponseRow => ({ uid, team, secs, isFirst });

describe("reply time maths", () => {
  it("summarises waits and first replies", () => {
    const s = summarise([row(60, "u1", null, true), row(120), row(600, "u2", null, true)]);
    expect(s).toMatchObject({ replies: 3, medianSeconds: 120, firstReplies: 2, firstMedianSeconds: 330 });
    expect(s.averageSeconds).toBeCloseTo(260);
    expect(summarise([])).toMatchObject({ replies: 0, medianSeconds: null, averageSeconds: null, p90Seconds: null });
  });

  it("groups by person, busiest first", () => {
    const g = groupBy([row(10, "a"), row(30, "b"), row(50, "b"), row(70, "b")], (r) => r.uid);
    expect(g.map((x) => [x.key, x.stats.replies, x.stats.medianSeconds])).toEqual([["b", 3, 50], ["a", 1, 10]]);
  });
});

describe("responseTimes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db.$queryRaw.mockResolvedValue([
      { uid: "u1", team: null, secs: 60, is_first: true },
      { uid: "u1", team: "sales", secs: 180, is_first: false },
      { uid: "u2", team: "sales", secs: 300, is_first: true },
      { uid: null, team: null, secs: Number.NaN, is_first: false },
      { uid: "u2", team: null, secs: -5, is_first: false },
    ]);
    db.membership.findMany.mockResolvedValue([{ userId: "u1", user: { name: "Asha" } }]);
    db.team.findMany.mockResolvedValue([
      { id: "def", name: "Default team", isDefault: true },
      { id: "sales", name: "Sales", isDefault: false },
    ]);
  });

  it("scopes the query to the tenant, drops unusable rows and gives agents no breakdown", async () => {
    const out = await responseTimes("t1", range, false);
    expect(out).toMatchObject({ replies: 3, medianSeconds: 180, firstReplies: 2, byAgent: null, byTeam: null, capped: false });
    expect(db.$queryRaw.mock.calls[0].slice(1)).toContain("t1");
    expect(db.membership.findMany).not.toHaveBeenCalled();
  });

  it("breaks admin results down by person and by team, naming the default team", async () => {
    const out = await responseTimes("t1", range, true);
    expect(out.byAgent).toEqual([
      { userId: "u1", name: "Asha", replies: 2, medianSeconds: 120, firstReplies: 1, firstMedianSeconds: 60 },
      { userId: "u2", name: "Former member", replies: 1, medianSeconds: 300, firstReplies: 1, firstMedianSeconds: 300 },
    ]);
    expect(out.byTeam?.map((t) => [t.teamId, t.name, t.replies])).toEqual([["sales", "Sales", 2], ["def", "Default team", 1]]);
    expect(db.membership.findMany.mock.calls[0][0].where.tenantId).toBe("t1");
    expect(db.team.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
  });
});

describe("ReplyTimes card", () => {
  const base = { replies: 4, medianSeconds: 90, averageSeconds: 200, p90Seconds: 600, firstReplies: 2, firstMedianSeconds: 45, capped: false, byAgent: null, byTeam: null };

  it("shows the headline numbers in plain words", () => {
    const html = renderToStaticMarkup(createElement(ReplyTimes, { data: base }));
    expect(html).toContain("Typical reply time");
    expect(html).toContain("2 min");
    expect(html).toContain("Across 4 customer messages");
    expect(html).not.toContain("by team member");
  });

  it("says when there are no replies yet and renders nothing without data", () => {
    expect(renderToStaticMarkup(createElement(ReplyTimes, { data: { ...base, replies: 0, medianSeconds: null, averageSeconds: null, p90Seconds: null, firstReplies: 0, firstMedianSeconds: null } }))).toContain("No replies yet");
    expect(renderToStaticMarkup(createElement(ReplyTimes, { data: null }))).toBe("");
  });

  it("shows the tables for admins", () => {
    const html = renderToStaticMarkup(
      createElement(ReplyTimes, {
        data: { ...base, byAgent: [{ userId: "u1", name: "Asha", replies: 2, medianSeconds: 60, firstReplies: 1, firstMedianSeconds: 30 }], byTeam: [{ teamId: null, name: "Default team", replies: 2, medianSeconds: 60, firstReplies: 1, firstMedianSeconds: 30 }] },
      }),
    );
    expect(html).toContain("Reply times by team member");
    expect(html).toContain("Asha");
    expect(html).toContain("Default team");
  });
});

describe("team helpers", () => {
  const team = (over: Partial<TeamRow>): TeamRow => ({ id: "t", name: "Sales", isDefault: false, memberIds: [], createdAt: "", ...over });
  const people = ["Asha", "Ben", "Chi", "Dev", "Eli"].map((name, i) => ({ userId: `u${i}`, name, email: `${name}@x.io`, role: "agent" }));

  it("summarises who is in a team", () => {
    expect(memberSummary(team({}), people)).toBe("Nobody yet");
    expect(memberSummary(team({ isDefault: true }), people)).toMatch(/Everyone/);
    expect(memberSummary(team({ memberIds: ["u0", "u1"] }), people)).toBe("Asha, Ben");
    expect(memberSummary(team({ memberIds: ["u0", "u1", "u2", "u3", "u4", "gone"] }), people)).toBe("Asha, Ben, Chi and 2 more");
  });

  it("checks team names", () => {
    const existing = [team({ id: "a", name: "Sales" })];
    expect(teamNameProblem("  ", existing)).toMatch(/name/);
    expect(teamNameProblem("sales", existing)).toMatch(/already/);
    expect(teamNameProblem("sales", existing, "a")).toBeNull();
    expect(teamNameProblem("x".repeat(61), existing)).toMatch(/60/);
    expect(teamLabel(team({ isDefault: true, name: "Default team" }))).toBe("Default team (default)");
  });
});

describe("routing rules form", () => {
  it("round-trips the saved settings", () => {
    const form = toExtraForm(DEFAULT_EXTRA);
    expect(toExtraBody(form, DEFAULT_EXTRA)).toEqual(DEFAULT_EXTRA);
    expect(isExtraDirty(form, { ...form, maskAll: true })).toBe(true);
    expect(isExtraDirty(form, toExtraForm(DEFAULT_EXTRA))).toBe(false);
  });

  it("explains problems in numbers and stages", () => {
    const form = { ...toExtraForm(DEFAULT_EXTRA), reassignOn: true, reassignMinutes: "0", reassignMoves: "50", lastOn: true, lastHours: "", stages: "A\na" };
    expect(Object.keys(validateExtraForm(form)).sort()).toEqual(["lastHours", "reassignMinutes", "reassignMoves", "stages"]);
    expect(validateExtraForm({ ...form, reassignMinutes: "15", reassignMoves: "3", lastHours: "24", stages: " New \n\nWon " })).toEqual({});
    expect(parseStages(" New \n\nWon ")).toEqual(["New", "Won"]);
  });

  it("keeps the last good number for switched-off options and sends the stage list", () => {
    const form = { ...toExtraForm(DEFAULT_EXTRA), reassignOn: false, reassignMinutes: "abc", stages: "Cold\nHot" };
    const body = toExtraBody(form, DEFAULT_EXTRA);
    expect(body.autoReassign).toEqual({ enabled: false, minutes: DEFAULT_EXTRA.autoReassign.minutes, maxMoves: DEFAULT_EXTRA.autoReassign.maxMoves });
    expect(body.leadStages).toEqual(["Cold", "Hot"]);
  });

  it("summarises what is on", () => {
    expect(extraSummary({ ...DEFAULT_EXTRA, lastAssignee: { enabled: false, withinHours: 24 } })).toBe("No extra routing rules are on.");
    expect(extraSummary({ ...DEFAULT_EXTRA, lastAssignee: { enabled: true, withinHours: 168 }, autoReassign: { enabled: true, minutes: 20, maxMoves: 3 } })).toBe("Returning customers go back to their last agent, unanswered chats move on after 20 min.");
  });
});
