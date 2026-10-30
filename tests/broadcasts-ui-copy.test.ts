import { describe, expect, it } from "vitest";
import {
  audienceLabel,
  categoryLabel,
  costSummary,
  defaultBroadcastName,
  errorCodeText,
  filterBroadcasts,
  friendlyError,
  handledCount,
  humanizeName,
  limitSummary,
  localInputValue,
  placeholderNote,
  progressText,
  recipientStatusView,
  retrySummary,
  scheduleBounds,
  templatePreview,
  unsupportedTemplateReason,
  validateSchedule,
} from "@/components/broadcasts/helpers";

const NOW = new Date(2026, 9, 27, 10, 0, 0);

describe("progress copy", () => {
  it("counts handled recipients and words the progress", () => {
    expect(handledCount({ pending: 2, queued: 1, sent: 3, failed: 1 })).toBe(4);
    expect(progressText({})).toBe("Not started");
    expect(progressText({ pending: 6, sent: 4 })).toBe("4 of 10 handled");
  });
});

describe("recipient status wording", () => {
  it("uses plain labels and keeps waiting recipients neutral", () => {
    expect(recipientStatusView("skipped").label).toBe("Not sent");
    expect(recipientStatusView("queued").label).toBe("Sending");
    expect(recipientStatusView("pending")).toEqual({ label: "Waiting", tone: "neutral" });
    expect(recipientStatusView("read").tone).toBe("good");
    expect(recipientStatusView("failed").tone).toBe("bad");
  });
});

describe("errorCodeText", () => {
  it("translates known codes and never returns the raw code", () => {
    expect(errorCodeText("131049")).toMatch(/marketing messages/);
    expect(errorCodeText("missing_variable")).toMatch(/missing/);
    expect(errorCodeText("999999")).toBe("WhatsApp could not deliver this message.");
    expect(errorCodeText("999999")).not.toMatch(/999999/);
    expect(errorCodeText(null)).toBeNull();
    expect(errorCodeText("  ")).toBeNull();
  });
});

describe("friendlyError", () => {
  it("keeps readable messages and hides technical ones", () => {
    expect(friendlyError("Template is not approved.")).toBe("Template is not approved.");
    expect(friendlyError("Your WhatsApp number is paused.")).toBe("Your WhatsApp number is paused.");
    expect(friendlyError("scheduledAt must be in the future.")).toBe("Pick a time in the future.");
    expect(friendlyError("scheduledAt can be at most 90 days ahead.")).toMatch(/90 days/);
    expect(friendlyError("PrismaClientKnownRequestError: unique constraint")).toBe("Something went wrong. Please try again.");
    expect(friendlyError("template_not_found")).toBe("Something went wrong. Please try again.");
    expect(friendlyError("", "Custom fallback")).toBe("Custom fallback");
    expect(friendlyError(null)).toBe("Something went wrong. Please try again.");
  });
});

describe("validateSchedule", () => {
  it("rejects empty, invalid, past and too-far dates", () => {
    expect(validateSchedule("", NOW)).toMatch(/Pick a date/);
    expect(validateSchedule("not a date", NOW)).toMatch(/valid/);
    expect(validateSchedule(localInputValue(new Date(NOW.getTime() - 3600_000)), NOW)).toMatch(/future/);
    expect(validateSchedule(localInputValue(new Date(NOW.getTime() + 20_000)), NOW)).toMatch(/future/);
    expect(validateSchedule(localInputValue(new Date(NOW.getTime() + 91 * 86_400_000)), NOW)).toMatch(/90 days/);
  });

  it("accepts a time inside the window", () => {
    expect(validateSchedule(localInputValue(new Date(NOW.getTime() + 3 * 3600_000)), NOW)).toBeNull();
    expect(validateSchedule(localInputValue(new Date(NOW.getTime() + 89 * 86_400_000)), NOW)).toBeNull();
  });

  it("formats bounds for a datetime-local input", () => {
    const { min, max } = scheduleBounds(NOW);
    expect(min).toBe("2026-10-27T10:00");
    expect(max).toBe(localInputValue(new Date(NOW.getTime() + 90 * 86_400_000)));
    expect(min).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});

describe("costSummary", () => {
  it("never invents a number when the rate card is missing", () => {
    const missing = costSummary({ configured: false });
    expect(missing.configured).toBe(false);
    expect(missing.headline).toBe("Not available yet");
    expect(missing.note).toMatch(/Meta billing/);
    expect(costSummary(undefined).headline).toBe("Not available yet");
    expect(costSummary({ configured: true }).configured).toBe(false);
  });

  it("shows an estimate when configured", () => {
    const set = costSummary({ configured: true, totalPaise: 25000 });
    expect(set.configured).toBe(true);
    expect(set.headline).toMatch(/^About .*250/);
    expect(set.note).toMatch(/estimate/);
  });
});

describe("limitSummary", () => {
  it("describes known, unlimited and unknown limits", () => {
    expect(limitSummary({ known: false })).toMatch(/not told us/);
    expect(limitSummary({ known: true, limit: 1000, used: 250, unlimited: false })).toBe("250 of 1,000 people messaged in the last 24 hours. Room for 750 more.");
    expect(limitSummary({ known: true, limit: 1000, used: 1200, unlimited: false })).toMatch(/Room for 0 more/);
    expect(limitSummary({ known: true, limit: Infinity, used: 5, unlimited: true })).toMatch(/no limit/);
  });
});

describe("filterBroadcasts", () => {
  const items = [
    { name: "Diwali offer", status: "completed" },
    { name: "Winter sale", status: "draft" },
    { name: "Diwali reminder", status: "scheduled" },
  ];
  it("filters by name and status", () => {
    expect(filterBroadcasts(items, "", "all")).toHaveLength(3);
    expect(filterBroadcasts(items, "  DIWALI ", "all")).toHaveLength(2);
    expect(filterBroadcasts(items, "diwali", "scheduled").map((b) => b.name)).toEqual(["Diwali reminder"]);
    expect(filterBroadcasts(items, "", "paused")).toEqual([]);
  });
});

describe("names and labels", () => {
  it("humanizes template names and categories", () => {
    expect(humanizeName("order_update")).toBe("Order update");
    expect(humanizeName("summer-sale_2026")).toBe("Summer sale 2026");
    expect(categoryLabel("MARKETING")).toBe("Marketing");
    expect(categoryLabel("")).toBe("");
  });

  it("builds a default broadcast name with the date", () => {
    expect(defaultBroadcastName("order_update", NOW)).toMatch(/^Order update, 27 Oct 2026$/);
    expect(defaultBroadcastName(undefined, NOW)).toMatch(/^Broadcast, /);
  });

  it("labels the audience", () => {
    expect(audienceLabel([])).toBe("Everyone who opted in");
    expect(audienceLabel(["vip", "pune"])).toBe("Contacts tagged vip, pune");
    expect(retrySummary(0)).toMatch(/not retried/);
    expect(retrySummary(1)).toMatch(/1 day$/);
    expect(retrySummary(3)).toMatch(/3 days$/);
  });
});

describe("template helpers", () => {
  const components = [
    { type: "HEADER", format: "TEXT", text: "Hello" },
    { type: "BODY", text: "Hi {{1}}, your order is ready." },
    { type: "FOOTER", text: "Edwyz" },
    { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Thanks" }, { type: "URL", text: "Track", url: "https://x.test/t" }] },
  ];

  it("extracts a preview", () => {
    expect(templatePreview(components)).toEqual({ header: "Hello", body: "Hi {{1}}, your order is ready.", footer: "Edwyz", buttons: ["Thanks", "Track"] });
    expect(templatePreview(null)).toEqual({ header: null, body: "", footer: null, buttons: [] });
  });

  it("explains placeholders only when the body has them", () => {
    expect(placeholderNote(components)).toMatch(/contact's name/);
    expect(placeholderNote([{ type: "BODY", text: "Plain text" }])).toBeNull();
  });

  it("flags only templates that broadcasts cannot send", () => {
    expect(unsupportedTemplateReason(components)).toBeNull();
    expect(unsupportedTemplateReason([{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "x" }])).toBeNull();
    expect(unsupportedTemplateReason([{ type: "HEADER", format: "TEXT", text: "Hi {{1}}" }, { type: "BODY", text: "x" }])).toBeNull();
    expect(unsupportedTemplateReason([{ type: "BODY", text: "x" }, { type: "BUTTONS", buttons: [{ type: "URL", text: "Go", url: "https://x.test/{{1}}" }] }])).toBeNull();
    expect(unsupportedTemplateReason([{ type: "HEADER", format: "LOCATION" }, { type: "BODY", text: "x" }])).toMatch(/header type/);
    expect(unsupportedTemplateReason([{ type: "BODY", text: "x" }, { type: "CAROUSEL", cards: [] }])).toMatch(/Carousel/);
  });
});
