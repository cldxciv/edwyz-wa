import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GET } from "@/app/(site)/docs/openapi.json/route";
import { buildOpenApi, eventDataSchema, schemaForType } from "@/lib/compat/openapi";
import { COMPAT_BASE_PATH, ENDPOINTS, ERROR_CODES } from "@/lib/compat/spec";
import { WEBHOOK_EVENTS } from "@/lib/integrations/events";
import { EVENT_CATALOG } from "@/lib/integrations/payloads";
import { acceptedScopes, API_SCOPES } from "@/lib/integrations/scopes";

/* eslint-disable @typescript-eslint/no-explicit-any */
const doc = buildOpenApi("https://wa.test/") as any;

describe("OpenAPI 3.1 document", () => {
  it("declares version 3.1 and the API base url without a double slash", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers).toEqual([{ url: `https://wa.test${COMPAT_BASE_PATH}` }]);
    expect(doc.info.title).toBeTruthy();
  });

  it("has one operation per endpoint in the table, with the right method and a unique operationId", () => {
    const seen = new Set<string>();
    for (const e of ENDPOINTS) {
      const op = doc.paths[e.path]?.[e.method.toLowerCase()];
      expect(op, `${e.method} ${e.path}`).toBeTruthy();
      expect(op.operationId).toBe(e.id);
      seen.add(op.operationId);
    }
    expect(seen.size).toBe(ENDPOINTS.length);
    const total = Object.values(doc.paths).reduce((n: number, item) => n + Object.keys(item as object).length, 0);
    expect(total).toBe(ENDPOINTS.length);
  });

  it("lists every path parameter and marks them required", () => {
    const op = doc.paths["/contacts/{target}/tags/{tag}"].delete;
    expect(op.parameters.filter((p: any) => p.in === "path").map((p: any) => p.name)).toEqual(["target", "tag"]);
    expect(op.parameters.every((p: any) => p.required === true)).toBe(true);
  });

  it("describes any-of scopes as alternative security requirements", () => {
    const sendText = doc.paths["/conversations/{target}/messages/text"].post;
    expect([...sendText["x-accepted-scopes"]].sort()).toEqual(["conversations:write", "messages:write"]);
    expect(sendText.security).toEqual(expect.arrayContaining([{ bearerAuth: ["messages:write"] }, { bearerAuth: ["conversations:write"] }]));
    const list = doc.paths["/contacts"].get;
    expect([...list["x-accepted-scopes"]].sort()).toEqual(acceptedScopes("contacts:read").sort());
    expect(sendText.description).toContain("one of these scopes");
  });

  it("documents request bodies with required fields and typed properties", () => {
    const schema = doc.paths["/contacts"].post.requestBody.content["application/json"].schema;
    expect(schema.required).toEqual(["phone_number"]);
    expect(schema.properties.tags).toMatchObject({ type: "array", items: { type: "string" } });
    expect(schema.properties.opt_in).toMatchObject({ type: "boolean" });
    expect(doc.paths["/contacts"].get.requestBody).toBeUndefined();
  });

  it("documents paginated list responses with the paging envelope under the named key", () => {
    const schema = doc.paths["/contacts"].get.responses["200"].content["application/json"].schema;
    expect(schema.required).toEqual(expect.arrayContaining(["contact_list", "has_more", "total"]));
    expect(schema.properties.contact_list.items).toEqual({ $ref: "#/components/schemas/Contact" });
    expect(doc.components.schemas.Contact.properties.bsuid).toBeTruthy();
  });

  it("documents accepted-not-delivered semantics and per-recipient results for template sends", () => {
    expect(doc.paths["/messageTemplates/send"].post.summary).toMatch(/not that it was delivered/);
    const result = doc.components.schemas.TemplateSendResult;
    expect(result.properties.recipients.items.properties.accepted.description).toMatch(/not a delivery confirmation/);
    expect(result.properties.recipients.items.properties.errors).toBeTruthy();
  });

  it("references only schemas and responses that exist, and covers every error status in the table", () => {
    const json = JSON.stringify(doc);
    const refs = [...json.matchAll(/"\$ref":"#\/components\/(responses|schemas)\/(\w+)"/g)];
    expect(refs.length).toBeGreaterThan(10);
    for (const m of refs) expect(doc.components[m[1]][m[2]], m[0]).toBeTruthy();
    for (const c of ERROR_CODES) expect(doc.components.responses[`Error${c.status}`].description).toContain(c.code);
    expect(doc.paths["/contacts"].post.responses["402"]).toEqual({ $ref: "#/components/responses/Error402" });
    expect(doc.paths["/contacts"].get.responses["402"]).toBeUndefined();
    expect(doc.paths["/contacts"].post.responses["201"]).toBeTruthy();
  });

  it("describes every API scope in the security scheme", () => {
    for (const scope of API_SCOPES) expect(doc.components.securitySchemes.bearerAuth.description).toContain(scope);
  });

  it("includes every outbound webhook event with an example that matches the catalogue", () => {
    expect(Object.keys(doc.webhooks).sort()).toEqual([...WEBHOOK_EVENTS].sort());
    for (const event of EVENT_CATALOG) {
      const content = doc.webhooks[event.event].post.requestBody.content["application/json"];
      expect(content.example.event).toBe(event.event);
      expect(content.example.data).toEqual(event.sample);
    }
  });

  it("contains no secret-looking token and no other product's name", () => {
    const text = JSON.stringify(doc).toLowerCase();
    expect(text).not.toContain("wati");
    expect(text).not.toMatch(/wak_[a-z0-9]{16,}/);
  });

  it("is served as JSON from /docs/openapi.json", async () => {
    const res = GET();
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.openapi).toBe("3.1.0");
    expect(Object.keys(body.paths).length).toBeGreaterThan(10);
  });

  it("is linked from the docs index and navigation", () => {
    const root = path.resolve(__dirname, "..");
    expect(readFileSync(path.join(root, "src/app/(site)/docs/parts.tsx"), "utf8")).toContain("/docs/openapi.json");
    expect(readFileSync(path.join(root, "src/app/(site)/docs/page.tsx"), "utf8")).toContain("/docs/openapi.json");
  });
});

describe("schema helpers", () => {
  it("maps the type words used in the endpoint table", () => {
    expect(schemaForType("string or null")).toEqual({ type: ["string", "null"] });
    expect(schemaForType("integer")).toEqual({ type: "integer" });
    expect(schemaForType("array of { name, value }")).toMatchObject({ type: "array", items: { required: ["name"] } });
  });

  it("nests dotted event field names", () => {
    const schema = eventDataSchema(EVENT_CATALOG.find((e) => e.event === "message.received")!) as any;
    expect(schema.properties.contact.properties.bsuid.type).toEqual(["string", "null"]);
    expect(schema.properties.message.properties.id.type).toBe("string");
    expect(schema.properties.referral.type).toEqual(["object", "null"]);
    expect(schema.properties.referral.properties.ctwaClid).toBeTruthy();
  });
});
