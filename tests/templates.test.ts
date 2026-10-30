import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  waba: { findFirst: vi.fn(), findMany: vi.fn() },
  template: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
  broadcast: { count: vi.fn() },
}));
const graph = vi.hoisted(() => ({ graphFetch: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/graph", () => ({ graphFetch: graph.graphFetch, GraphError: class extends Error {} }));

import { NoValidTokenError } from "@/lib/crypto/tokens";
import { errorResponse } from "@/lib/tenancy";
import { mapMetaStatus } from "@/lib/templates/status";
import { createTemplate, deleteTemplate, submitTemplate, syncTemplates } from "@/lib/templates/service";
import { validateTemplateInput } from "@/lib/templates/validate";

const actor = { userId: "u1", tenantId: "t1", role: "admin" as const };
const valid = () => ({
  name: "order_update",
  language: "en_US",
  category: "UTILITY",
  components: [{ type: "BODY", text: "Hi {{1}}, order {{2}} shipped", example: { body_text: [["Asha", "123"]] } }],
});

describe("validateTemplateInput", () => {
  it("accepts a valid template", () => {
    expect(validateTemplateInput(valid()).name).toBe("order_update");
  });
  it("rejects bad names and languages", () => {
    expect(() => validateTemplateInput({ ...valid(), name: "Order-Update" })).toThrow();
    expect(() => validateTemplateInput({ ...valid(), name: "a".repeat(513) })).toThrow();
    expect(() => validateTemplateInput({ ...valid(), language: "english" })).toThrow();
    expect(() => validateTemplateInput({ ...valid(), category: "PROMO" })).toThrow();
  });
  it("requires examples when body has variables", () => {
    const t = valid() as { components: unknown[] };
    t.components[0] = { type: "BODY", text: "Hi {{1}}" };
    expect(() => validateTemplateInput(t)).toThrow(/example/i);
    t.components[0] = { type: "BODY", text: "Hi {{1}} {{2}}", example: { body_text: [["only one"]] } };
    expect(() => validateTemplateInput(t)).toThrow(/example/i);
  });
  it("requires sequential variables", () => {
    const t = valid() as { components: unknown[] };
    t.components[0] = { type: "BODY", text: "Hi {{2}}", example: { body_text: [["a"]] } };
    expect(() => validateTemplateInput(t)).toThrow(/sequential/i);
  });
  it("requires a BODY and validates header media handle", () => {
    expect(() => validateTemplateInput({ ...valid(), components: [{ type: "FOOTER", text: "bye" }] })).toThrow(/BODY/);
    const media = { ...valid(), components: [{ type: "HEADER", format: "IMAGE" }, ...valid().components] };
    expect(() => validateTemplateInput(media)).toThrow(/handle/i);
    media.components[0] = { type: "HEADER", format: "IMAGE", example: { header_handle: ["4::abc"] } } as never;
    expect(validateTemplateInput(media)).toBeTruthy();
  });
  it("enforces the 10 button limit and button shapes", () => {
    const buttons = (n: number) => ({
      ...valid(),
      components: [...valid().components, { type: "BUTTONS", buttons: Array.from({ length: n }, (_, i) => ({ type: "QUICK_REPLY", text: `b${i}` })) }],
    });
    expect(validateTemplateInput(buttons(10))).toBeTruthy();
    expect(() => validateTemplateInput(buttons(11))).toThrow(/at most 10/);
    const bad = { ...valid(), components: [...valid().components, { type: "BUTTONS", buttons: [{ type: "URL", text: "Go", url: "http://x.com" }] }] };
    expect(() => validateTemplateInput(bad)).toThrow(/https/);
    const phone = { ...valid(), components: [...valid().components, { type: "BUTTONS", buttons: [{ type: "PHONE_NUMBER", text: "Call", phone_number: "123" }] }] };
    expect(() => validateTemplateInput(phone)).toThrow(/phone/i);
  });
});

describe("mapMetaStatus", () => {
  it.each([
    ["APPROVED", "approved"],
    ["PENDING", "pending"],
    ["REJECTED", "rejected"],
    ["PAUSED", "paused"],
    ["DISABLED", "disabled"],
    ["SOMETHING_NEW", "pending"],
  ])("%s -> %s", (meta, expected) => {
    expect(mapMetaStatus(meta)).toBe(expected);
  });
});

describe("template service", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("createTemplate stores a draft against the tenant's own WABA", async () => {
    db.waba.findFirst.mockResolvedValue({ id: "w1", wabaId: "meta-w1" });
    db.template.findFirst.mockResolvedValue(null);
    db.template.create.mockResolvedValue({ id: "tpl1" });
    await createTemplate(actor, valid());
    expect(db.waba.findFirst.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
    expect(db.template.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", wabaRefId: "w1", status: "draft" });
  });

  it("submitTemplate posts to the tenant's WABA and stores pending status", async () => {
    db.template.findFirst.mockResolvedValue({ id: "tpl1", tenantId: "t1", wabaRefId: "w1", status: "draft", ...valid() });
    db.waba.findFirst.mockResolvedValue({ id: "w1", wabaId: "meta-w1" });
    graph.graphFetch.mockResolvedValue({ id: "meta-tpl", status: "PENDING" });
    db.template.update.mockResolvedValue({});
    await submitTemplate(actor, "tpl1");
    expect(graph.graphFetch).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", path: "meta-w1/message_templates", method: "POST" }));
    expect(db.template.update.mock.calls[0][0].data).toMatchObject({ metaTemplateId: "meta-tpl", status: "pending" });
  });

  it("rejects another tenant's template without calling Meta", async () => {
    db.template.findFirst.mockResolvedValue(null);
    await expect(submitTemplate(actor, "other")).rejects.toMatchObject({ status: 404 });
    expect(db.template.findFirst.mock.calls[0][0].where).toEqual({ id: "other", tenantId: "t1" });
    expect(graph.graphFetch).not.toHaveBeenCalled();
    await expect(deleteTemplate(actor, "other")).rejects.toMatchObject({ status: 404 });
  });

  it("syncTemplates paginates and upserts by name + language", async () => {
    db.waba.findMany.mockResolvedValue([{ id: "w1", wabaId: "meta-w1" }]);
    graph.graphFetch
      .mockResolvedValueOnce({
        data: [{ id: "1", name: "a", language: "en", category: "MARKETING", status: "APPROVED", components: [] }],
        paging: { cursors: { after: "cur1" }, next: "https://next" },
      })
      .mockResolvedValueOnce({
        data: [{ id: "2", name: "b", language: "en", category: "UTILITY", status: "REJECTED", components: [], rejected_reason: "INVALID_FORMAT" }],
        paging: { cursors: { after: "cur2" } },
      });
    const result = await syncTemplates(actor);
    expect(result).toEqual({ synced: 2 });
    expect(graph.graphFetch.mock.calls[1][0].query.after).toBe("cur1");
    const first = db.template.upsert.mock.calls[0][0];
    expect(first.where.tenantId_wabaRefId_name_language).toEqual({ tenantId: "t1", wabaRefId: "w1", name: "a", language: "en" });
    expect(first.update.status).toBe("approved");
    expect(db.template.upsert.mock.calls[1][0].update).toMatchObject({ status: "rejected", rejectionReason: "INVALID_FORMAT" });
  });

  it("syncTemplates without a WhatsApp token answers 409 with the reason, not a generic 500", async () => {
    db.waba.findMany.mockResolvedValue([{ id: "w1", wabaId: "meta-w1" }]);
    graph.graphFetch.mockRejectedValue(new NoValidTokenError());
    let caught: unknown;
    await syncTemplates(actor).catch((e) => (caught = e));
    expect(caught).toBeInstanceOf(NoValidTokenError);
    const res = errorResponse(caught);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/WhatsApp is not connected/);
    expect(body.error).toMatch(/reconnect WhatsApp in Settings/i);
    expect(body.error).not.toBe("Something went wrong.");
    expect(db.template.upsert).not.toHaveBeenCalled();
  });

  it("deleteTemplate refuses when a broadcast uses it", async () => {
    db.template.findFirst.mockResolvedValue({ id: "tpl1", wabaRefId: "w1", status: "approved", name: "a" });
    db.waba.findFirst.mockResolvedValue({ id: "w1", wabaId: "meta-w1" });
    db.broadcast.count.mockResolvedValue(1);
    await expect(deleteTemplate(actor, "tpl1")).rejects.toMatchObject({ status: 409 });
  });
});
