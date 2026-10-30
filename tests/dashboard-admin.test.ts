import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/auth", () => ({ getActor: vi.fn() }));

import { DEFAULT_TEST_TEXT, maskRecipient, normalizeRecipient, parseTestMessageInput } from "@/lib/admin/testMessage";
import { isPlatformAdminEmail, parseAdminEmails } from "@/lib/admin/auth";
import { computeChecklist, countLabel } from "@/components/dashboard/checklist";

const base = { onboardingLive: false, paymentMarkedDone: false, submittedTemplates: 0, optedInContacts: 0, startedBroadcasts: 0 };
const states = (i: Parameters<typeof computeChecklist>[0]) => computeChecklist(i).map((x) => x.state);

describe("checklist", () => {
  it("starts with connect as the current step and the rest locked", () => {
    expect(states(base)).toEqual(["current", "locked", "locked", "locked", "locked"]);
  });
  it("moves to payment once live", () => {
    expect(states({ ...base, onboardingLive: true })).toEqual(["done", "current", "locked", "locked", "locked"]);
  });
  it("payment cannot be done before the number is live", () => {
    expect(states({ ...base, paymentMarkedDone: true })[1]).not.toBe("done");
  });
  it("advances through template, contacts and broadcast", () => {
    const live = { ...base, onboardingLive: true, paymentMarkedDone: true };
    expect(states(live)).toEqual(["done", "done", "current", "locked", "locked"]);
    expect(states({ ...live, submittedTemplates: 1, optedInContacts: 5, startedBroadcasts: 1 })).toEqual(["done", "done", "done", "done", "done"]);
  });
  it("links the payment step to WhatsApp Manager", () => {
    expect(computeChecklist(base)[1]).toMatchObject({ href: "https://business.facebook.com/wa/manage/home/", external: true, manual: true });
  });
  it("labels capped counts", () => {
    expect(countLabel(100, true)).toBe("100+");
    expect(countLabel(3, false)).toBe("3");
  });
});

describe("admin authorisation", () => {
  it("matches listed emails case-insensitively", () => {
    expect(parseAdminEmails(" A@x.com, b@y.com ,")).toEqual(["a@x.com", "b@y.com"]);
    expect(isPlatformAdminEmail("A@X.com", "a@x.com,b@y.com")).toBe(true);
  });
  it("denies unlisted, empty and missing", () => {
    expect(isPlatformAdminEmail("c@z.com", "a@x.com")).toBe(false);
    expect(isPlatformAdminEmail("a@x.com", "")).toBe(false);
    expect(isPlatformAdminEmail("a@x.com", undefined)).toBe(false);
    expect(isPlatformAdminEmail(null, "a@x.com")).toBe(false);
  });
});

describe("test message input", () => {
  it("normalizes and validates recipients", () => {
    expect(normalizeRecipient("+91 98765-43210")).toBe("919876543210");
    expect(normalizeRecipient("12345")).toBeNull();
    expect(normalizeRecipient("abc")).toBeNull();
    expect(maskRecipient("919876543210")).toBe("********3210");
  });
  it("parses input and rejects bad values", () => {
    expect(parseTestMessageInput({ phoneNumberRef: "abc123", to: "+919876543210", mode: "text", text: " hello " })).toMatchObject({ to: "919876543210", text: "hello", mode: "text" });
    expect(() => parseTestMessageInput({ phoneNumberRef: "bad ref!", to: "+919876543210" })).toThrow();
    expect(() => parseTestMessageInput({ phoneNumberRef: "abc", to: "nope" })).toThrow();
    expect(() => parseTestMessageInput({ phoneNumberRef: "abc", to: "919876543210", text: "x".repeat(1001) })).toThrow();
    expect(parseTestMessageInput({ phoneNumberRef: "abc", to: "919876543210", text: "  " }).text).toBe(DEFAULT_TEST_TEXT);
  });
  it("template mode needs a template id and carries no hard-coded template", () => {
    expect(parseTestMessageInput({ phoneNumberRef: "abc", to: "+919876543210", mode: "template", templateId: "tpl_1" })).toEqual({ phoneNumberRef: "abc", to: "919876543210", mode: "template", text: "", templateId: "tpl_1" });
    expect(() => parseTestMessageInput({ phoneNumberRef: "abc", to: "+919876543210", mode: "template" })).toThrow(/Choose a template/);
    expect(() => parseTestMessageInput({ phoneNumberRef: "abc", to: "+919876543210", mode: "template", templateId: "bad id!" })).toThrow(/Choose a template/);
    expect(parseTestMessageInput({ phoneNumberRef: "abc", to: "+919876543210", mode: "text", templateId: "tpl_1" })).not.toHaveProperty("templateId");
  });
});
