import { describe, expect, it } from "vitest";
import { broadcastSupportReason } from "@/lib/broadcasts/components";
import {
  type VariableMap,
  buildRecipientComponents,
  cleanParam,
  countMissing,
  isHttpsUrl,
  needsMapping,
  parsePolicy,
  parseVariableMap,
  templateSlots,
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
    expect(() => parseVariableMap({}, imageHeader, "skip")).toThrow(/Header image link/);
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
    expect(built.ok === false && built.missing).toEqual(["Header image link", "Message placeholder {{2}}", 'Link placeholder for the "Track" button']);
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
});
