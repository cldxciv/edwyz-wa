const LIMITS = { header: 60, body: 1024, footer: 60, sectionTitle: 24, sections: 10, products: 30, id: 100 } as const;

type Common = { to: string; catalogId: string; body?: string; footer?: string };

export type ProductMessageInput = Common & { productRetailerId: string };
export type ProductListInput = Omit<Common, "body"> & {
  header: string;
  body: string;
  sections: { title?: string; productRetailerIds: string[] }[];
};

function text(value: string | undefined, field: string, max: number, required = false): string | undefined {
  const v = value?.trim();
  if (!v) {
    if (required) throw new Error(`${field} is required.`);
    return undefined;
  }
  if (v.length > max) throw new Error(`${field} must be at most ${max} characters.`);
  return v;
}

function id(value: string | undefined, field: string): string {
  const v = text(value, field, LIMITS.id, true) as string;
  return v;
}

function base(to: string) {
  const digits = to.replace(/^\+/, "");
  if (!/^\d{8,15}$/.test(digits)) throw new Error("to must be a phone number in international format.");
  return { messaging_product: "whatsapp", recipient_type: "individual", to: digits, type: "interactive" } as const;
}

/** Single-product message (interactive type "product"). Body and footer are optional. */
export function buildProductMessage(input: ProductMessageInput) {
  const body = text(input.body, "body", LIMITS.body);
  const footer = text(input.footer, "footer", LIMITS.footer);
  return {
    ...base(input.to),
    interactive: {
      type: "product",
      ...(body ? { body: { text: body } } : {}),
      ...(footer ? { footer: { text: footer } } : {}),
      action: { catalog_id: id(input.catalogId, "catalogId"), product_retailer_id: id(input.productRetailerId, "productRetailerId") },
    },
  };
}

/** Multi-product message (interactive type "product_list"): header and body required, up to 10 sections and 30 products in total. */
export function buildProductListMessage(input: ProductListInput) {
  const header = text(input.header, "header", LIMITS.header, true) as string;
  const body = text(input.body, "body", LIMITS.body, true) as string;
  const footer = text(input.footer, "footer", LIMITS.footer);
  if (input.sections.length === 0 || input.sections.length > LIMITS.sections) throw new Error(`Use between 1 and ${LIMITS.sections} sections.`);

  const sections = input.sections.map((section) => {
    const title = text(section.title, "section title", LIMITS.sectionTitle, input.sections.length > 1);
    if (section.productRetailerIds.length === 0) throw new Error("Each section needs at least one product.");
    return {
      ...(title ? { title } : {}),
      product_items: section.productRetailerIds.map((p) => ({ product_retailer_id: id(p, "productRetailerId") })),
    };
  });
  const count = sections.reduce((n, s) => n + s.product_items.length, 0);
  if (count > LIMITS.products) throw new Error(`A product list holds at most ${LIMITS.products} products.`);

  return {
    ...base(input.to),
    interactive: {
      type: "product_list",
      header: { type: "text", text: header },
      body: { text: body },
      ...(footer ? { footer: { text: footer } } : {}),
      action: { catalog_id: id(input.catalogId, "catalogId"), sections },
    },
  };
}
