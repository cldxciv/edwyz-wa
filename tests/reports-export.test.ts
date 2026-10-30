import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  contact: { findMany: vi.fn() },
  message: { findMany: vi.fn() },
  broadcast: { findMany: vi.fn() },
  broadcastRecipient: { groupBy: vi.fn(), findMany: vi.fn() },
  conversation: { findMany: vi.fn() },
  template: { findMany: vi.fn() },
  automationRule: { findMany: vi.fn() },
  note: { findMany: vi.fn() },
  lead: { findMany: vi.fn() },
  quickReply: { findMany: vi.fn() },
  team: { findMany: vi.fn() },
  teamMember: { findMany: vi.fn() },
  segment: { findMany: vi.fn() },
  replyMaterial: { findMany: vi.fn() },
}));
const auth = vi.hoisted(() => ({ getActor: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ getActor: auth.getActor }));
vi.mock("@/lib/auth/audit", () => ({ audit: auth.audit }));

import { csvStream, contactsCsv, jsonStream, messagesCsv, TRUNCATION_NOTE, workspaceJson } from "@/lib/reports/export";
import { parseRange } from "@/lib/reports/range";
import { GET as contactsRoute } from "@/app/api/export/contacts.csv/route";
import { GET as messagesRoute } from "@/app/api/export/messages.csv/route";
import { GET as workspaceRoute } from "@/app/api/export/workspace.json/route";
import { GET as broadcastsRoute } from "@/app/api/export/broadcasts.csv/route";

const actor = { userId: "u1", tenantId: "t1", role: "admin" as const };
const read = async (s: ReadableStream<Uint8Array>) => {
  const reader = s.getReader();
  let text = "";
  const dec = new TextDecoder("utf-8", { ignoreBOM: true });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += dec.decode(value);
  }
};
const req = (path: string) => new Request(`http://localhost${path}`);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("csvStream", () => {
  it("writes BOM and header, pages by 1000 and stops at the row cap", async () => {
    const takes: number[] = [];
    let n = 0;
    const done = vi.fn();
    const stream = csvStream({
      headers: ["id"],
      fetchPage: async (_c, take) => {
        takes.push(take);
        return Array.from({ length: take }, () => ({ id: `r${++n}` }));
      },
      toRow: (r) => [r.id],
      maxRows: 2500,
      onDone: done,
    });
    const text = await read(stream);
    expect(text.startsWith("﻿id\r\n")).toBe(true);
    // The last fetch of one row only checks whether data continues beyond the cap.
    expect(takes).toEqual([1000, 1000, 500, 1]);
    const lines = text.trim().split("\r\n");
    expect(lines).toHaveLength(2502);
    expect(lines.at(-1)).toContain(TRUNCATION_NOTE);
    expect(done).toHaveBeenCalledWith(2500, true);
  });
  it("says nothing is missing when the data is exactly the cap", async () => {
    let served = 0;
    const done = vi.fn();
    const text = await read(
      csvStream({
        headers: ["id"],
        fetchPage: async (_c, take) => {
          const n = Math.min(take, 1500 - served);
          served += n;
          return Array.from({ length: n }, (_, i) => ({ id: `r${served - n + i}` }));
        },
        toRow: (r) => [r.id],
        maxRows: 1500,
        onDone: done,
      }),
    );
    expect(text).not.toContain("not complete");
    expect(done).toHaveBeenCalledWith(1500, false);
  });
  it("marks a cut-short JSON export inside the array", async () => {
    let n = 0;
    const text = await read(jsonStream({ fetchPage: async (_c, take) => Array.from({ length: take }, () => ({ id: `r${++n}` })), toRecord: (r) => r, maxRows: 3 }));
    const parsed = JSON.parse(text);
    expect(parsed).toHaveLength(4);
    expect(parsed.at(-1)).toEqual({ _truncated: true, _note: TRUNCATION_NOTE });
  });
  it("records an export the reader abandoned half way", async () => {
    const done = vi.fn().mockResolvedValue(undefined);
    let n = 0;
    const stream = csvStream({ headers: ["id"], fetchPage: async (_c, take) => Array.from({ length: take }, () => ({ id: `r${++n}` })), toRow: (r) => [r.id], onDone: done });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(done).toHaveBeenCalledTimes(1);
    expect(done.mock.calls[0][2]).toBe(true);
  });
  it("writes the audit row for an abandoned download with aborted set", async () => {
    db.contact.findMany.mockResolvedValue(Array.from({ length: 1000 }, (_, i) => ({ id: `c${i}`, phone: "+1", tags: [], optIn: true, createdAt: new Date() })));
    const reader = contactsCsv(actor).getReader();
    await reader.read();
    await reader.cancel();
    expect(auth.audit).toHaveBeenCalledWith({ tenantId: "t1", userId: "u1", action: "export.contacts", meta: { rows: 1000, truncated: false, aborted: true } });
  });
  it("is not truncated when data ends before the cap", async () => {
    const done = vi.fn();
    const text = await read(csvStream({ headers: ["id"], fetchPage: async () => [{ id: "a" }], toRow: (r) => [r.id], onDone: done }));
    expect(text).toContain("a\r\n");
    expect(done).toHaveBeenCalledWith(1, false);
  });
});

describe("exports are tenant scoped and audited without content", () => {
  it("contacts", async () => {
    db.contact.findMany.mockResolvedValueOnce([
      { id: "c1", phone: "+919876543210", name: "=EVIL()", tags: ["a", "b"], optIn: true, optInSource: "form", optInAt: null, optedOutAt: null, createdAt: new Date("2026-01-01"), attributes: { x: 1 } },
    ]);
    const text = await read(contactsCsv(actor));
    expect(db.contact.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
    expect(text).toContain("'+919876543210");
    expect(text).toContain("'=EVIL()");
    expect(auth.audit).toHaveBeenCalledWith({ tenantId: "t1", userId: "u1", action: "export.contacts", meta: { rows: 1, truncated: false } });
  });
  it("messages filter by tenant and date range", async () => {
    db.message.findMany.mockResolvedValueOnce([]);
    const range = parseRange({ from: "2026-03-01", to: "2026-03-02", tz: "UTC" });
    await read(messagesCsv(actor, range));
    const where = db.message.findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe("t1");
    expect(where.createdAt).toEqual({ gte: range.start, lt: range.end });
    expect(auth.audit.mock.calls[0][0].action).toBe("export.messages");
    expect(JSON.stringify(auth.audit.mock.calls[0][0])).not.toContain("body");
  });
  it("workspace json is valid and tenant scoped", async () => {
    db.contact.findMany.mockResolvedValueOnce([{ id: "c1", phone: "+1" }]);
    const others = [db.conversation, db.message, db.template, db.broadcast, db.broadcastRecipient, db.note, db.lead, db.quickReply, db.team, db.teamMember, db.segment, db.replyMaterial, db.automationRule];
    for (const m of others) m.findMany.mockResolvedValue([]);
    const text = await read(workspaceJson(actor, new Date("2026-03-01T00:00:00Z")));
    const parsed = JSON.parse(text);
    expect(parsed.contacts).toEqual([{ id: "c1", phone: "+1" }]);
    expect(Object.keys(parsed)).toEqual(["exportedAt", "workspaceId", "contacts", "conversations", "messages", "templates", "broadcasts", "broadcastRecipients", "notes", "leads", "quickReplies", "teams", "teamMembers", "segments", "replyMaterials", "automationRules", "truncatedSections"]);
    expect(parsed.truncatedSections).toEqual([]);
    for (const m of [db.contact, ...others]) expect(m.findMany.mock.calls[0][0].where.tenantId).toBe("t1");
    expect(auth.audit.mock.calls[0][0]).toMatchObject({ action: "export.workspace", meta: { contacts: 1 } });
  });
  it("workspace json names any section that hit the row cap, inside the file and in the audit row", async () => {
    const others = [db.conversation, db.message, db.template, db.broadcast, db.broadcastRecipient, db.note, db.lead, db.quickReply, db.team, db.teamMember, db.segment, db.replyMaterial, db.automationRule];
    for (const m of others) m.findMany.mockResolvedValue([]);
    let n = 0;
    db.contact.findMany.mockImplementation(async (args: { take: number }) => Array.from({ length: args.take }, () => ({ id: `c${++n}` })));
    const parsed = JSON.parse(await read(workspaceJson(actor, new Date("2026-03-01T00:00:00Z"))));
    expect(parsed.truncatedSections).toEqual(["contacts"]);
    expect(parsed.note).toBe(TRUNCATION_NOTE);
    expect(parsed.contacts.at(-1)).toEqual({ _truncated: true, _note: TRUNCATION_NOTE });
    expect(parsed.contacts).toHaveLength(200_001);
    expect(auth.audit.mock.calls[0][0].meta).toMatchObject({ truncated: true, truncatedSections: "contacts" });
  });
  it("workspace json audits a download the reader walked away from", async () => {
    const others = [db.conversation, db.message, db.template, db.broadcast, db.broadcastRecipient, db.note, db.lead, db.quickReply, db.team, db.teamMember, db.segment, db.replyMaterial, db.automationRule];
    for (const m of others) m.findMany.mockResolvedValue([]);
    db.contact.findMany.mockResolvedValue(Array.from({ length: 1000 }, (_, i) => ({ id: `c${i}` })));
    const reader = workspaceJson(actor).getReader();
    await reader.read();
    await reader.cancel();
    expect(auth.audit.mock.calls[0][0]).toMatchObject({ action: "export.workspace", meta: { aborted: true } });
  });
});

describe("export routes", () => {
  it("require owner or admin", async () => {
    auth.getActor.mockResolvedValue({ ...actor, role: "agent" });
    const cases = [
      [contactsRoute, "/api/export/contacts.csv"],
      [broadcastsRoute, "/api/export/broadcasts.csv"],
      [messagesRoute, "/api/export/messages.csv?from=2026-03-01&to=2026-03-02"],
      [workspaceRoute, "/api/export/workspace.json"],
    ] as const;
    for (const [route, path] of cases) expect((await route(req(path))).status).toBe(403);
    expect(db.contact.findMany).not.toHaveBeenCalled();
  });
  it("messages export requires a valid range of at most 366 days", async () => {
    auth.getActor.mockResolvedValue(actor);
    expect((await messagesRoute(req("/api/export/messages.csv"))).status).toBe(400);
    expect((await messagesRoute(req("/api/export/messages.csv?from=2024-01-01&to=2026-01-01"))).status).toBe(400);
  });
  it("returns attachment headers for admins", async () => {
    auth.getActor.mockResolvedValue(actor);
    db.contact.findMany.mockResolvedValue([]);
    const res = await contactsRoute(req("/api/export/contacts.csv"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("contacts.csv");
    expect(res.headers.get("cache-control")).toBe("no-store");
    await read(res.body!);
  });
  it("passes a 401 through when not signed in", async () => {
    const { HttpError } = await import("@/lib/tenancy");
    auth.getActor.mockRejectedValue(new HttpError(401, "Not signed in."));
    expect((await contactsRoute(req("/api/export/contacts.csv"))).status).toBe(401);
  });
});
