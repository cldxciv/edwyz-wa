import { describe, expect, it } from "vitest";
import { buildProductListMessage, buildProductMessage } from "@/lib/commerce/catalog";

describe("buildProductMessage", () => {
  it("builds a single product payload", () => {
    expect(buildProductMessage({ to: "+919876543210", catalogId: "cat1", productRetailerId: "sku1", body: "Take a look", footer: "Edwyz" })).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "919876543210",
      type: "interactive",
      interactive: {
        type: "product",
        body: { text: "Take a look" },
        footer: { text: "Edwyz" },
        action: { catalog_id: "cat1", product_retailer_id: "sku1" },
      },
    });
  });
  it("omits optional body and footer and validates input", () => {
    const m = buildProductMessage({ to: "919876543210", catalogId: "cat1", productRetailerId: "sku1" });
    expect(m.interactive).toEqual({ type: "product", action: { catalog_id: "cat1", product_retailer_id: "sku1" } });
    expect(() => buildProductMessage({ to: "abc", catalogId: "c", productRetailerId: "s" })).toThrow();
    expect(() => buildProductMessage({ to: "919876543210", catalogId: " ", productRetailerId: "s" })).toThrow();
    expect(() => buildProductMessage({ to: "919876543210", catalogId: "c", productRetailerId: "s", body: "x".repeat(1025) })).toThrow();
  });
});

describe("buildProductListMessage", () => {
  const base = { to: "+919876543210", catalogId: "cat1", header: "Our picks", body: "Choose one" };

  it("builds sections with product items", () => {
    const m = buildProductListMessage({
      ...base,
      sections: [{ title: "Shirts", productRetailerIds: ["a", "b"] }, { title: "Shoes", productRetailerIds: ["c"] }],
    });
    expect(m.interactive).toMatchObject({
      type: "product_list",
      header: { type: "text", text: "Our picks" },
      body: { text: "Choose one" },
      action: {
        catalog_id: "cat1",
        sections: [
          { title: "Shirts", product_items: [{ product_retailer_id: "a" }, { product_retailer_id: "b" }] },
          { title: "Shoes", product_items: [{ product_retailer_id: "c" }] },
        ],
      },
    });
  });
  it("enforces Meta limits", () => {
    expect(() => buildProductListMessage({ ...base, header: "", sections: [{ productRetailerIds: ["a"] }] })).toThrow(/header/);
    expect(() => buildProductListMessage({ ...base, sections: [] })).toThrow();
    expect(() => buildProductListMessage({ ...base, sections: [{ productRetailerIds: ["a"] }, { title: "B", productRetailerIds: ["b"] }] })).toThrow(/title/);
    expect(() => buildProductListMessage({ ...base, sections: [{ title: "x".repeat(25), productRetailerIds: ["a"] }, { title: "B", productRetailerIds: ["b"] }] })).toThrow();
    const many = Array.from({ length: 31 }, (_, i) => `p${i}`);
    expect(() => buildProductListMessage({ ...base, sections: [{ productRetailerIds: many }] })).toThrow(/30/);
    expect(() => buildProductListMessage({ ...base, sections: Array.from({ length: 11 }, (_, i) => ({ title: `S${i}`, productRetailerIds: ["a"] })) })).toThrow();
    expect(() => buildProductListMessage({ ...base, sections: [{ productRetailerIds: [] }] })).toThrow();
  });
  it("allows a single untitled section", () => {
    const m = buildProductListMessage({ ...base, sections: [{ productRetailerIds: ["a"] }] });
    expect((m.interactive.action.sections[0] as { title?: string }).title).toBeUndefined();
  });
});
