import { describe, expect, it } from "vitest";
import { validateTemplateInput } from "@/lib/templates/validate";
import {
  type TemplateDraft,
  buildComponents,
  buttonErrorTarget,
  categoryLabel,
  countErrors,
  detectVariables,
  emptyDraft,
  fillExamples,
  focusKeyAfterButtonRemoved,
  guardedNavigationPath,
  filterTemplates,
  hasErrors,
  insertAt,
  languageLabel,
  nextVariable,
  rejectionText,
  requiredExamples,
  slugifyTemplateName,
  templateStatusView,
  validateDraft,
} from "@/components/templates/helpers";

const draft = (over = {}) => ({ ...emptyDraft(), name: "order_update", body: "Hi {{1}}, order {{2}}", bodyExamples: ["Asha", "42"], ...over });

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
    const d: TemplateDraft = { ...emptyDraft(), name: "", body: "Hi {{1}} {{2}}", bodyExamples: [], buttons: [{ type: "QUICK_REPLY", text: "", url: "", urlExample: "", phone: "" }] };
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
