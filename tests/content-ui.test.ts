import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelPreview } from "@/components/content/ChannelPreview";
import {
  addDays,
  charCounter,
  defaultSchedule,
  firstLink,
  groupByDay,
  periodTitle,
  quickSlots,
  scheduleProblem,
  shiftAnchor,
  startOfWeek,
  visibleText,
  weekDays,
  weekRange,
} from "@/components/content/calendar-helpers";
import { channelName, postStatus, toLocalInput } from "@/components/content/helpers";

const NOW = new Date(2026, 2, 11, 10, 30);

describe("week maths", () => {
  it("starts weeks on Sunday like the month grid", () => {
    expect(startOfWeek(new Date(2026, 2, 11)).getDate()).toBe(8);
    expect(startOfWeek(new Date(2026, 2, 8)).getDate()).toBe(8);
    expect(weekDays(new Date(2026, 2, 14)).map((d) => d.getDate())).toEqual([8, 9, 10, 11, 12, 13, 14]);
  });

  it("covers exactly seven days across a month boundary", () => {
    const { from, to } = weekRange(new Date(2026, 2, 31));
    expect(from.getDate()).toBe(29);
    expect(to.getMonth()).toBe(3);
    expect(to.getDate()).toBe(5);
    expect(to.getTime() - from.getTime()).toBeGreaterThanOrEqual(7 * 86_400_000 - 3_600_000);
  });

  it("shifts by weeks and clamps the day when moving between months", () => {
    expect(shiftAnchor(new Date(2026, 2, 11), "week", 1).getDate()).toBe(18);
    expect(shiftAnchor(new Date(2026, 2, 11), "week", -2).getMonth()).toBe(1);
    const jan31 = shiftAnchor(new Date(2026, 0, 31), "month", 1);
    expect([jan31.getMonth(), jan31.getDate()]).toEqual([1, 28]);
    expect(shiftAnchor(new Date(2026, 11, 15), "month", 1).getFullYear()).toBe(2027);
  });

  it("titles the period in words", () => {
    expect(periodTitle("month", new Date(2026, 2, 11), "en-GB")).toBe("March 2026");
    expect(periodTitle("week", new Date(2026, 2, 11), "en-GB")).toBe("8 Mar to 14 Mar 2026");
    expect(periodTitle("week", new Date(2026, 11, 30), "en-GB")).toContain("2026");
    expect(periodTitle("week", new Date(2026, 11, 30), "en-GB")).toMatch(/Dec 2026 to 2 Jan 2027$/);
  });

  it("adds days across months", () => {
    expect(addDays(new Date(2026, 0, 31), 1).getMonth()).toBe(1);
  });
});

describe("grouping", () => {
  it("groups by local day in time order", () => {
    const a = new Date(2026, 2, 11, 15, 0).toISOString();
    const b = new Date(2026, 2, 11, 9, 0).toISOString();
    const c = new Date(2026, 2, 12, 9, 0).toISOString();
    const map = groupByDay([{ at: a, id: "a" }, { at: c, id: "c" }, { at: b, id: "b" }]);
    expect(map.get("2026-03-11")?.map((x) => x.id)).toEqual(["b", "a"]);
    expect(map.get("2026-03-12")?.map((x) => x.id)).toEqual(["c"]);
    expect(map.size).toBe(2);
  });
});

describe("scheduling help", () => {
  it("offers only future quick times, in order", () => {
    const slots = quickSlots(NOW, "en-GB");
    expect(slots.map((s) => s.id)).toEqual(["today-evening", "tomorrow-morning", "tomorrow-evening", "next-monday"]);
    for (const s of slots) expect(new Date(s.value).getTime()).toBeGreaterThan(NOW.getTime());
    expect(slots[0].value).toBe("2026-03-11T18:00");
    expect(slots[1].value).toBe("2026-03-12T09:00");
    expect(slots[3].value).toBe("2026-03-16T09:00");
  });

  it("drops this evening once it is too close, and always finds the next Monday", () => {
    const late = quickSlots(new Date(2026, 2, 11, 17, 45), "en-GB");
    expect(late.map((s) => s.id)).not.toContain("today-evening");
    const monday = quickSlots(new Date(2026, 2, 16, 8, 0), "en-GB").find((s) => s.id === "next-monday");
    expect(monday?.value).toBe("2026-03-23T09:00");
    const sunday = quickSlots(new Date(2026, 2, 15, 8, 0), "en-GB").find((s) => s.id === "next-monday");
    expect(sunday?.value).toBe("2026-03-16T09:00");
  });

  it("defaults to nine in the morning, never in the past", () => {
    expect(defaultSchedule(undefined, NOW)).toBe("2026-03-12T09:00");
    expect(defaultSchedule("2026-03-20", NOW)).toBe("2026-03-20T09:00");
    expect(defaultSchedule("2026-03-11", new Date(2026, 2, 11, 8, 0))).toBe("2026-03-11T09:00");
    expect(defaultSchedule("2026-03-11", NOW)).toBe("2026-03-11T12:00");
    expect(defaultSchedule("garbage", NOW)).toBe("2026-03-12T09:00");
  });

  it("explains time problems in plain words", () => {
    expect(scheduleProblem("", NOW)).toBe("Choose a date and time.");
    expect(scheduleProblem("not a date", NOW)).toBe("Choose a date and time.");
    expect(scheduleProblem("2026-03-11T09:00", NOW)).toMatch(/already passed/);
    expect(scheduleProblem("2026-03-12T09:00", NOW)).toBeNull();
    expect(scheduleProblem("2026-07-01T09:00", NOW)).toBe("Posts can be scheduled up to 90 days ahead.");
  });

  it("round-trips the local input format", () => {
    expect(toLocalInput(new Date(2026, 2, 11, 9, 5).toISOString())).toBe("2026-03-11T09:05");
  });
});

describe("channel previews", () => {
  it("counts characters against the channel limit", () => {
    expect(charCounter("threads", "x".repeat(10))).toMatchObject({ used: 10, max: 500, over: false, text: "10 of 500 characters" });
    const over = charCounter("threads", "x".repeat(520));
    expect(over).toMatchObject({ over: true, remaining: -20, text: "20 over the limit" });
    expect(charCounter("instagram", "").max).toBe(2200);
  });

  it("shows only what the channel will keep", () => {
    expect(visibleText("threads", "x".repeat(600))).toHaveLength(500);
    expect(visibleText("facebook", "hello")).toBe("hello");
  });

  it("finds the link Facebook would attach", () => {
    expect(firstLink("see https://edwyz.com/a?b=1 now")).toBe("https://edwyz.com/a?b=1");
    expect(firstLink("no link")).toBeNull();
  });
});

describe("labels", () => {
  it("uses owner-friendly status wording and never raw values", () => {
    expect(postStatus("failed")).toEqual({ label: "Did not publish", tone: "bad" });
    expect(postStatus("published").tone).toBe("good");
    expect(postStatus("scheduled").tone).toBe("info");
    expect(postStatus("partial")).toEqual({ label: "Partly published", tone: "warn" });
    expect(postStatus("container")).toEqual({ label: "Preparing media", tone: "info" });
    expect(postStatus("some_new_state").label).toBe("Some new state");
  });

  it("names channels", () => {
    expect(channelName("instagram")).toBe("Instagram");
    expect(channelName("tiktok")).toBe("Tiktok");
  });
});

describe("rendered previews", () => {
  const base = { account: "Acme Pizza", whenText: "12 Mar 2026, 9:00 am" };

  it("shows Instagram's need for media and the counter", () => {
    const out = renderToStaticMarkup(createElement(ChannelPreview, { ...base, channel: "instagram", body: "Fresh pizza", mediaKey: undefined }));
    expect(out).toContain("Instagram preview");
    expect(out).toContain("need a picture or video");
    expect(out).toContain("11 of 2,200 characters");
  });

  it("tells the person when a Threads post is over the limit", () => {
    const out = renderToStaticMarkup(createElement(ChannelPreview, { ...base, channel: "threads", body: "x".repeat(510), mediaKey: undefined }));
    expect(out).toContain("10 over the limit");
    expect(out).toContain("Shorten the text");
  });

  it("explains the Facebook link preview and escapes text", () => {
    const out = renderToStaticMarkup(createElement(ChannelPreview, { ...base, channel: "facebook", body: "<i>Hi</i> https://edwyz.com/menu", mediaKey: undefined }));
    expect(out).toContain("link preview");
    expect(out).not.toContain("<i>Hi");
    expect(out).toContain("&lt;i&gt;Hi");
  });

  it("uses an image or a video element for attached media", () => {
    const img = renderToStaticMarkup(createElement(ChannelPreview, { ...base, channel: "facebook", body: "Hi", mediaKey: "a".repeat(32) + ".jpg" }));
    expect(img).toContain("<img");
    expect(img).toContain('alt="Attached picture"');
    const vid = renderToStaticMarkup(createElement(ChannelPreview, { ...base, channel: "facebook", body: "Hi", mediaKey: "a".repeat(32) + ".mp4" }));
    expect(vid).toContain("<video");
  });
});

describe("calendar chip", () => {
  it("is the containing block for its hidden status text, so the text cannot push the page wider", async () => {
    const { Chip } = await import("@/components/content/ContentView");
    const out = renderToStaticMarkup(createElement(Chip, { item: { id: "p1", name: "Diwali offer", status: "scheduled", at: "2026-03-11T09:00:00.000Z", channels: ["facebook"] }, onPick: () => {} }));
    const button = out.slice(0, out.indexOf(">") + 1);
    expect(button).toMatch(/class="[^"]*\brelative\b/);
    expect(button).toMatch(/class="[^"]*\btruncate\b/);
    expect(out).toContain('<span class="sr-only">. Scheduled.</span>');
  });
});

describe("first paint", () => {
  it("renders the calendar page and the composer without throwing", async () => {
    const { ContentView } = await import("@/components/content/ContentView");
    const { Composer } = await import("@/components/content/Composer");
    const page = renderToStaticMarkup(createElement(ContentView));
    expect(page).toContain("Content calendar");
    expect(page).toContain('role="tablist"');
    expect(page).toMatch(/Month/);
    const composer = renderToStaticMarkup(createElement(Composer, { onDone: () => {}, onCancel: () => {} }));
    expect(composer).toContain("Where should it go?");
    expect(composer).toContain("What do you want to say?");
    expect(composer).toContain("When should it go out?");
    expect(composer).toContain("Schedule post");
    expect(composer).toContain("Choose where to post.");
  });
});

describe('saving a draft without a usable time', () => {
  it('omits the time for a draft with an empty or past date box and never throws', async () => {
    const { scheduledAtField, scheduleProblem } = await import('@/components/content/calendar-helpers');
    expect(scheduledAtField('', true, scheduleProblem(''))).toEqual({});
    expect(scheduledAtField('2001-01-01T09:00', true, scheduleProblem('2001-01-01T09:00'))).toEqual({});
  });
  it('sends the time for a valid draft and for any scheduled post', async () => {
    const { scheduledAtField } = await import('@/components/content/calendar-helpers');
    expect(scheduledAtField('2030-05-01T09:00', true, null).scheduledAt).toMatch(/^2030-05-01T/);
    expect(scheduledAtField('2030-05-01T09:00', false, null).scheduledAt).toMatch(/^2030-05-01T/);
  });
});
