import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  waba: { findFirst: vi.fn(), findMany: vi.fn() },
  phoneNumber: { findFirst: vi.fn(), findMany: vi.fn() },
  template: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
  broadcast: { count: vi.fn() },
}));
const graph = vi.hoisted(() => {
  class GraphError extends Error {
    constructor(
      message: string,
      public status: number,
      public code?: number,
    ) {
      super(message);
    }
  }
  return { graphFetch: vi.fn(), GraphError };
});

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/graph", () => ({ graphFetch: graph.graphFetch, GraphError: graph.GraphError }));

import { NoValidTokenError } from "@/lib/crypto/tokens";
import { errorResponse } from "@/lib/tenancy";
import { mapMetaStatus } from "@/lib/templates/status";
import { createTemplate, deleteTemplate, submitTemplate, syncTemplates, templateAccounts, templateDetails, updateTemplate } from "@/lib/templates/service";
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
    ["DELETED", "disabled"],
    ["ARCHIVED", "disabled"],
    ["LIMIT_EXCEEDED", "rejected"],
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
    db.phoneNumber.findFirst.mockResolvedValue(null);
    db.waba.findFirst.mockResolvedValue({ id: "w1", wabaId: "meta-w1" });
    db.template.findFirst.mockResolvedValue(null);
    db.template.create.mockResolvedValue({ id: "tpl1" });
    await createTemplate(actor, valid());
    expect(db.waba.findFirst.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
    expect(db.template.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", wabaRefId: "w1", status: "draft" });
  });

  it("createTemplate defaults to the account of the workspace's first number, not the oldest account", async () => {
    db.phoneNumber.findFirst.mockResolvedValue({ wabaRefId: "w2" });
    db.waba.findFirst.mockResolvedValue({ id: "w2", wabaId: "meta-w2" });
    db.template.findFirst.mockResolvedValue(null);
    db.template.create.mockResolvedValue({ id: "tpl1" });
    await createTemplate(actor, valid());
    expect(db.phoneNumber.findFirst.mock.calls[0][0]).toMatchObject({ where: { tenantId: "t1" }, orderBy: { createdAt: "asc" } });
    expect(db.waba.findFirst.mock.calls[0][0].where).toEqual({ id: "w2", tenantId: "t1" });
    expect(db.template.create.mock.calls[0][0].data).toMatchObject({ wabaRefId: "w2" });
  });

  it("createTemplate uses the account the person chose, only when it is one of the workspace's own", async () => {
    db.waba.findFirst.mockResolvedValueOnce({ id: "w3", wabaId: "meta-w3" });
    db.template.findFirst.mockResolvedValue(null);
    db.template.create.mockResolvedValue({ id: "tpl1" });
    await createTemplate(actor, { ...valid(), wabaRefId: "w3" });
    expect(db.waba.findFirst.mock.calls[0][0].where).toEqual({ id: "w3", tenantId: "t1" });
    expect(db.template.create.mock.calls[0][0].data).toMatchObject({ wabaRefId: "w3" });
    db.waba.findFirst.mockResolvedValueOnce(null);
    await expect(createTemplate(actor, { ...valid(), wabaRefId: "foreign" })).rejects.toMatchObject({ status: 400 });
    await expect(createTemplate(actor, { ...valid(), wabaRefId: 42 })).rejects.toMatchObject({ status: 400 });
    expect(db.phoneNumber.findFirst).not.toHaveBeenCalled();
  });

  it("templateAccounts lists the workspace's accounts with their numbers, the default first", async () => {
    db.waba.findMany.mockResolvedValue([{ id: "w1", name: null }, { id: "w2", name: "Main" }]);
    db.phoneNumber.findMany.mockResolvedValue([{ wabaRefId: "w2", displayPhone: "+91 1", verifiedName: "Asha Stores" }, { wabaRefId: "w1", displayPhone: "+91 2", verifiedName: "Test" }]);
    const accounts = await templateAccounts(actor);
    expect(db.waba.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
    expect(accounts).toEqual([
      { id: "w2", name: "Main", numbers: ["+91 1"], isDefault: true },
      { id: "w1", name: "Test", numbers: ["+91 2"], isDefault: false },
    ]);
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
    db.template.findMany.mockResolvedValue([]);
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
    expect(result).toEqual({ synced: 2, disabled: 0 });
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

  it("syncTemplates keeps the local fix of a template Meta still calls rejected", async () => {
    db.waba.findMany.mockResolvedValue([{ id: "w1", wabaId: "meta-w1" }]);
    db.template.findMany.mockResolvedValue([{ name: "b", language: "en" }]);
    graph.graphFetch.mockResolvedValueOnce({
      data: [
        { id: "2", name: "b", language: "en", category: "UTILITY", status: "REJECTED", components: [{ type: "BODY", text: "old" }], rejected_reason: "PROMOTIONAL" },
        { id: "3", name: "c", language: "en", category: "UTILITY", status: "REJECTED", components: [{ type: "BODY", text: "theirs" }] },
      ],
    });
    await syncTemplates(actor);
    expect(db.template.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", wabaRefId: "w1", status: "rejected" });
    expect(db.template.upsert.mock.calls[0][0].update).toEqual({ status: "rejected", metaTemplateId: "2", rejectionReason: "PROMOTIONAL" });
    expect(db.template.upsert.mock.calls[1][0].update).toMatchObject({ components: [{ type: "BODY", text: "theirs" }] });
  });

  it("updateTemplate saves a draft and refuses templates Meta approved or is reviewing", async () => {
    db.template.findFirst.mockResolvedValueOnce({ id: "tpl1", tenantId: "t1", wabaRefId: "w1", status: "draft", metaTemplateId: null, ...valid() }).mockResolvedValueOnce(null);
    db.template.update.mockResolvedValue({ id: "tpl1" });
    await updateTemplate(actor, "tpl1", { ...valid(), name: "order_shipped" });
    expect(db.template.findFirst.mock.calls[0][0].where).toEqual({ id: "tpl1", tenantId: "t1" });
    expect(db.template.findFirst.mock.calls[1][0].where).toMatchObject({ tenantId: "t1", wabaRefId: "w1", name: "order_shipped", id: { not: "tpl1" } });
    expect(db.template.update.mock.calls[0][0]).toMatchObject({ where: { id: "tpl1", tenantId: "t1" }, data: { name: "order_shipped", category: "UTILITY" } });

    for (const status of ["approved", "pending"]) {
      db.template.findFirst.mockResolvedValueOnce({ id: "tpl2", tenantId: "t1", status, ...valid() });
      await expect(updateTemplate(actor, "tpl2", valid())).rejects.toMatchObject({ status: 409 });
    }
    db.template.findFirst.mockResolvedValueOnce(null);
    await expect(updateTemplate(actor, "other", valid())).rejects.toMatchObject({ status: 404 });
  });

  it("updateTemplate keeps the name of a rejected template Meta has, and checks the content like a new one", async () => {
    const rejected = { id: "tpl1", tenantId: "t1", wabaRefId: "w1", status: "rejected", metaTemplateId: "meta-tpl", ...valid() };
    db.template.findFirst.mockResolvedValue(rejected);
    await expect(updateTemplate(actor, "tpl1", { ...valid(), name: "new_name" })).rejects.toMatchObject({ status: 409 });
    await expect(updateTemplate(actor, "tpl1", { ...valid(), components: [{ type: "BODY", text: "{{1}} ready", example: { body_text: [["a"]] } }] })).rejects.toMatchObject({ status: 400 });
    db.template.update.mockResolvedValue({ id: "tpl1" });
    await updateTemplate(actor, "tpl1", { ...valid(), category: "MARKETING" });
    expect(db.template.update.mock.calls[0][0].data).toMatchObject({ name: "order_update", category: "MARKETING" });
  });

  it("submitTemplate edits a rejected template at Meta in place instead of creating it again", async () => {
    db.template.findFirst.mockResolvedValue({ id: "tpl1", tenantId: "t1", wabaRefId: "w1", status: "rejected", metaTemplateId: "meta-tpl", ...valid() });
    db.waba.findFirst.mockResolvedValue({ id: "w1", wabaId: "meta-w1" });
    graph.graphFetch.mockResolvedValue({ success: true });
    db.template.update.mockResolvedValue({});
    await submitTemplate(actor, "tpl1");
    expect(graph.graphFetch).toHaveBeenCalledWith(expect.objectContaining({ path: "meta-tpl", method: "POST", body: { category: "UTILITY", components: valid().components } }));
    expect(db.template.update.mock.calls[0][0].data).toMatchObject({ metaTemplateId: "meta-tpl", status: "pending", rejectionReason: null });
  });

  it("templateDetails answers only the tenant's own template, without account ids", async () => {
    db.template.findFirst.mockResolvedValueOnce({ id: "tpl1", tenantId: "t1", wabaRefId: "w1", status: "rejected", rejectionReason: "SCAM", metaTemplateId: "m", headerMedia: null, updatedAt: new Date(0), ...valid() });
    const t = await templateDetails(actor, "tpl1");
    expect(t).toMatchObject({ id: "tpl1", status: "rejected", rejectionReason: "SCAM", atMeta: true });
    expect(t).not.toHaveProperty("tenantId");
    expect(t).not.toHaveProperty("wabaRefId");
    db.template.findFirst.mockResolvedValueOnce(null);
    await expect(templateDetails(actor, "other")).rejects.toMatchObject({ status: 404 });
  });

  it("deleteTemplate refuses when a broadcast uses it", async () => {
    db.template.findFirst.mockResolvedValue({ id: "tpl1", wabaRefId: "w1", status: "approved", name: "a", metaTemplateId: "m1" });
    db.waba.findFirst.mockResolvedValue({ id: "w1", wabaId: "meta-w1" });
    db.broadcast.count.mockResolvedValue(1);
    await expect(deleteTemplate(actor, "tpl1")).rejects.toMatchObject({ status: 409 });
    expect(graph.graphFetch).not.toHaveBeenCalled();
  });

  it("deleteTemplate deletes only this language at Meta (hsm_id) and only this row here", async () => {
    db.template.findFirst.mockResolvedValue({ id: "tpl1", wabaRefId: "w1", status: "approved", name: "promo", language: "hi", metaTemplateId: "m1" });
    db.waba.findFirst.mockResolvedValue({ id: "w1", wabaId: "meta-w1" });
    db.broadcast.count.mockResolvedValue(0);
    graph.graphFetch.mockResolvedValue({ success: true });
    db.template.deleteMany.mockResolvedValue({ count: 1 });
    expect(await deleteTemplate(actor, "tpl1")).toEqual({ removed: 1 });
    expect(graph.graphFetch).toHaveBeenCalledWith(expect.objectContaining({ path: "meta-w1/message_templates", method: "DELETE", query: { name: "promo", hsm_id: "m1" } }));
    expect(db.template.deleteMany).toHaveBeenCalledWith({ where: { tenantId: "t1", id: { in: ["tpl1"] } } });
    expect(db.template.findMany).not.toHaveBeenCalled();
  });

  it("deleteTemplate without Meta's id deletes by name, so every language of the name goes here too", async () => {
    db.template.findFirst.mockResolvedValue({ id: "tpl1", wabaRefId: "w1", status: "approved", name: "promo", language: "en", metaTemplateId: null });
    db.waba.findFirst.mockResolvedValue({ id: "w1", wabaId: "meta-w1" });
    db.template.findMany.mockResolvedValue([{ id: "tpl1" }, { id: "tpl2" }]);
    db.broadcast.count.mockResolvedValue(0);
    graph.graphFetch.mockResolvedValue({ success: true });
    db.template.deleteMany.mockResolvedValue({ count: 2 });
    expect(await deleteTemplate(actor, "tpl1")).toEqual({ removed: 2 });
    expect(db.template.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", wabaRefId: "w1", name: "promo", status: { not: "draft" } });
    expect(db.broadcast.count.mock.calls[0][0].where).toEqual({ tenantId: "t1", templateId: { in: ["tpl1", "tpl2"] } });
    expect(graph.graphFetch.mock.calls[0][0].query).toEqual({ name: "promo" });
    expect(db.template.deleteMany).toHaveBeenCalledWith({ where: { tenantId: "t1", id: { in: ["tpl1", "tpl2"] } } });
  });

  it("deleteTemplate removes a template Meta no longer has, and explains Meta's other refusals instead of a 500", async () => {
    db.template.findFirst.mockResolvedValue({ id: "tpl1", wabaRefId: "w1", status: "approved", name: "promo", metaTemplateId: "m1" });
    db.waba.findFirst.mockResolvedValue({ id: "w1", wabaId: "meta-w1" });
    db.broadcast.count.mockResolvedValue(0);
    db.template.deleteMany.mockResolvedValue({ count: 1 });
    graph.graphFetch.mockRejectedValueOnce(new graph.GraphError("Template not found", 400, 100));
    expect(await deleteTemplate(actor, "tpl1")).toEqual({ removed: 1 });

    db.template.deleteMany.mockClear();
    graph.graphFetch.mockRejectedValueOnce(new graph.GraphError("Permissions error", 403, 200));
    await expect(deleteTemplate(actor, "tpl1")).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Meta refused to delete the template: Permissions error/) });
    graph.graphFetch.mockRejectedValueOnce(new graph.GraphError("Error validating access token", 401, 190));
    await expect(deleteTemplate(actor, "tpl1")).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Reconnect WhatsApp/) });
    graph.graphFetch.mockRejectedValueOnce(new graph.GraphError("Service unavailable", 503));
    await expect(deleteTemplate(actor, "tpl1")).rejects.toMatchObject({ status: 502 });
    expect(db.template.deleteMany).not.toHaveBeenCalled();
  });

  it("syncTemplates turns off templates deleted in WhatsApp Manager, and turns a missing rejected one back into a draft", async () => {
    const now = new Date("2026-10-30T10:00:00Z");
    db.waba.findMany.mockResolvedValue([{ id: "w1", wabaId: "meta-w1" }]);
    graph.graphFetch.mockResolvedValueOnce({ data: [{ id: "1", name: "kept", language: "en", category: "UTILITY", status: "APPROVED", components: [] }] });
    db.template.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: "k", name: "kept", language: "en", status: "approved" },
      { id: "g", name: "gone", language: "en", status: "approved" },
      { id: "r", name: "fixme", language: "en", status: "rejected" },
    ]);
    db.template.updateMany.mockResolvedValue({ count: 1 });
    expect(await syncTemplates(actor, now)).toEqual({ synced: 1, disabled: 1 });
    const retire = db.template.findMany.mock.calls[1][0];
    expect(retire.where).toMatchObject({ tenantId: "t1", wabaRefId: "w1", status: { notIn: ["draft", "disabled"] }, updatedAt: { lt: new Date(now.getTime() - 10 * 60_000) } });
    expect(db.template.updateMany).toHaveBeenCalledWith({ where: { tenantId: "t1", id: { in: ["r"] } }, data: { status: "draft", metaTemplateId: null } });
    expect(db.template.updateMany).toHaveBeenCalledWith({ where: { tenantId: "t1", id: { in: ["g"] } }, data: { status: "disabled" } });
  });

  it("syncTemplates turns nothing off when Meta's list was cut short at the page cap", async () => {
    db.waba.findMany.mockResolvedValue([{ id: "w1", wabaId: "meta-w1" }]);
    db.template.findMany.mockResolvedValue([]);
    graph.graphFetch.mockResolvedValue({ data: [], paging: { cursors: { after: "more" }, next: "https://next" } });
    expect(await syncTemplates(actor)).toEqual({ synced: 0, disabled: 0 });
    expect(graph.graphFetch).toHaveBeenCalledTimes(50);
    expect(db.template.findMany).toHaveBeenCalledTimes(1);
    expect(db.template.updateMany).not.toHaveBeenCalled();
  });

  it("syncTemplates and submitTemplate turn Meta's refusals into an answer, not a generic 500", async () => {
    db.waba.findMany.mockResolvedValue([{ id: "w1", wabaId: "meta-w1" }]);
    graph.graphFetch.mockRejectedValueOnce(new graph.GraphError("Unsupported get request", 400, 100));
    await expect(syncTemplates(actor)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/list your templates: Unsupported get request/) });
    db.template.findFirst.mockResolvedValue({ id: "tpl1", tenantId: "t1", wabaRefId: "w1", status: "draft", ...valid() });
    db.waba.findFirst.mockResolvedValue({ id: "w1", wabaId: "meta-w1" });
    graph.graphFetch.mockRejectedValueOnce(new graph.GraphError("Session expired", 401, 190));
    await expect(submitTemplate(actor, "tpl1")).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Reconnect WhatsApp in Settings/) });
  });
});
