import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findUnique: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn(), delete: vi.fn() });
  const prisma: Record<string, unknown> = Object.fromEntries(["contact", "conversation", "message", "note", "automationRun", "ruleExecution", "broadcastRecipient"].map((n) => [n, model()]));
  prisma.$transaction = (fn: (tx: unknown) => unknown) => fn(prisma);
  return prisma as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
});

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/integrations/apikeys", () => ({ revokeKeysBestEffort: vi.fn() }));
// Contact erasure also clears Eddy's rows in the same transaction (EDDY-16); that is tested in tests/lifecycle-eddy-erasure.test.ts.
vi.mock("@/lib/eddy/erasure-sweep", () => ({ eraseContactFromEddy: vi.fn(async () => ({ conversations: 0, messages: 0, actionRecords: 0, notices: 0 })) }));

import { inboundMediaPath } from "@/lib/inbox/media";
import { deleteContactData } from "@/lib/lifecycle/erasure";
import { removeTenantFiles } from "@/lib/lifecycle/files";

let dataDir: string;
beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "inbound-erase-"));
  process.env.DATA_DIR = dataDir;
});
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function cache(tenantId: string, messageId: string) {
  const file = inboundMediaPath(tenantId, messageId) as string;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "customer bytes");
  return file;
}

beforeEach(() => {
  for (const model of Object.values(db)) if (typeof model === "object") for (const fn of Object.values(model)) fn.mockReset();
  db.contact.findUnique.mockResolvedValue({ id: "c1" });
  db.conversation.findMany.mockResolvedValue([{ id: "v1" }]);
});

describe("erasing a contact removes cached inbound media", () => {
  it("unlinks the cache file of every deleted message and nothing else", async () => {
    const mine1 = cache("tenantE1", "msgA");
    const mine2 = cache("tenantE1", "msgB");
    const otherMessage = cache("tenantE1", "msgKeep");
    const otherTenant = cache("tenantE2", "msgA");
    db.message.findMany.mockResolvedValue([{ id: "msgA" }, { id: "msgB" }]);
    expect(await deleteContactData("tenantE1", "+911")).toEqual({ deleted: true });
    expect(db.message.findMany).toHaveBeenCalledWith({ where: { tenantId: "tenantE1", conversationId: { in: ["v1"] } }, select: { id: true } });
    expect(fs.existsSync(mine1)).toBe(false);
    expect(fs.existsSync(mine2)).toBe(false);
    expect(fs.existsSync(otherMessage)).toBe(true);
    expect(fs.existsSync(otherTenant)).toBe(true);
  });

  it("collects the message ids before the rows are deleted", async () => {
    const order: string[] = [];
    db.message.findMany.mockImplementation(async () => (order.push("find"), [{ id: "m1" }]));
    db.message.deleteMany.mockImplementation(async () => order.push("delete"));
    await deleteContactData("tenantE3", "+911");
    expect(order).toEqual(["find", "delete"]);
  });

  it("does nothing for an unknown contact and survives a missing cache file", async () => {
    db.contact.findUnique.mockResolvedValue(null);
    expect(await deleteContactData("tenantE4", "+000")).toEqual({ deleted: false });
    expect(db.message.findMany).not.toHaveBeenCalled();
    db.contact.findUnique.mockResolvedValue({ id: "c1" });
    db.message.findMany.mockResolvedValue([{ id: "neverCached" }, { id: "../escape" }]);
    expect(await deleteContactData("tenantE4", "+911")).toEqual({ deleted: true });
  });
});

describe("erasing a workspace removes cached inbound media", () => {
  it("deletes DATA_DIR/inbound-media/<tenant> for that workspace only", async () => {
    const a = cache("tenantW1", "m1");
    const b = cache("tenantW2", "m1");
    const out = await removeTenantFiles("tenantW1");
    expect(out["inbound-media"]).toBe(1);
    expect(fs.existsSync(path.dirname(a))).toBe(false);
    expect(fs.existsSync(b)).toBe(true);
  });
});
