import { describe, expect, it } from "vitest";
import {
  connectedPageCount,
  buildTimeline,
  describeStep,
  fieldLabel,
  formatDelay,
  formatResponse,
  friendlyError,
  groupByStatus,
  leadDisplayName,
  leadStatusLabel,
  responseHighlight,
  runStateLabel,
  sequenceLength,
  sequenceScope,
  splitDelay,
  stepProblems,
  summarizeLeads,
  toMinutes,
  MAX_DELAY_MINUTES,
} from "@/components/leads/helpers";
import { findFormsMessage } from "@/components/leads/FormsView";

const NOW = new Date("2026-03-01T12:00:00Z").getTime();
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

describe("formatResponse", () => {
  it("uses plain units", () => {
    expect(formatResponse(null)).toBe("No reply yet");
    expect(formatResponse(30)).toBe("30 sec");
    expect(formatResponse(90)).toBe("2 min");
    expect(formatResponse(5400)).toBe("1.5 h");
    expect(formatResponse(172800)).toBe("2 d");
  });
});

describe("responseHighlight", () => {
  const replied = (s: number) => ({ status: "contacted", createdAt: ago(10_000), responseSeconds: s });
  it("rates answered leads by speed", () => {
    expect(responseHighlight(replied(120), NOW)).toMatchObject({ tone: "good", label: "Fast reply", attention: false });
    expect(responseHighlight(replied(1800), NOW).tone).toBe("info");
    expect(responseHighlight(replied(6 * 3600), NOW).tone).toBe("warn");
    expect(responseHighlight(replied(3 * 86400), NOW).tone).toBe("bad");
  });
  it("measures unanswered new leads against the clock and flags them", () => {
    const wait = (s: number) => responseHighlight({ status: "new", createdAt: ago(s), responseSeconds: null }, NOW);
    expect(wait(120)).toMatchObject({ tone: "info", attention: true, label: "Waiting 2 min" });
    expect(wait(40 * 60).tone).toBe("warn");
    expect(wait(3 * 3600)).toMatchObject({ tone: "bad", attention: true });
  });
  it("does not nag about old leads that were handled outside the product", () => {
    expect(responseHighlight({ status: "won", createdAt: ago(99999), responseSeconds: null }, NOW)).toMatchObject({ tone: "neutral", attention: false });
  });
});

describe("connectedPageCount", () => {
  it("counts active Pages on live connections only", () => {
    const page = (status = "active") => ({ type: "page", status });
    expect(connectedPageCount([])).toBe(0);
    expect(
      connectedPageCount([
        { status: "active", assets: [page(), page("removed"), { type: "ad_account", status: "active" }] },
        { status: "revoked", assets: [page()] },
        { status: "expired", assets: [page()] },
      ]),
    ).toBe(2);
  });
});

describe("summarizeLeads", () => {
  it("counts waiting leads and computes the median and fast share", () => {
    const items = [
      { status: "new", createdAt: ago(1), responseSeconds: null },
      { status: "contacted", createdAt: ago(1), responseSeconds: 60 },
      { status: "won", createdAt: ago(1), responseSeconds: 200 },
      { status: "lost", createdAt: ago(1), responseSeconds: 4000 },
      { status: "contacted", createdAt: ago(1), responseSeconds: 10 },
    ];
    expect(summarizeLeads(items)).toEqual({ waiting: 1, replied: 4, medianSeconds: 130, fastPercent: 75 });
  });
  it("handles an empty list", () => {
    expect(summarizeLeads([])).toEqual({ waiting: 0, replied: 0, medianSeconds: null, fastPercent: null });
  });
});

describe("groupByStatus", () => {
  it("makes a column for every stage and ignores unknown ones", () => {
    const g = groupByStatus([{ status: "new" }, { status: "new" }, { status: "won" }, { status: "mystery" }]);
    expect(Object.keys(g)).toEqual(["new", "contacted", "qualified", "won", "lost", "invalid"]);
    expect(g.new).toHaveLength(2);
    expect(g.won).toHaveLength(1);
    expect(g.contacted).toEqual([]);
  });
});

describe("labels", () => {
  it("writes statuses and answer keys for people", () => {
    expect(leadStatusLabel("invalid")).toBe("Not a real lead");
    expect(leadStatusLabel("won")).toBe("Won");
    expect(fieldLabel("full_name")).toBe("Full name");
    expect(fieldLabel("what-do-you-need")).toBe("What do you need");
    expect(runStateLabel("active")).toBe("Running");
    expect(runStateLabel("stopped")).toBe("Stopped");
    expect(leadDisplayName({ name: null, contact: { phone: "+911234567890" } })).toBe("+911234567890");
    expect(leadDisplayName({ name: null, contact: null })).toBe("Unnamed lead");
  });
});

describe("delays", () => {
  it("formats waits in words", () => {
    expect(formatDelay(0)).toBe("right away");
    expect(formatDelay(1)).toBe("1 minute");
    expect(formatDelay(90)).toBe("1 hour 30 minutes");
    expect(formatDelay(1440)).toBe("1 day");
    expect(formatDelay(1500)).toBe("1 day 1 hour");
  });
  it("splits into the largest even unit and converts back", () => {
    expect(splitDelay(0)).toEqual({ value: 0, unit: "minutes" });
    expect(splitDelay(45)).toEqual({ value: 45, unit: "minutes" });
    expect(splitDelay(120)).toEqual({ value: 2, unit: "hours" });
    expect(splitDelay(2880)).toEqual({ value: 2, unit: "days" });
    expect(toMinutes(2, "days")).toBe(2880);
    expect(toMinutes(-4, "hours")).toBe(0);
    expect(toMinutes(9999, "days")).toBe(MAX_DELAY_MINUTES);
  });
});

describe("sequence timeline", () => {
  it("accumulates waits from the moment the lead arrives", () => {
    const t = buildTimeline([{ delayMinutes: 0 }, { delayMinutes: 60 }, { delayMinutes: 1440 }]);
    expect(t.map((e) => e.at)).toEqual([0, 60, 1500]);
    expect(t[0].whenLabel).toBe("As soon as the lead arrives");
    expect(t[1].whenLabel).toBe("1 hour after the lead arrives");
    expect(t[2].waitLabel).toBe("Wait 1 day");
  });
  it("ignores a delay typed into the first step", () => {
    expect(buildTimeline([{ delayMinutes: 500 }])[0].at).toBe(0);
  });
  it("describes steps in plain words", () => {
    const templates = [{ id: "t1", name: "welcome" }];
    const chatbots = [{ id: "c1", name: "Qualifier" }];
    expect(describeStep({ templateId: "t1", chatbotId: "", stopOnReply: true }, 0, templates, chatbots)).toBe('Send the message "welcome".');
    expect(describeStep({ templateId: "t1", chatbotId: "c1", stopOnReply: true }, 1, templates, chatbots)).toBe('Send the message "welcome", then start the chatbot "Qualifier". The sequence stops here if the lead has already replied.');
    expect(describeStep({ templateId: "", chatbotId: "c1", stopOnReply: false }, 2, templates, chatbots)).toBe('Start the chatbot "Qualifier". Sent even if the lead has already replied.');
    expect(describeStep({ templateId: "", chatbotId: "", stopOnReply: true }, 0, templates, chatbots)).toBe("Choose what to send in this step.");
  });
  it("flags steps with nothing to send", () => {
    expect(stepProblems([{ templateId: "a", chatbotId: "" }, { templateId: "", chatbotId: "" }])).toEqual([{ index: 1, message: "Choose a message or a chatbot for this step." }]);
  });
  it("summarises length and scope", () => {
    expect(sequenceLength([{ delayMinutes: 0 }])).toBe("1 step");
    expect(sequenceLength([{ delayMinutes: 0 }, { delayMinutes: 60 }, { delayMinutes: 60 }])).toBe("3 steps over 2 hours");
    expect(sequenceScope(null, [])).toBe("Runs for every new lead");
    expect(sequenceScope({ leadFormId: "f1" }, [{ id: "f1", name: "Spring offer" }])).toBe('Runs for leads from the form "Spring offer"');
  });
});

describe("friendlyError", () => {
  it("keeps server messages and rewrites network failures", () => {
    expect(friendlyError(new Error("Lead not found."))).toBe("Lead not found.");
    expect(friendlyError(new TypeError("Failed to fetch"))).toMatch(/check your connection/i);
    expect(friendlyError(null, "Oops")).toBe("Oops");
  });
});

describe("finding lead forms on Facebook Pages", () => {
  it("says what was found, and which Pages could not be read", () => {
    expect(findFormsMessage(0, [])).toEqual({ tone: "warn", text: "No lead forms were found on your Facebook Pages." });
    expect(findFormsMessage(1, [])).toEqual({ tone: "good", text: "Found 1 lead form on your Facebook Pages." });
    expect(findFormsMessage(3, ["Old page: Meta did not give this workspace permission."])).toEqual({ tone: "warn", text: "Found 3 lead forms on your Facebook Pages. Some Pages could not be read: Old page: Meta did not give this workspace permission." });
  });
});
