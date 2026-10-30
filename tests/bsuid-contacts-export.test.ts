import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), delete: vi.fn(), count: vi.fn(), upsert: vi.fn() });
  const tables = {
    contact: model(),
    conversation: model(),
    message: model(),
    note: model(),
    automationRun: model(),
    ruleExecution: model(),
    broadcastRecipient: model(),
    phoneNumber: model(),
    membership: model(),
    auditLog: model(),
    $transaction: undefined as unknown as (fn: (tx: unknown) => unknown) => unknown,
  };
  tables.$transaction = (fn) => fn(tables);
  return tables;
});
const auth = vi.hoisted(() => ({ audit: vi.fn() }));
const templateSend = vi.hoisted(() => ({ sendConversationTemplate: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
// Contact erasure also clears Eddy's rows in the same transaction (EDDY-16); that is tested in tests/lifecycle-eddy-erasure.test.ts.
vi.mock("@/lib/eddy/erasure-sweep", () => ({ eraseContactFromEddy: vi.fn(async () => ({ conversations: 0, messages: 0, actionRecords: 0, notices: 0 })) }));
vi.mock("@/lib/auth/audit", () => ({ audit: auth.audit }));
vi.mock("@/lib/billing", () => ({ assertWithinLimit: vi.fn(async () => undefined) }));
vi.mock("@/lib/inbox/template-send", () => templateSend);
vi.mock("@/lib/inbox/media", () => ({ removeInboundMediaFiles: vi.fn(async () => 0) }));
vi.mock("@/lib/integrations/apikeys", () => ({ revokeKeysBestEffort: vi.fn() }));
vi.mock("@/lib/contacts/consent", () => ({ consentRecordedBy: vi.fn(async () => new Map()), CONSENT_ACTIONS: [] }));
vi.mock("@/lib/inbox/marks", () => ({ listMembers: vi.fn(async () => []) }));

import { contactsCsv } from "@/lib/reports/export";
import { buildChatExport, exportFileName, renderTranscript } from "@/lib/inbox/export";
import { startChat } from "@/lib/inbox/new-chat";
import { deleteContactData } from "@/lib/lifecycle/erasure";
import { conditionMatches } from "@/lib/segments/filter";
import { PERSONAL_DATA } from "@/lib/lifecycle/personal-data";

const BSUID = "IN.13491208655302741918";
const actor = { userId: "u1", tenantId: "t1", role: "admin" as const };

const read = async (s: ReadableStream<Uint8Array>) => {
  const reader = s.getReader();
  const dec = new TextDecoder("utf-8", { ignoreBOM: true });
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += dec.decode(value);
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction = (fn) => fn(db);
});

describe("contacts export", () => {
  it("has bsuid and username columns and an empty phone for a username-only contact", async () => {
    const row = { id: "c1", phone: null, name: "Asha", username: "asha.bakes", bsuid: BSUID, tags: [], optIn: true, optInSource: "form", optInAt: null, optedOutAt: null, createdAt: new Date("2026-01-02"), attributes: {} };
    db.contact.findMany.mockResolvedValueOnce([row]).mockResolvedValue([]);
    const text = await read(contactsCsv(actor));
    const [head, line] = text.replace(/^﻿/, "").trim().split("\r\n");
    expect(head.split(",").slice(0, 4)).toEqual(["phone", "name", "username", "bsuid"]);
    expect(line.startsWith(`,Asha,asha.bakes,${BSUID},`)).toBe(true);
  });
});

describe("chat transcript for a contact without a phone", () => {
  it("names the file and the header without a phone", () => {
    expect(exportFileName("Asha Rao", null, "txt", new Date("2026-03-01T00:00:00Z"))).toBe("chat-Asha-Rao-2026-03-01.txt");
    expect(exportFileName(null, null, "json", new Date("2026-03-01T00:00:00Z"))).toBe("chat-chat-2026-03-01.json");
    const text = renderTranscript({ contact: "@asha", phone: null, number: null, exportedAt: new Date("2026-03-01T00:00:00Z"), truncated: false }, []);
    expect(text.split("\n")[0]).toBe("Chat with @asha");
  });

  it("builds a text and a json export from a username-only contact without throwing", async () => {
    db.conversation.findFirst.mockResolvedValue({
      id: "cv1", status: "open", tags: [], createdAt: new Date("2026-01-01"),
      contact: { name: null, phone: null, bsuid: BSUID, username: "asha.bakes" },
      phoneNumber: { displayPhone: "+91 99999 00000" },
    });
    db.message.findMany.mockResolvedValue([{ id: "m1", direction: "inbound", type: "text", body: "hello", status: "received", createdAt: new Date("2026-01-01T10:00:00Z"), sentByUserId: null, mediaMime: null, templateName: null }]);
    const txt = await buildChatExport("t1", "cv1", { format: "txt", includeNotes: false });
    expect(txt.body).toContain("Chat with @asha.bakes");
    expect(txt.body).toContain("@asha.bakes: hello");
    expect(txt.fileName).toContain("asha-bakes");
    const json = JSON.parse((await buildChatExport("t1", "cv1", { format: "json", includeNotes: false })).body as string);
    expect(json.conversation.contact).toEqual({ name: null, phone: null, username: "asha.bakes", bsuid: BSUID });
  });

  it("still masks a phone that exists", async () => {
    db.conversation.findFirst.mockResolvedValue({
      id: "cv1", status: "open", tags: [], createdAt: new Date("2026-01-01"),
      contact: { name: "Asha", phone: "+919876543210", bsuid: null, username: null },
      phoneNumber: { displayPhone: "+91 99999 00000" },
    });
    db.message.findMany.mockResolvedValue([]);
    const out = await buildChatExport("t1", "cv1", { format: "txt", includeNotes: false, masked: true });
    expect(out.body).toContain("+919*****3210");
    expect(out.body).not.toContain("9876543210");
  });
});

describe("starting a chat by BSUID", () => {
  beforeEach(() => {
    db.phoneNumber.findMany.mockResolvedValue([{ id: "ph1" }]);
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", assignedToId: "u1" });
    templateSend.sendConversationTemplate.mockResolvedValue({ id: "m1" });
  });

  it("uses the existing contact that has this BSUID and never creates one", async () => {
    db.contact.findFirst.mockResolvedValue({ id: "cb", optIn: true, optedOutAt: null });
    const out = await startChat(actor, { bsuid: BSUID, templateId: "tp1" });
    expect(db.contact.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", bsuid: BSUID } }));
    expect(db.contact.create).not.toHaveBeenCalled();
    expect(out.conversation).toEqual({ id: "cv1", contactId: "cb" });
  });

  it("404s for a BSUID nobody has used with this workspace, 400s for one that is malformed", async () => {
    db.contact.findFirst.mockResolvedValue(null);
    await expect(startChat(actor, { bsuid: BSUID, templateId: "tp1" })).rejects.toMatchObject({ status: 404 });
    await expect(startChat(actor, { bsuid: "12345", templateId: "tp1" })).rejects.toMatchObject({ status: 400 });
    expect(db.contact.create).not.toHaveBeenCalled();
  });
});

describe("erasure by BSUID", () => {
  it("finds the contact by its BSUID inside the workspace and removes it with its chats", async () => {
    db.contact.findUnique.mockResolvedValue({ id: "cb" });
    db.conversation.findMany.mockResolvedValue([{ id: "cv1" }]);
    db.message.findMany.mockResolvedValue([{ id: "m1" }]);
    expect(await deleteContactData("t1", { bsuid: BSUID })).toEqual({ deleted: true });
    expect(db.contact.findUnique).toHaveBeenCalledWith({ where: { tenantId_bsuid: { tenantId: "t1", bsuid: BSUID } }, select: { id: true } });
    expect(db.message.deleteMany).toHaveBeenCalledWith({ where: { tenantId: "t1", conversationId: { in: ["cv1"] } } });
    expect(db.contact.delete).toHaveBeenCalledWith({ where: { id: "cb" } });
  });

  it("still takes a plain phone string as before", async () => {
    db.contact.findUnique.mockResolvedValue(null);
    expect(await deleteContactData("t1", "+911")).toEqual({ deleted: false });
    expect(db.contact.findUnique).toHaveBeenCalledWith({ where: { tenantId_phone: { tenantId: "t1", phone: "+911" } }, select: { id: true } });
  });

  it("lists the username, BSUID and WhatsApp id in the personal data registry", () => {
    const contact = PERSONAL_DATA.find((e) => e.id === "Contact");
    expect(contact?.holds).toMatch(/username/);
    expect(contact?.holds).toMatch(/BSUID/);
    expect(contact?.holds).toMatch(/absent/);
  });
});

describe("country segment for a contact without a phone", () => {
  const snap = (over: Record<string, unknown>) => ({ name: null, phone: null, bsuid: null, tags: [], attributes: {}, optInSource: null, optInAt: null, createdAt: new Date(), leadStage: null, ownerUserId: null, lastInboundAt: null, ...over });

  it("reads the country from the BSUID prefix", () => {
    expect(conditionMatches(snap({ bsuid: BSUID }), { field: "country", op: "is", value: "IN" })).toBe(true);
    expect(conditionMatches(snap({ bsuid: BSUID }), { field: "country", op: "is", value: "US" })).toBe(false);
    expect(conditionMatches(snap({ bsuid: BSUID }), { field: "country", op: "is_not", value: "US" })).toBe(true);
  });

  it("prefers the phone when there is one", () => {
    expect(conditionMatches(snap({ phone: "+14155550100", bsuid: BSUID }), { field: "country", op: "is", value: "US" })).toBe(true);
    expect(conditionMatches(snap({ phone: "+14155550100", bsuid: BSUID }), { field: "country", op: "is", value: "IN" })).toBe(false);
  });
});
