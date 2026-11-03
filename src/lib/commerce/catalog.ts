/**
 * The older product message builders, kept for their callers with unchanged behaviour. They now live in messages.ts with the
 * four builders of docs/specs/META-CATALOG-COMMERCE-SPEC.md 3.5; new code imports from "@/lib/commerce/messages".
 */
export { buildProductListMessage, buildProductMessage, type ProductListInput, type ProductMessageInput } from "./messages";
