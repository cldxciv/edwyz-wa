import { describe, expect, it } from "vitest";
import { validateTemplateInput, variableAtEdge } from "@/lib/templates/validate";
import {
  type ButtonDraft,
  LANGUAGES,
  type TemplateDraft,
  buildComponents,
  buttonErrorTarget,
  buttonTypeAllowed,
  categoryLabel,
  countErrors,
  detectVariables,
  draftFromTemplate,
  emptyDraft,
  fillExamples,
  focusKeyAfterButtonRemoved,
  groupedButtons,
  guardedNavigationPath,
  filterTemplates,
  hasErrors,
  insertAt,
  languageLabel,
  nextVariable,
  normalizePhone,
  rejectionText,
  requiredExamples,
  slugifyTemplateName,
  templateStatusView,
  validateDraft,
} from "@/components/templates/helpers";

const draft = (over = {}) => ({ ...emptyDraft(), name: "order_update", body: "Hi {{1}}, order {{2}} is ready.", bodyExamples: ["Asha", "42"], ...over });

describe("variables", () => {
  it("detects variables and required examples", () => {
    expect(detectVariables("a {{2}} b {{1}} {{1}}")).toEqual([1, 2]);
    expect(requiredExamples("no vars")).toBe(0);
    expect(requiredExamples("{{1}} {{2}}")).toBe(2);
  });
  it("fills examples and leaves unfilled placeholders", () => {
    expect(fillExamples("Hi {{1}} {{2}}", ["Asha", ""])).toBe("Hi Asha {{2}}");
  });
});

describe("validateDraft", () => {
  it("accepts a valid draft and its components pass the server validator", () => {
    const d = draft({ header: "Hello {{1}}", headerExample: "Asha", footer: "Bye", buttons: [{ type: "QUICK_REPLY", text: "Yes", url: "", urlExample: "", phone: "" }] });
    expect(hasErrors(validateDraft(d))).toBe(false);
    expect(() => validateTemplateInput({ name: d.name, language: d.language, category: d.category, components: buildComponents(d) })).not.toThrow();
  });
  it("flags name, missing examples and button limits per field", () => {
    expect(validateDraft(draft({ name: "Bad Name" })).name).toBeTruthy();
    const e = validateDraft(draft({ bodyExamples: ["Asha"] }));
    expect(e.bodyExamples).toEqual({ 1: "Enter a sample value for this placeholder." });
    const many = Array.from({ length: 11 }, () => ({ type: "QUICK_REPLY" as const, text: "x", url: "", urlExample: "", phone: "" }));
    expect(validateDraft(draft({ buttons: many })).buttons).toMatch(/at most 10/);
    expect(validateDraft(draft({ buttons: [{ type: "URL", text: "Go", url: "http://x", urlExample: "", phone: "" }] })).buttonErrors?.[0]).toMatch(/https/);
    expect(validateDraft(draft({ body: "Hi {{2}}" })).body).toMatch(/order/i);
  });
});

describe("templateStatusView", () => {
  it("maps statuses to labels and tones", () => {
    expect(templateStatusView("approved").tone).toBe("good");
    expect(templateStatusView("pending").tone).toBe("warn");
    expect(templateStatusView("pending").label).toBe("Pending review");
    const rejected = templateStatusView("rejected", "INVALID_FORMAT");
    expect(rejected.label).toBe("Rejected");
    expect(rejected.tone).toBe("bad");
    expect(rejected.detail).not.toMatch(/INVALID_FORMAT/);
    expect(templateStatusView("draft").tone).toBe("neutral");
    expect(templateStatusView("disabled").tone).toBe("bad");
  });
});

describe("rejectionText", () => {
  it("translates Meta codes and hides empty ones", () => {
    expect(rejectionText("PROMOTIONAL")).toMatch(/Marketing/);
    expect(rejectionText("NONE")).toBeNull();
    expect(rejectionText("")).toBeNull();
    expect(rejectionText("SOMETHING_NEW")).toBe("Meta gave this reason: something new.");
  });
  it("shows a written reason as Meta wrote it: no lower-casing of names and no double full stop", () => {
    const written = rejectionText("INVALID_FORMAT: The template uses promotional language that Meta cannot approve. Rewrite the opening.");
    expect(written).toBe("Meta gave this reason: The template uses promotional language that Meta cannot approve. Rewrite the opening.");
    expect(written).not.toMatch(/\.\./);
    expect(rejectionText("Too many buttons")).toBe("Meta gave this reason: Too many buttons.");
    expect(rejectionText("SCAM")).toMatch(/^Meta thinks/);
  });
});

describe("labels", () => {
  it("shows plain category and language names", () => {
    expect(categoryLabel("UTILITY")).toBe("Utility");
    expect(categoryLabel("OTHER")).toBe("Other");
    expect(languageLabel("hi")).toBe("Hindi");
    expect(languageLabel("xx")).toBe("xx");
  });
});

describe("slugifyTemplateName", () => {
  it("makes a valid name as the user types", () => {
    expect(slugifyTemplateName("Order Update!")).toBe("order_update");
    expect(slugifyTemplateName("a-b  c")).toBe("a_b_c");
    expect(validateDraft({ ...emptyDraft(), name: slugifyTemplateName("Diwali Offer 2026"), body: "Hi" }).name).toBeUndefined();
  });
});

describe("filterTemplates", () => {
  const list = [
    { name: "order_update", status: "approved", components: [{ type: "BODY", text: "Your order shipped" }] },
    { name: "diwali_offer", status: "rejected", components: [{ type: "BODY", text: "Big sale" }] },
    { name: "welcome", status: "draft", components: [] },
  ];
  it("filters by status group and by text in name or body", () => {
    expect(filterTemplates(list, "", "all")).toHaveLength(3);
    expect(filterTemplates(list, "", "attention").map((t) => t.name)).toEqual(["diwali_offer"]);
    expect(filterTemplates(list, "SHIPPED", "all").map((t) => t.name)).toEqual(["order_update"]);
    expect(filterTemplates(list, "wel", "draft")).toHaveLength(1);
    expect(filterTemplates(list, "wel", "approved")).toHaveLength(0);
  });
});

describe("editor helpers", () => {
  it("inserts a placeholder at the caret", () => {
    expect(insertAt("Hi , welcome", 3, "{{1}}")).toEqual({ text: "Hi {{1}}, welcome", caret: 8 });
    expect(insertAt("Hi", 99, "!")).toEqual({ text: "Hi!", caret: 3 });
    expect(nextVariable("a {{1}} {{2}}")).toBe(3);
    expect(nextVariable("none")).toBe(1);
  });
  it("points a button error at the right field", () => {
    const b = { type: "URL" as const, text: "Go", url: "http://x", urlExample: "", phone: "" };
    expect(buttonErrorTarget({ ...b, text: "" })).toBe("text");
    expect(buttonErrorTarget(b)).toBe("url");
    expect(buttonErrorTarget({ ...b, url: "https://x/{{1}}" })).toBe("urlExample");
    expect(buttonErrorTarget({ ...b, type: "PHONE_NUMBER" })).toBe("phone");
  });
  it("counts every invalid field", () => {
    const d: TemplateDraft = { ...emptyDraft(), name: "", body: "Hi {{1}} {{2}} thanks", bodyExamples: [], buttons: [{ type: "QUICK_REPLY", text: "", url: "", urlExample: "", phone: "" }] };
    expect(countErrors(validateDraft(d))).toBe(4);
    expect(countErrors({})).toBe(0);
  });
});

describe("unsaved changes guard", () => {
  const origin = "https://wa.edwyz.com";
  const here = "/app/templates/new";
  it("guards plain in-app link clicks", () => {
    expect(guardedNavigationPath({ href: "/app/contacts?x=1" }, origin, here)).toBe("/app/contacts?x=1");
    expect(guardedNavigationPath({ href: "https://wa.edwyz.com/app/templates#top" }, origin, here)).toBe("/app/templates#top");
  });
  it("lets new tabs, downloads, modifier clicks, same page and other sites through", () => {
    expect(guardedNavigationPath({ href: "/app", target: "_blank" }, origin, here)).toBeNull();
    expect(guardedNavigationPath({ href: "/app", download: true }, origin, here)).toBeNull();
    expect(guardedNavigationPath({ href: "/app", modified: true }, origin, here)).toBeNull();
    expect(guardedNavigationPath({ href: "/app", button: 1 }, origin, here)).toBeNull();
    expect(guardedNavigationPath({ href: "/app", defaultPrevented: true }, origin, here)).toBeNull();
    expect(guardedNavigationPath({ href: "#preview" }, origin, here)).toBeNull();
    expect(guardedNavigationPath({ href: "https://example.com/x" }, origin, here)).toBeNull();
  });
});

describe("focusKeyAfterButtonRemoved", () => {
  it("prefers the previous button, then the new first button, then Add button", () => {
    expect(focusKeyAfterButtonRemoved(2, 2)).toBe("remove-button-1");
    expect(focusKeyAfterButtonRemoved(0, 2)).toBe("remove-button-0");
    expect(focusKeyAfterButtonRemoved(1, 1)).toBe("remove-button-0");
    expect(focusKeyAfterButtonRemoved(0, 0)).toBe("add-button");
  });
});

const button = (type: ButtonDraft["type"], text: string, extra: Partial<ButtonDraft> = {}): ButtonDraft => ({ type, text, url: "", urlExample: "", phone: "", ...extra });
const serverAccepts = (d: TemplateDraft) => () => validateTemplateInput({ name: d.name, language: d.language, category: d.category, components: buildComponents(d) });

describe("rules Meta checks, caught in the form", () => {
  it("refuses a body that starts or ends with a placeholder, in the form and on the server", () => {
    expect(variableAtEdge("{{1}} your order is ready")).toBe(true);
    expect(variableAtEdge("Your order is ready {{1}}  ")).toBe(true);
    expect(variableAtEdge("Hi {{1}}, your order is ready.")).toBe(false);
    const d = draft({ body: "{{1}} your order is ready {{2}}" });
    expect(validateDraft(d).body).toMatch(/starts or ends with a placeholder/);
    expect(serverAccepts(d)).toThrow(/start or end with a variable/);
  });
  it("accepts phone numbers with spaces or dashes and sends them without", () => {
    expect(normalizePhone("+91 98765 43210")).toBe("+919876543210");
    expect(normalizePhone("+91-98765-43210")).toBe("+919876543210");
    const d = draft({ buttons: [button("PHONE_NUMBER", "Call us", { phone: "+91 98765 43210" })] });
    expect(validateDraft(d).buttonErrors).toBeUndefined();
    expect(JSON.stringify(buildComponents(d))).toContain('"phone_number":"+919876543210"');
    expect(serverAccepts(d)).not.toThrow();
    expect(validateDraft(draft({ buttons: [button("PHONE_NUMBER", "Call", { phone: "98765 43210" })] })).buttonErrors?.[0]).toMatch(/\+ and the country code/);
  });
  it("checks the website and call button limits before saving", () => {
    const urls = [1, 2, 3].map((n) => button("URL", `Site ${n}`, { url: "https://example.com" }));
    expect(validateDraft(draft({ buttons: urls })).buttons).toMatch(/at most 2 website buttons/);
    const calls = [button("PHONE_NUMBER", "A", { phone: "+919876543210" }), button("PHONE_NUMBER", "B", { phone: "+919876543211" })];
    expect(validateDraft(draft({ buttons: calls })).buttons).toMatch(/at most 1 call button/);
    expect(buttonTypeAllowed(urls.slice(0, 2), 0, "URL")).toBe(true);
    expect(buttonTypeAllowed([...urls.slice(0, 2), button("QUICK_REPLY", "Yes")], 2, "URL")).toBe(false);
    expect(buttonTypeAllowed([calls[0], button("QUICK_REPLY", "Yes")], 1, "PHONE_NUMBER")).toBe(false);
  });
  it("keeps quick replies together so a mixed order still passes Meta's grouping rule", () => {
    const mixed = [button("QUICK_REPLY", "Yes"), button("URL", "Site", { url: "https://example.com" }), button("QUICK_REPLY", "No")];
    expect(groupedButtons(mixed).map((b) => b.text)).toEqual(["Yes", "No", "Site"]);
    expect(groupedButtons([mixed[1], mixed[0]]).map((b) => b.text)).toEqual(["Site", "Yes"]);
    const d = draft({ buttons: mixed });
    expect(validateDraft(d).buttons).toBeUndefined();
    expect(serverAccepts(d)).not.toThrow();
  });
  it("offers the main Indian languages", () => {
    const codes = LANGUAGES.map(([c]) => c);
    for (const code of ["hi", "mr", "ta", "te", "bn", "gu", "kn", "ml", "pa", "ur"]) expect(codes).toContain(code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("authentication templates", () => {
  const auth = (over: Partial<TemplateDraft> = {}): TemplateDraft => ({ ...emptyDraft(), name: "login_code", category: "AUTHENTICATION", ...over });
  it("build Meta's fixed one-time-code shape that the server accepts", () => {
    const d = auth({ body: "ignored free text", header: "ignored", buttons: [button("URL", "Site", { url: "https://x.com" })] });
    expect(hasErrors(validateDraft(d))).toBe(false);
    expect(buildComponents(d)).toEqual([
      { type: "BODY", add_security_recommendation: true },
      { type: "FOOTER", code_expiration_minutes: 10 },
      { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "Copy code" }] },
    ]);
    expect(serverAccepts(d)).not.toThrow();
    expect(buildComponents(auth({ codeExpiry: "" })).some((c) => c.type === "FOOTER")).toBe(false);
  });
  it("flag a bad expiry or button label", () => {
    expect(validateDraft(auth({ codeExpiry: "91" })).codeExpiry).toMatch(/1 to 90/);
    expect(validateDraft(auth({ copyCodeLabel: " " })).copyCodeLabel).toBeTruthy();
  });
  it("are refused by the server with free text, a header or other buttons", () => {
    const base = { name: "login_code", language: "en_US", category: "AUTHENTICATION" };
    const otp = { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "Copy code" }] };
    expect(() => validateTemplateInput({ ...base, components: [{ type: "BODY", text: "Your code is {{1}}", example: { body_text: [["1"]] } }, otp] })).toThrow(/fixed message/);
    expect(() => validateTemplateInput({ ...base, components: [{ type: "HEADER", format: "TEXT", text: "Hi" }, { type: "BODY" }, otp] })).toThrow(/header/);
    expect(() => validateTemplateInput({ ...base, components: [{ type: "BODY" }, { type: "BUTTONS", buttons: [{ type: "URL", text: "Go", url: "https://x.com" }] }] })).toThrow(/copy-code/);
    expect(() => validateTemplateInput({ ...base, components: [{ type: "BODY" }] })).toThrow(/copy-code/);
  });
});

describe("draftFromTemplate", () => {
  it("turns saved components back into the same draft, so a draft or rejected template can be edited", () => {
    const d = draft({
      header: "Hello {{1}}",
      headerExample: "Asha",
      footer: "Bye",
      buttons: [button("QUICK_REPLY", "Yes"), button("URL", "Track", { url: "https://x.com/o/{{1}}", urlExample: "https://x.com/o/42" }), button("PHONE_NUMBER", "Call", { phone: "+919876543210" })],
    });
    const back = draftFromTemplate({ name: d.name, language: d.language, category: d.category, components: buildComponents(d) });
    expect(back).toEqual(d);
  });
  it("restores a media header with its file details and an authentication template's choices", () => {
    const media = draftFromTemplate({
      name: "promo",
      language: "hi",
      category: "MARKETING",
      components: [{ type: "HEADER", format: "IMAGE", example: { header_handle: ["4::abc"] } }, { type: "BODY", text: "Sale today" }],
      headerMedia: { type: "IMAGE", handle: "4::abc", mime: "image/png", filename: "sale.png" },
    });
    expect(media.headerKind).toBe("IMAGE");
    expect(media.headerMedia).toEqual({ type: "IMAGE", handle: "4::abc", mime: "image/png", filename: "sale.png" });
    const a = draftFromTemplate({
      name: "otp",
      language: "en",
      category: "AUTHENTICATION",
      components: [{ type: "BODY", add_security_recommendation: false }, { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "Copy" }] }],
    });
    expect(a).toMatchObject({ securityNote: false, codeExpiry: "", copyCodeLabel: "Copy" });
    expect(draftFromTemplate({ name: "x", language: "en", category: "ODD", components: null }).category).toBe("UTILITY");
  });
});
