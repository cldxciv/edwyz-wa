import { describe, expect, it } from "vitest";
import { audienceLine, startCopy, wizardHint } from "@/components/broadcasts/helpers";

const base = { phoneChosen: true, mode: "all" as const, tagCount: 0, pendingText: "", counting: false, eligible: 120 };

describe("audienceLine", () => {
  it("announces the count for everyone who opted in", () => {
    const line = audienceLine(base);
    expect(line.kind).toBe("count");
    expect(line.text).toMatch(/^120 people will get this message/);
  });

  it("uses the singular for one person", () => {
    expect(audienceLine({ ...base, eligible: 1 }).text).toMatch(/^1 person will/);
  });

  it("never announces a count before a tag is chosen", () => {
    const line = audienceLine({ ...base, mode: "tags", eligible: 120 });
    expect(line.kind).toBe("add-tag");
    expect(line.text).toBe("Add a tag to see how many people match.");
    expect(line.text).not.toMatch(/120/);
  });

  it("asks to press Add when text is typed but not kept", () => {
    expect(audienceLine({ ...base, mode: "tags", pendingText: " vip " }).text).toBe('Press Add to keep "vip", or clear the box, to continue.');
  });

  it("shows counting while the new tag choice is loading, and none when nobody matches", () => {
    expect(audienceLine({ ...base, mode: "tags", tagCount: 1, counting: true }).kind).toBe("counting");
    expect(audienceLine({ ...base, mode: "tags", tagCount: 1, eligible: 0 }).kind).toBe("none");
  });
});

describe("wizardHint", () => {
  const all = { ...base, step: 1, hasTemplate: false, templateUnsupported: false, confirmed: false };
  it("explains why Next is unavailable on step 1", () => {
    expect(wizardHint({ ...all, phoneChosen: false })).toMatch(/Choose a number/);
    expect(wizardHint({ ...all, mode: "tags" })).toMatch(/at least one tag/);
    expect(wizardHint({ ...all, mode: "tags", tagCount: 1, pendingText: "pu" })).toMatch(/Press Add/);
    expect(wizardHint({ ...all, counting: true })).toMatch(/Counting/);
    expect(wizardHint({ ...all, eligible: 0 })).toMatch(/opted-in/);
    expect(wizardHint(all)).toBe("");
  });

  it("explains step 2 and the confirmation tick on step 4", () => {
    expect(wizardHint({ ...all, step: 2 })).toBe("Choose a template to continue.");
    expect(wizardHint({ ...all, step: 2, hasTemplate: true, templateUnsupported: true })).toMatch(/different template/);
    expect(wizardHint({ ...all, step: 2, hasTemplate: true })).toBe("");
    expect(wizardHint({ ...all, step: 4 })).toBe("Tick the box above to send.");
    expect(wizardHint({ ...all, step: 4, confirmed: true })).toBe("");
  });
});

describe("startCopy", () => {
  const NOW = new Date(2026, 9, 27, 10, 0, 0).getTime();
  const future = new Date(NOW + 3 * 86_400_000).toISOString();

  it("says a paused broadcast that never sent starts right now", () => {
    const copy = startCopy({ name: "Friday offer", status: "paused", scheduledAt: future, total: 0, handled: 0, now: NOW });
    expect(copy.body).toMatch(/right now, not at the time it was scheduled/);
    expect(copy.confirmLabel).toBe("Send now");
  });

  it("keeps the continue wording once sending has begun", () => {
    const copy = startCopy({ name: "Friday offer", status: "paused", scheduledAt: null, total: 50, handled: 10, now: NOW });
    expect(copy.body).toMatch(/not been messaged yet/);
    expect(copy.confirmLabel).toBe("Resume sending");
    expect(copy.done).toBe("Sending resumed");
  });

  it("words scheduling and immediate sending", () => {
    expect(startCopy({ name: "A", status: "draft", scheduledAt: future, total: 5, handled: 0, now: NOW }).confirmLabel).toBe("Schedule broadcast");
    const now = startCopy({ name: "A", status: "draft", scheduledAt: null, total: 0, handled: 0, now: NOW });
    expect(now.title).toBe('Send "A" now?');
    expect(now.body).toMatch(/everyone in the audience/);
  });
});
