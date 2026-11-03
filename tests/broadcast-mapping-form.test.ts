import { describe, expect, it } from "vitest";
import { choiceLabel, choicesFor, cleanMap, defaultMap, firstMappingProblem, fromChoice, mappingProblems, templateSlots } from "@/components/broadcasts/mappingForm";
import { deleteWarning, type TemplateRow } from "@/components/templates/TemplatesView";
import { accountLabel } from "@/components/templates/TemplateEditor";

const now = new Date("2026-10-30T10:00:00Z");
const image = [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hi {{first_name}}, {{order_id}} is ready" }, { type: "BUTTONS", buttons: [{ type: "COPY_CODE", text: "Copy code" }] }];
const slots = templateSlots(image);

describe("value mapping form: uploads, named placeholders and coupon codes", () => {
  it("starts with an upload for the header file, the matching detail for a named placeholder and an empty code", () => {
    expect(defaultMap(slots)).toEqual({
      header: { source: "upload", value: "" },
      first_name: { source: "field", key: "first_name" },
      order_id: { source: "attribute", key: "order_id" },
      "button:0": { source: "static", value: "" },
    });
    expect(firstMappingProblem(slots, defaultMap(slots), "skip")).toBe("Header image: Upload the file to send.");
  });

  it("offers codes for a coupon button and words each choice for its slot", () => {
    const coupon = slots.find((s) => s.kind === "button_copy_code")!;
    expect(choicesFor(coupon)).toEqual(["static", "attribute"]);
    expect(choiceLabel(coupon, "static")).toBe("The same code for everyone");
    expect(choiceLabel(slots[0], "upload")).toBe("A file I upload");
    expect(choiceLabel(slots[1], "attribute")).toBe("A detail saved on the contact");
  });

  it("checks an uploaded file against the sending number and its 30 days at WhatsApp", () => {
    const fresh = { source: "upload" as const, value: "123", filename: "a.jpg", uploadedAt: new Date(now.getTime() - 86_400_000).toISOString(), phoneNumberId: "p1" };
    const base = { ...defaultMap(slots), "button:0": { source: "static" as const, value: "SAVE20" } };
    expect(mappingProblems(slots, { ...base, header: fresh }, "skip", { phoneNumberId: "p1", now })).toEqual({});
    expect(mappingProblems(slots, { ...base, header: fresh }, "skip", { phoneNumberId: "p2", now }).header).toMatch(/another number/);
    const old = { ...fresh, uploadedAt: new Date(now.getTime() - 31 * 86_400_000).toISOString() };
    expect(mappingProblems(slots, { ...base, header: old }, "skip", { phoneNumberId: "p1", now }).header).toMatch(/30 days/);
    // An uploaded file is the same for everyone, so the fallback policy asks no fallback for it.
    expect(mappingProblems(slots, { ...base, header: fresh }, "fallback", { phoneNumberId: "p1", now }).header).toBeUndefined();
  });

  it("refuses a coupon code WhatsApp would refuse", () => {
    const base = defaultMap(slots);
    expect(mappingProblems(slots, { ...base, "button:0": { source: "static", value: "" } }, "skip")["button:0"]).toBe("Enter the code to send.");
    expect(mappingProblems(slots, { ...base, "button:0": { source: "static", value: "50% OFF" } }, "skip")["button:0"]).toMatch(/letters and numbers/);
    expect(mappingProblems(slots, { ...base, "button:0": { source: "attribute", key: "coupon", fallback: "no spaces!" } }, "fallback")["button:0"]).toMatch(/letters and numbers/);
  });

  it("keeps the upload details when switching back to it and sends them to the server", () => {
    const uploaded = { source: "upload" as const, value: "123", filename: "a.jpg", uploadedAt: now.toISOString(), phoneNumberId: "p1" };
    expect(fromChoice("upload", uploaded)).toEqual(uploaded);
    expect(fromChoice("upload", { source: "static", value: "https://x.example/a.png" })).toEqual({ source: "upload", value: "" });
    expect(cleanMap(slots, { header: uploaded })).toEqual({ header: uploaded });
  });
});

describe("template list and editor helpers", () => {
  const row = (over: Partial<TemplateRow>): TemplateRow => ({ id: "t1", name: "promo", language: "en", category: "MARKETING", status: "approved", rejectionReason: null, components: [], wabaRefId: "w1", metaTemplateId: "m1", ...over });

  it("warns that a delete by name removes every language when Meta's id is unknown", () => {
    const en = row({ metaTemplateId: null });
    const hi = row({ id: "t2", language: "hi", metaTemplateId: null });
    expect(deleteWarning(en, [en, hi])).toMatch(/every language, so the other language \(.+\) will be deleted too/);
    expect(deleteWarning(row({}), [row({}), hi])).not.toMatch(/every language/);
    expect(deleteWarning(row({ status: "draft" }), [])).toBe("This draft will be removed.");
    // Another account's template of the same name is not touched.
    expect(deleteWarning(en, [en, { ...hi, wabaRefId: "w2" }])).not.toMatch(/every language/);
  });

  it("names a WhatsApp account by its name and numbers", () => {
    expect(accountLabel({ id: "w1", name: "Main", numbers: ["+91 1", "+91 2"], isDefault: true })).toBe("Main (+91 1, +91 2)");
    expect(accountLabel({ id: "w2", name: null, numbers: [], isDefault: false })).toBe("WhatsApp account (no number yet)");
  });
});
