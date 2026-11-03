import { describe, expect, it } from "vitest";
import { broadcastSupportReason, isLoginCodeTemplate } from "@/lib/broadcasts/components";
import {
  type VariableMap,
  buildRecipientComponents,
  cleanParam,
  countMissing,
  isHttpsUrl,
  needsMapping,
  nextUploadRefresh,
  parsePolicy,
  parseVariableMap,
  templateSlots,
  uploadUsable,
  uploadedKeys,
} from "@/lib/broadcasts/mapping";

const body = { type: "BODY", text: "Hi {{1}}, order {{2}} is ready" };
const textOnly = [body];
const imageHeader = [{ type: "HEADER", format: "IMAGE" }, body, { type: "BUTTONS", buttons: [{ type: "URL", text: "Track", url: "https://shop.example/t/{{1}}" }, { type: "QUICK_REPLY", text: "Thanks" }] }];

describe("templateSlots", () => {
  it("lists body placeholders in order", () => {
    expect(templateSlots(textOnly).map((s) => s.key)).toEqual(["1", "2"]);
    expect(needsMapping(textOnly)).toBe(false);
  });
  it("adds header media and URL-button slots", () => {
    const slots = templateSlots(imageHeader);
    expect(slots.map((s) => `${s.kind}:${s.key}`)).toEqual(["header_media:header", "body:1", "body:2", "button_url:button:0"]);
    expect(needsMapping(imageHeader)).toBe(true);
  });
  it("adds a header text placeholder slot", () => {
    expect(templateSlots([{ type: "HEADER", format: "TEXT", text: "Hello {{1}}" }]).map((s) => s.kind)).toEqual(["header_text"]);
  });
});

describe("parsePolicy and parseVariableMap", () => {
  it("defaults to skip and rejects unknown policies", () => {
    expect(parsePolicy(undefined)).toBe("skip");
    expect(parsePolicy("fallback")).toBe("fallback");
    expect(() => parsePolicy("ignore")).toThrow(/missing/);
  });
  it("returns null when nothing is mapped on a body-only template", () => {
    expect(parseVariableMap(undefined, textOnly, "skip")).toBeNull();
  });
  it("requires header and button slots to be mapped", () => {
    expect(() => parseVariableMap({}, imageHeader, "skip")).toThrow(/Header image/);
  });
  it("rejects placeholders the template does not have", () => {
    expect(() => parseVariableMap({ "9": { source: "static", value: "x" } }, textOnly, "skip")).toThrow(/does not have/);
  });
  it("requires a https link for a fixed media header and no contact detail", () => {
    const base = { "1": { source: "field", key: "name" }, "2": { source: "attribute", key: "order" }, "button:0": { source: "attribute", key: "code" } };
    expect(() => parseVariableMap({ ...base, header: { source: "static", value: "http://x.example/a.png" } }, imageHeader, "skip")).toThrow(/https/);
    expect(() => parseVariableMap({ ...base, header: { source: "field", key: "name" } }, imageHeader, "skip")).toThrow(/link/);
    const ok = parseVariableMap({ ...base, header: { source: "static", value: "https://cdn.example/a.png" } }, imageHeader, "skip");
    expect(ok?.header).toEqual({ source: "static", value: "https://cdn.example/a.png" });
  });
  it("needs a fallback for every non-fixed value under the fallback policy", () => {
    const map = { "1": { source: "field", key: "first_name" }, "2": { source: "static", value: "soon" } };
    expect(() => parseVariableMap(map, textOnly, "fallback")).toThrow(/fallback/);
    const ok = parseVariableMap({ ...map, "1": { source: "field", key: "first_name", fallback: "there" } }, textOnly, "fallback");
    expect(ok?.["1"].fallback).toBe("there");
  });
  it("rejects bad attribute keys and unknown contact details", () => {
    expect(() => parseVariableMap({ "1": { source: "attribute", key: "a/b" }, "2": { source: "static", value: "x" } }, textOnly, "skip")).toThrow(/attribute/);
    expect(() => parseVariableMap({ "1": { source: "field", key: "email" }, "2": { source: "static", value: "x" } }, textOnly, "skip")).toThrow(/contact detail/);
  });
  it("accepts only public https links", () => {
    expect(isHttpsUrl("https://cdn.example.com/a.png")).toBe(true);
    for (const bad of ["http://a.example/x", "https://localhost/x", "https://user:pw@a.example/x", "https://a.example/a b", "javascript:alert(1)"]) expect(isHttpsUrl(bad)).toBe(false);
  });
});

describe("buildRecipientComponents", () => {
  const map: VariableMap = {
    "1": { source: "field", key: "first_name", fallback: "there" },
    "2": { source: "attribute", key: "order", fallback: "your order" },
    header: { source: "attribute", key: "photo" },
    "button:0": { source: "attribute", key: "code" },
  };
  const full = { name: "Asha Rao", phone: "+919876543210", attributes: { order: "A-17", photo: "https://cdn.example/a.png", code: "x y" } };

  it("fills header media, body and URL button per recipient", () => {
    const built = buildRecipientComponents(imageHeader, full, map, "skip");
    expect(built).toEqual({
      ok: true,
      components: [
        { type: "header", parameters: [{ type: "image", image: { link: "https://cdn.example/a.png" } }] },
        { type: "body", parameters: [{ type: "text", text: "Asha" }, { type: "text", text: "A-17" }] },
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "x%20y" }] },
      ],
    });
  });
  it("cleans newlines, tabs and long runs of spaces from values", () => {
    expect(cleanParam("a\n\tb    c")).toBe("a b c");
  });
  it("skip policy reports the missing slots and uses no fallback", () => {
    const built = buildRecipientComponents(imageHeader, { name: "Asha", attributes: {} }, map, "skip");
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.missing).toEqual(["Header image", "Message placeholder {{2}}", 'Link placeholder for the "Track" button']);
  });
  it("fallback policy fills what is missing", () => {
    const built = buildRecipientComponents(textOnly, { name: null, attributes: {} }, { "1": map["1"], "2": map["2"] }, "fallback");
    expect(built).toEqual({ ok: true, components: [{ type: "body", parameters: [{ type: "text", text: "there" }, { type: "text", text: "your order" }] }] });
  });
  it("rejects a media link that is not https, even from an attribute", () => {
    const built = buildRecipientComponents(imageHeader, { ...full, attributes: { ...full.attributes, photo: "http://x.example/a.png" } }, map, "skip");
    expect(built.ok).toBe(false);
  });
  it("keeps the old behaviour without a map: attribute named by the number, name for {{1}}", () => {
    expect(buildRecipientComponents(textOnly, { name: "Asha", attributes: { "2": "42" } }, null, "skip")).toEqual({
      ok: true,
      components: [{ type: "body", parameters: [{ type: "text", text: "Asha" }, { type: "text", text: "42" }] }],
    });
    expect(buildRecipientComponents(textOnly, { name: "Asha", attributes: {} }, null, "skip").ok).toBe(false);
  });
  it("sends no components for a template without placeholders", () => {
    expect(buildRecipientComponents([{ type: "BODY", text: "Hello" }], { name: null, attributes: null }, null, "skip")).toEqual({ ok: true, components: [] });
  });
});

describe("countMissing", () => {
  it("counts people and slots for the coverage warning", () => {
    const contacts = [
      { name: "A", attributes: { "2": "x" } },
      { name: "B", attributes: {} },
      { name: null, attributes: {} },
    ];
    const out = countMissing(textOnly, contacts, null, "skip");
    expect(out.contactsMissing).toBe(2);
    expect(out.bySlot).toEqual(expect.arrayContaining([{ label: "Message placeholder {{2}}", count: 2 }, { label: "Message placeholder {{1}}", count: 1 }]));
  });
});

describe("broadcastSupportReason", () => {
  it("allows text, image, video and document headers and URL variables", () => {
    expect(broadcastSupportReason(imageHeader)).toBeNull();
    expect(broadcastSupportReason([{ type: "HEADER", format: "VIDEO" }, body])).toBeNull();
    expect(broadcastSupportReason([{ type: "HEADER", format: "DOCUMENT" }, body])).toBeNull();
  });
  it("still refuses location headers, carousels and limited-time offers", () => {
    expect(broadcastSupportReason([{ type: "HEADER", format: "LOCATION" }, body])).toMatch(/header type/);
    expect(broadcastSupportReason([body, { type: "CAROUSEL" }])).toMatch(/Carousel/);
  });
  it("allows named placeholders and coupon codes, and greys out what Meta would refuse", () => {
    expect(broadcastSupportReason([{ type: "BODY", text: "Hi {{first_name}}" }, { type: "BUTTONS", buttons: [{ type: "COPY_CODE", example: "SAVE20" }] }])).toBeNull();
    expect(broadcastSupportReason([{ type: "BODY", text: "Hi {{first_name}}, order {{1}}" }])).toMatch(/mixes numbered and named/);
    expect(broadcastSupportReason([{ type: "BODY", text: "{{1}} is your code" }, { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE" }] }])).toMatch(/Login-code/);
    const synced = [{ type: "BUTTONS", buttons: [{ type: "URL", text: "Copy code", url: "https://www.whatsapp.com/otp/code/?otp_type=COPY_CODE&code=otp{{1}}" }] }];
    expect(broadcastSupportReason([{ type: "BODY", text: "{{1}} is your code" }, ...synced])).toMatch(/Login-code/);
    expect(broadcastSupportReason([body, { type: "BUTTONS", buttons: [{ type: "FLOW", text: "Book" }] }])).toMatch(/form button/);
    expect(broadcastSupportReason([body, { type: "BUTTONS", buttons: [{ type: "CATALOG", text: "View" }] }])).toMatch(/catalog button/);
    expect(broadcastSupportReason([body, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Yes" }, { type: "PHONE_NUMBER", text: "Call", phone_number: "+911" }] }])).toBeNull();
  });
  it("lets a message to one person (the compat API) use a login-code template, and nothing else it refuses", () => {
    const local = [{ type: "BODY", add_security_recommendation: true }, { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "Copy code" }] }];
    const synced = [{ type: "BODY", text: "{{1}} is your code" }, { type: "BUTTONS", buttons: [{ type: "URL", text: "Copy code", url: "https://www.whatsapp.com/otp/code/?otp_type=COPY_CODE&code=otp{{1}}" }] }];
    expect(broadcastSupportReason(local, { allowLoginCode: true })).toBeNull();
    expect(broadcastSupportReason(synced, { allowLoginCode: true })).toBeNull();
    expect(broadcastSupportReason(local)).toMatch(/Login-code/);
    expect(broadcastSupportReason([body, { type: "BUTTONS", buttons: [{ type: "FLOW", text: "Book" }] }], { allowLoginCode: true })).toMatch(/form button/);
    expect(broadcastSupportReason([{ type: "BODY", text: "Hi {{first_name}}, order {{1}}" }], { allowLoginCode: true })).toMatch(/mixes numbered and named/);
  });
  it("tells login-code templates apart from ones with an ordinary link button", () => {
    expect(isLoginCodeTemplate([{ type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "ONE_TAP" }] }])).toBe(true);
    expect(isLoginCodeTemplate([{ type: "BUTTONS", buttons: [{ type: "URL", url: "https://www.whatsapp.com/otp/code/?code=otp{{1}}" }] }])).toBe(true);
    expect(isLoginCodeTemplate([{ type: "BUTTONS", buttons: [{ type: "URL", url: "https://shop.test/{{1}}" }, null] }])).toBe(false);
    expect(isLoginCodeTemplate(imageHeader)).toBe(false);
  });
});

describe("named placeholders (Meta's parameter_format NAMED)", () => {
  const named = [{ type: "HEADER", format: "TEXT", text: "Order {{order_id}}" }, { type: "BODY", text: "Hi {{first_name}}, {{order_id}} ships {{when}}" }];

  it("makes one slot per name, keyed by the name", () => {
    const slots = templateSlots(named);
    expect(slots.map((s) => `${s.kind}:${s.key}`)).toEqual(["header_text:header", "body:first_name", "body:order_id", "body:when"]);
    expect(slots[1]).toMatchObject({ name: "first_name", label: "Message placeholder {{first_name}}" });
    expect(slots[0].label).toBe("Header placeholder {{order_id}}");
  });
  it("sends every named value with its parameter_name, which Meta needs to fill the template", () => {
    const map = { header: { source: "attribute", key: "order" }, first_name: { source: "field", key: "first_name" }, order_id: { source: "attribute", key: "order" }, when: { source: "static", value: "today" } } as VariableMap;
    const built = buildRecipientComponents(named, { name: "Asha Rao", attributes: { order: "A-17" } }, parseVariableMap(map, named, "skip"), "skip");
    expect(built).toEqual({
      ok: true,
      components: [
        { type: "header", parameters: [{ type: "text", parameter_name: "order_id", text: "A-17" }] },
        {
          type: "body",
          parameters: [
            { type: "text", parameter_name: "first_name", text: "Asha" },
            { type: "text", parameter_name: "order_id", text: "A-17" },
            { type: "text", parameter_name: "when", text: "today" },
          ],
        },
      ],
    });
  });
  it("without a map, a named placeholder reads the contact detail of the same name", () => {
    const built = buildRecipientComponents([{ type: "BODY", text: "Your code {{coupon}} is ready" }], { name: "A", attributes: { coupon: "X1" } }, null, "skip");
    expect(built).toEqual({ ok: true, components: [{ type: "body", parameters: [{ type: "text", parameter_name: "coupon", text: "X1" }] }] });
  });
  it("a placeholder named header does not collide with the header slot", () => {
    expect(templateSlots([{ type: "BODY", text: "See {{header}} now" }]).map((s) => s.key)).toEqual(["body:header"]);
  });
});

describe("coupon-code buttons", () => {
  const coupon = [{ type: "BODY", text: "Your offer is here" }, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop" }, { type: "COPY_CODE", example: "SAVE20" }] }];

  it("is a slot that must be mapped, and is sent as a coupon_code parameter at its index", () => {
    expect(templateSlots(coupon)).toEqual([{ key: "button:1", kind: "button_copy_code", buttonIndex: 1, label: 'Coupon code for the "button" button' }]);
    expect(() => parseVariableMap({}, coupon, "skip")).toThrow(/Coupon code/);
    const map = parseVariableMap({ "button:1": { source: "static", value: "SAVE20" } }, coupon, "skip");
    expect(buildRecipientComponents(coupon, { name: null, attributes: {} }, map, "skip")).toEqual({
      ok: true,
      components: [{ type: "button", sub_type: "COPY_CODE", index: "1", parameters: [{ type: "coupon_code", coupon_code: "SAVE20" }] }],
    });
  });
  it("takes a code saved on each contact, and refuses what WhatsApp would refuse", () => {
    const map = parseVariableMap({ "button:1": { source: "attribute", key: "coupon" } }, coupon, "skip");
    expect(buildRecipientComponents(coupon, { name: null, attributes: { coupon: "VIP10" } }, map, "skip").ok).toBe(true);
    expect(buildRecipientComponents(coupon, { name: null, attributes: { coupon: "has spaces" } }, map, "skip").ok).toBe(false);
    expect(buildRecipientComponents(coupon, { name: null, attributes: { coupon: "WAYTOOLONGCODE123" } }, map, "skip").ok).toBe(false);
    expect(() => parseVariableMap({ "button:1": { source: "static", value: "50% off" } }, coupon, "skip")).toThrow(/letters and numbers/);
    expect(() => parseVariableMap({ "button:1": { source: "field", key: "name" } }, coupon, "skip")).toThrow(/code/);
  });
});

describe("uploaded header files", () => {
  const now = new Date("2026-10-30T10:00:00Z");
  const upload = (daysOld: number, over: Record<string, unknown> = {}) => ({ source: "upload", value: "1234567890", filename: "menu.pdf", uploadedAt: new Date(now.getTime() - daysOld * 86_400_000).toISOString(), phoneNumberId: "p1", ...over });
  const doc = [{ type: "HEADER", format: "DOCUMENT" }, { type: "BODY", text: "Our menu" }];

  it("are sent by media id (with the file name for a document) while WhatsApp keeps them", () => {
    const map = parseVariableMap({ header: upload(1) }, doc, "skip");
    expect(map?.header).toEqual({ source: "upload", value: "1234567890", filename: "menu.pdf", uploadedAt: upload(1).uploadedAt, phoneNumberId: "p1" });
    expect(buildRecipientComponents(doc, { name: null, attributes: {} }, map, "skip", now)).toEqual({
      ok: true,
      components: [{ type: "header", parameters: [{ type: "document", document: { id: "1234567890", filename: "menu.pdf" } }] }],
    });
    expect(uploadUsable(map?.header, now)).toBe(true);
  });
  it("count as missing once WhatsApp no longer keeps them, so skip, fallback or stop applies", () => {
    const map = parseVariableMap({ header: { ...upload(29.5), fallback: "https://cdn.example/menu.pdf" } }, doc, "fallback");
    expect(buildRecipientComponents(doc, { name: null, attributes: {} }, map, "skip", now).ok).toBe(false);
    expect(buildRecipientComponents(doc, { name: null, attributes: {} }, map, "fallback", now)).toEqual({
      ok: true,
      components: [{ type: "header", parameters: [{ type: "document", document: { link: "https://cdn.example/menu.pdf" } }] }],
    });
  });
  it("need no fallback under the fallback policy, like a fixed link, and are refused for anything but a header file", () => {
    expect(() => parseVariableMap({ header: upload(1) }, doc, "fallback")).not.toThrow();
    expect(() => parseVariableMap({ "1": upload(1) }, textOnly, "skip")).toThrow(/file you upload/);
    expect(() => parseVariableMap({ header: upload(1, { value: "../etc" }) }, doc, "skip")).toThrow(/upload the file again/);
    expect(() => parseVariableMap({ header: upload(1, { phoneNumberId: undefined }) }, doc, "skip")).toThrow(/upload the file again/);
  });
  it("tell when they must be uploaded again: 20 days after the oldest upload", () => {
    const map = { header: upload(5) } as VariableMap;
    expect(uploadedKeys(map)).toEqual(["header"]);
    expect(nextUploadRefresh(map)).toEqual(new Date(now.getTime() + 15 * 86_400_000));
    expect(nextUploadRefresh({ "1": { source: "static", value: "x" } })).toBeNull();
  });
});
