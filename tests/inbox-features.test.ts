import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    count: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  });
  return {
    savedInboxFilter: model(),
    platformSetting: model(),
    user: model(),
    phoneNumber: model(),
    contact: model(),
    conversation: model(),
    conversationMark: model(),
    message: model(),
    note: model(),
    membership: model(),
  };
});
const audit = vi.hoisted(() => vi.fn());
const billing = vi.hoisted(() => ({ assertWithinLimit: vi.fn() }));
const templateSend = vi.hoisted(() => ({ sendConversationTemplate: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth/audit", () => ({ audit }));
vi.mock("@/lib/billing", () => billing);
vi.mock("@/lib/inbox/template-send", () => templateSend);

import { buildChatExport, exportFileName, renderTranscript } from "@/lib/inbox/export";
import { createSavedFilter, deleteSavedFilter, listSavedFilters, parseSavedQuery, queryToParams } from "@/lib/inbox/filters";
import { startChat } from "@/lib/inbox/new-chat";
import { buildSendBody, withSignature } from "@/lib/inbox/send";
import { cleanSettings, DEFAULT_INBOX_SETTINGS, getInboxSettings, parseSettingsPatch, signatureForUser, signatureFor, updateInboxSettings } from "@/lib/inbox/settings";
import type { Actor } from "@/lib/tenancy";

const agent: Actor = { userId: "u2", tenantId: "t1", role: "agent" };
const admin: Actor = { userId: "u1", tenantId: "t1", role: "admin" };

beforeEach(() => {
  vi.clearAllMocks();
  db.savedInboxFilter.findMany.mockResolvedValue([]);
  db.savedInboxFilter.count.mockResolvedValue(0);
});

describe("saved views", () => {
  it("accepts only known tabs and short text, and turns a view back into list parameters", () => {
    expect(parseSavedQuery({ tab: "favorite", tag: " vip ", q: "invoice" })).toEqual({ tab: "favorite", tag: "vip", q: "invoice" });
    expect(parseSavedQuery({})).toEqual({ tab: "all" });
    expect(() => parseSavedQuery({ tab: "everything" })).toThrow(/not available/);
    expect(() => parseSavedQuery({ tab: "all", q: "x".repeat(101) })).toThrow(/100 characters/);
    expect(() => parseSavedQuery("nope")).toThrow(/object/);
    expect(queryToParams({ tab: "mine", tag: "vip" })).toEqual({ assigned: "me", tag: "vip" });
    expect(queryToParams({ tab: "campaign" })).toEqual({ view: "campaign" });
    expect(queryToParams({ tab: "expired", q: "a" })).toEqual({ expired: "1", q: "a" });
    expect(queryToParams({ tab: "blocked" })).toEqual({ status: "blocked" });
  });

  it("lists the caller's own views and the shared ones, for this workspace only", async () => {
    db.savedInboxFilter.findMany.mockResolvedValue([
      { id: "f1", name: "Mine", userId: "u2", query: { tab: "unread" } },
      { id: "f2", name: "Team", userId: "*", query: { tab: "new" } },
    ]);
    const out = await listSavedFilters("t1", "u2");
    expect(db.savedInboxFilter.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", userId: { in: ["u2", "*"] } } }));
    expect(out).toEqual([
      { id: "f1", name: "Mine", query: { tab: "unread" }, shared: false, mine: true },
      { id: "f2", name: "Team", query: { tab: "new" }, shared: true, mine: false },
    ]);
  });

  it("saves a personal view for any agent and refuses to share without admin rights", async () => {
    db.savedInboxFilter.create.mockImplementation(async ({ data }) => ({ id: "f9", ...data }));
    const own = await createSavedFilter(agent, { name: "  Unread VIPs ", query: { tab: "unread", tag: "vip" } });
    expect(db.savedInboxFilter.create).toHaveBeenCalledWith({ data: { tenantId: "t1", userId: "u2", name: "Unread VIPs", query: { tab: "unread", tag: "vip" } } });
    expect(own).toMatchObject({ shared: false, mine: true });
    await expect(createSavedFilter(agent, { name: "x", query: { tab: "all" }, shared: true })).rejects.toMatchObject({ status: 403 });
    const shared = await createSavedFilter(admin, { name: "Everyone", query: { tab: "new" }, shared: true });
    expect(db.savedInboxFilter.create.mock.calls.at(-1)?.[0].data.userId).toBe("*");
    expect(shared.shared).toBe(true);
  });

  it("validates the name and caps the number of views", async () => {
    await expect(createSavedFilter(agent, { name: " ", query: { tab: "all" } })).rejects.toMatchObject({ status: 400 });
    await expect(createSavedFilter(agent, { name: "x".repeat(41), query: { tab: "all" } })).rejects.toMatchObject({ status: 400 });
    db.savedInboxFilter.count.mockResolvedValue(25);
    await expect(createSavedFilter(agent, { name: "one more", query: { tab: "all" } })).rejects.toMatchObject({ status: 409 });
  });

  it("deletes your own view, and a shared one only as an admin; never another workspace's", async () => {
    db.savedInboxFilter.findFirst.mockResolvedValue({ id: "f1", userId: "u2" });
    await deleteSavedFilter(agent, "f1");
    expect(db.savedInboxFilter.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "f1", tenantId: "t1", userId: { in: ["u2", "*"] } } }));
    expect(db.savedInboxFilter.deleteMany).toHaveBeenCalledWith({ where: { id: "f1", tenantId: "t1" } });
    db.savedInboxFilter.findFirst.mockResolvedValue({ id: "f2", userId: "*" });
    await expect(deleteSavedFilter(agent, "f2")).rejects.toMatchObject({ status: 403 });
    await expect(deleteSavedFilter(admin, "f2")).resolves.toBeUndefined();
    db.savedInboxFilter.findFirst.mockResolvedValue(null);
    await expect(deleteSavedFilter(agent, "other")).rejects.toMatchObject({ status: 404 });
  });
});

describe("inbox settings and the agent signature", () => {
  it("falls back to safe defaults for missing or damaged values", () => {
    expect(cleanSettings(null)).toEqual(DEFAULT_INBOX_SETTINGS);
    expect(cleanSettings({ agentSignature: "yes", optOutReply: 5 })).toEqual(DEFAULT_INBOX_SETTINGS);
    expect(cleanSettings({ agentSignature: true, optOutReply: "  Bye  ", optInReply: "" })).toEqual({ agentSignature: true, optOutReply: "Bye", optInReply: "", stopWords: [] });
  });

  it("the default STOP confirmation says what an opt-out does (owner default 1), and an old saved default reads as the new one", () => {
    expect(DEFAULT_INBOX_SETTINGS.optOutReply).toMatch(/not get marketing messages/);
    expect(DEFAULT_INBOX_SETTINGS.optOutReply).toMatch(/Order updates and replies to your own messages can still arrive/);
    expect(DEFAULT_INBOX_SETTINGS.optOutReply).toMatch(/Send START to get offers again/);
    const old = cleanSettings({
      optOutReply: "You have been unsubscribed and will not get marketing messages from us. Reply START to subscribe again.",
      optInReply: "You are subscribed again. Reply STOP at any time to unsubscribe.",
    });
    expect(old.optOutReply).toBe(DEFAULT_INBOX_SETTINGS.optOutReply);
    expect(old.optInReply).toBe(DEFAULT_INBOX_SETTINGS.optInReply);
    expect(cleanSettings({ optOutReply: "Our own words" }).optOutReply).toBe("Our own words");
  });

  it("keeps the workspace's STOP words normalised, without defaults, duplicates, START words or junk", () => {
    expect(cleanSettings({ stopWords: [" Band Karo! ", "band karo", "STOP", "opt-out", "start", 7, "", "x".repeat(41), "nahi chahiye"] }).stopWords).toEqual(["band karo", "nahi chahiye"]);
    expect(cleanSettings({ stopWords: "stop" }).stopWords).toEqual([]);
    expect(cleanSettings({ stopWords: Array.from({ length: 30 }, (_, i) => `w${i}`) }).stopWords).toHaveLength(20);
  });

  it("validates STOP words from the form and says what is wrong", () => {
    expect(parseSettingsPatch({ stopWords: ["Band karo", "STOP"] })).toEqual({ stopWords: ["band karo"] });
    expect(parseSettingsPatch({ stopWords: [] })).toEqual({ stopWords: [] });
    expect(() => parseSettingsPatch({ stopWords: "band karo" })).toThrow(/list of words/);
    expect(() => parseSettingsPatch({ stopWords: ["ok", 5] })).toThrow(/must be text/);
    expect(() => parseSettingsPatch({ stopWords: ["Start"] })).toThrow(/cannot also be a STOP word/);
    expect(() => parseSettingsPatch({ stopWords: ["..."] })).toThrow(/letter or number/);
    expect(() => parseSettingsPatch({ stopWords: Array.from({ length: 21 }, (_, i) => `w${i}`) })).toThrow(/up to 20/);
  });

  it("reads one row per workspace and survives a database error", async () => {
    db.platformSetting.findUnique.mockResolvedValue({ value: { agentSignature: true } });
    expect((await getInboxSettings("t1")).agentSignature).toBe(true);
    expect(db.platformSetting.findUnique).toHaveBeenCalledWith({ where: { key: "inbox:settings:t1" } });
    db.platformSetting.findUnique.mockRejectedValue(new Error("down"));
    expect(await getInboxSettings("t1")).toEqual(DEFAULT_INBOX_SETTINGS);
  });

  it("validates updates and merges them into the stored settings", async () => {
    expect(() => parseSettingsPatch({})).toThrow(/Nothing/);
    expect(() => parseSettingsPatch({ agentSignature: "on" })).toThrow(/true or false/);
    expect(() => parseSettingsPatch({ optOutReply: "x".repeat(501) })).toThrow(/500/);
    db.platformSetting.findUnique.mockResolvedValue({ value: { agentSignature: false, optOutReply: "Old" } });
    const next = await updateInboxSettings("t1", parseSettingsPatch({ agentSignature: true, optInReply: "" }));
    expect(next).toMatchObject({ agentSignature: true, optOutReply: "Old", optInReply: "" });
    expect(db.platformSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { key: "inbox:settings:t1" }, update: { value: next } }));
  });

  it("signs only when the option is on, with a clean name", async () => {
    expect(signatureFor({ ...DEFAULT_INBOX_SETTINGS, agentSignature: false }, "Priya")).toBeUndefined();
    expect(signatureFor({ ...DEFAULT_INBOX_SETTINGS, agentSignature: true }, " *Priya*\nShah ")).toBe("Priya Shah");
    expect(signatureFor({ ...DEFAULT_INBOX_SETTINGS, agentSignature: true }, "  ")).toBeUndefined();
    db.platformSetting.findUnique.mockResolvedValue({ value: { agentSignature: true } });
    db.user.findUnique.mockResolvedValue({ name: "Priya Shah" });
    expect(await signatureForUser("t1", "u2")).toBe("Priya Shah");
    db.platformSetting.findUnique.mockResolvedValue(null);
    expect(await signatureForUser("t1", "u2")).toBeUndefined();
  });

  it("puts the name in bold above the text when sending, within the WhatsApp limit", () => {
    expect(withSignature("Hello", "Priya")).toBe("*Priya*\nHello");
    expect(withSignature("Hello", undefined)).toBe("Hello");
    expect(withSignature("x".repeat(4096), "Priya")).toHaveLength(4096);
    const row = { type: "text", body: "Hello", mediaUrl: null, mediaMime: null };
    expect((buildSendBody("+919876543210", row, { signature: "Priya" }) as Record<string, unknown>).text).toEqual({ body: "*Priya*\nHello", preview_url: false });
    expect((buildSendBody("+919876543210", row, {}) as Record<string, unknown>).text).toEqual({ body: "Hello", preview_url: false });
  });
});

describe("chat export", () => {
  const conversation = { id: "cv1", status: "open", tags: ["vip"], createdAt: new Date("2026-10-01T10:00:00Z"), contact: { name: "Asha Rao", phone: "+919876543210" }, phoneNumber: { displayPhone: "+91 11 2222 3333" } };
  const messages = [
    { id: "m2", direction: "outbound", type: "text", body: "Sure, sending it now", status: "read", createdAt: new Date("2026-10-27T09:05:00Z"), sentByUserId: "u2", mediaMime: null, templateName: null },
    { id: "m1", direction: "inbound", type: "image", body: "[image] my receipt", status: "received", createdAt: new Date("2026-10-27T09:00:00Z"), sentByUserId: null, mediaMime: "image/jpeg", templateName: null },
  ];
  const now = new Date("2026-10-27T12:00:00Z");

  beforeEach(() => {
    db.conversation.findFirst.mockResolvedValue({ ...conversation, contact: { ...conversation.contact } });
    db.membership.findMany.mockResolvedValue([{ userId: "u2", user: { name: "Priya Shah" } }]);
    db.message.findMany.mockResolvedValue(messages);
    db.note.findMany.mockResolvedValue([{ id: "n1", authorId: "u2", body: "Customer is a VIP", createdAt: new Date("2026-10-27T09:06:00Z") }]);
  });

  it("writes a text transcript oldest first, naming the customer and the teammate", async () => {
    const file = await buildChatExport("t1", "cv1", { format: "txt", includeNotes: false, now });
    expect(db.conversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "cv1", tenantId: "t1" } }));
    expect(db.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", conversationId: "cv1" } }));
    expect(file.fileName).toBe("chat-Asha-Rao-2026-10-27.txt");
    expect(file.contentType).toMatch(/text\/plain/);
    const lines = file.body.trim().split("\n");
    expect(lines[0]).toBe("Chat with Asha Rao (+919876543210)");
    expect(file.body).toContain("[2026-10-27 09:00 UTC] Asha Rao: [image] my receipt");
    expect(file.body).toContain("[2026-10-27 09:05 UTC] Priya Shah: Sure, sending it now");
    expect(file.body.indexOf("my receipt")).toBeLessThan(file.body.indexOf("sending it now"));
    expect(file.body).not.toContain("VIP");
    expect(db.note.findMany).not.toHaveBeenCalled();
  });

  it("includes private notes only when asked, marked as internal", async () => {
    const file = await buildChatExport("t1", "cv1", { format: "txt", includeNotes: true, now });
    expect(db.note.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", conversationId: "cv1" } }));
    expect(file.body).toContain("Internal note, Priya Shah: Customer is a VIP");
  });

  it("writes JSON with a stable shape and no media links", async () => {
    const file = await buildChatExport("t1", "cv1", { format: "json", includeNotes: false, now });
    const json = JSON.parse(file.body);
    expect(json.conversation).toMatchObject({ id: "cv1", contact: { name: "Asha Rao", phone: "+919876543210" } });
    expect(json.items).toHaveLength(2);
    expect(json.items[0]).toMatchObject({ id: "m1", direction: "inbound", from: "Asha Rao", type: "image", hasMedia: true });
    expect(JSON.stringify(json)).not.toMatch(/mediaUrl|meta-media/);
    expect(file.fileName.endsWith(".json")).toBe(true);
  });

  it("hides the phone number from agents whose numbers are masked", async () => {
    db.conversation.findFirst.mockResolvedValue({ ...conversation, contact: { name: null, phone: "+919876543210" } });
    const file = await buildChatExport("t1", "cv1", { format: "txt", includeNotes: false, masked: true, now });
    expect(file.body).not.toContain("919876543210");
    expect(file.body).toContain("+919*****3210");
  });

  it("404s for a chat of another workspace", async () => {
    db.conversation.findFirst.mockResolvedValue(null);
    await expect(buildChatExport("t1", "foreign", { format: "txt", includeNotes: false })).rejects.toMatchObject({ status: 404 });
    expect(db.message.findMany).not.toHaveBeenCalled();
  });

  it("builds safe file names and says when the chat was cut short", () => {
    expect(exportFileName("Zoë / O'Neil", "+911", "txt", now)).toBe("chat-Zoe-O-Neil-2026-10-27.txt");
    expect(exportFileName(null, "+919876543210", "json", now)).toBe("chat-919876543210-2026-10-27.json");
    const text = renderTranscript({ contact: "A", phone: "+1", number: null, exportedAt: now, truncated: true }, []);
    expect(text).toMatch(/Only the newest 10000 messages/);
  });
});

describe("startChat", () => {
  const sent = { id: "m1", type: "template" };

  beforeEach(() => {
    db.phoneNumber.findMany.mockResolvedValue([{ id: "ph1" }]);
    db.phoneNumber.findFirst.mockResolvedValue({ id: "ph1" });
    db.contact.findFirst.mockResolvedValue(null);
    db.contact.create.mockResolvedValue({ id: "c1", optIn: false, optedOutAt: null });
    db.conversation.findFirst.mockResolvedValue(null);
    db.conversation.upsert.mockResolvedValue({ id: "cv1", assignedToId: "u2" });
    templateSend.sendConversationTemplate.mockResolvedValue(sent);
  });

  it("creates the contact from a typed number, opens the chat for the agent and sends the template", async () => {
    const out = await startChat(agent, { phone: "98765 43210", name: " Asha ", templateId: "tp1", variables: ["Asha"] });
    expect(db.contact.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", phone: "+919876543210" } }));
    expect(billing.assertWithinLimit).toHaveBeenCalledWith("t1", "contacts");
    expect(db.contact.create).toHaveBeenCalledWith(expect.objectContaining({ data: { tenantId: "t1", phone: "+919876543210", name: "Asha" } }));
    expect(db.conversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ tenantId: "t1", phoneNumberId: "ph1", contactId: "c1", assignedToId: "u2" }) }),
    );
    expect(templateSend.sendConversationTemplate).toHaveBeenCalledWith(agent, "cv1", { templateId: "tp1", variables: ["Asha"] }, { origin: "human" });
    expect(out).toEqual({ conversation: { id: "cv1", contactId: "c1" }, message: sent });
  });

  it("uses an existing contact without creating one or touching the plan limit", async () => {
    db.contact.findFirst.mockResolvedValue({ id: "c7", optIn: true, optedOutAt: null });
    await startChat(agent, { contactId: "c7", templateId: "tp1" });
    expect(db.contact.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c7", tenantId: "t1" } }));
    expect(db.contact.create).not.toHaveBeenCalled();
    expect(billing.assertWithinLimit).not.toHaveBeenCalled();
  });

  it("takes over an unassigned existing chat for the agent who messaged first", async () => {
    db.contact.findFirst.mockResolvedValue({ id: "c7", optIn: true, optedOutAt: null });
    db.conversation.findFirst.mockResolvedValue({ id: "cv5", assignedToId: null });
    await startChat(agent, { contactId: "c7", templateId: "tp1" });
    expect(db.conversation.upsert).not.toHaveBeenCalled();
    expect(db.conversation.updateMany).toHaveBeenCalledWith({ where: { id: "cv5", tenantId: "t1", assignedToId: null }, data: { assignedToId: "u2", assignedAt: expect.any(Date) } });
  });

  it("rejects a bad number, a missing template and unknown contacts or numbers", async () => {
    await expect(startChat(agent, { phone: "abc", templateId: "tp1" })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/country code/) });
    await expect(startChat(agent, { phone: "+919876543210" })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/template/) });
    await expect(startChat(agent, { contactId: "nope", templateId: "tp1" })).rejects.toMatchObject({ status: 404 });
    db.phoneNumber.findFirst.mockResolvedValue(null);
    await expect(startChat(agent, { phone: "+919876543210", phoneNumberId: "foreign", templateId: "tp1" })).rejects.toMatchObject({ status: 404 });
    expect(db.phoneNumber.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "foreign", tenantId: "t1" } }));
    expect(templateSend.sendConversationTemplate).not.toHaveBeenCalled();
  });

  it("asks which number to use when several are connected, and stops when none is", async () => {
    db.phoneNumber.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    await expect(startChat(agent, { phone: "+919876543210", templateId: "tp1" })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Choose which number/) });
    db.phoneNumber.findMany.mockResolvedValue([]);
    await expect(startChat(agent, { phone: "+919876543210", templateId: "tp1" })).rejects.toMatchObject({ status: 409 });
    expect(db.phoneNumber.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", status: "connected" } }));
  });

  it("removes the contact and chat it created when the send is refused (opt-in rules)", async () => {
    templateSend.sendConversationTemplate.mockRejectedValue(Object.assign(new Error("not opted in"), { status: 422 }));
    await expect(startChat(agent, { phone: "+919876543210", templateId: "tp1" })).rejects.toMatchObject({ status: 422 });
    expect(db.conversation.deleteMany).toHaveBeenCalledWith({ where: { id: "cv1", tenantId: "t1" } });
    expect(db.contact.deleteMany).toHaveBeenCalledWith({ where: { id: "c1", tenantId: "t1" } });
  });

  it("keeps a contact and chat that already existed when the send is refused", async () => {
    db.contact.findFirst.mockResolvedValue({ id: "c7", optIn: false, optedOutAt: null });
    db.conversation.findFirst.mockResolvedValue({ id: "cv5", assignedToId: "u9" });
    templateSend.sendConversationTemplate.mockRejectedValue(new Error("refused"));
    await expect(startChat(agent, { contactId: "c7", templateId: "tp1" })).rejects.toThrow("refused");
    expect(db.conversation.deleteMany).not.toHaveBeenCalled();
    expect(db.contact.deleteMany).not.toHaveBeenCalled();
  });

  it("lets only an admin record that the person agreed to marketing, and never overrides an opt-out", async () => {
    await expect(startChat(agent, { phone: "+919876543210", templateId: "tp1", confirmOptIn: true })).rejects.toMatchObject({ status: 403 });
    await startChat(admin, { phone: "+919876543210", templateId: "tp1", confirmOptIn: true });
    expect(db.contact.updateMany).toHaveBeenCalledWith({ where: { id: "c1", tenantId: "t1" }, data: { optIn: true, optInSource: "agent_confirmed", optInAt: expect.any(Date) } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "contact.opt_in_confirmed", target: "c1", tenantId: "t1", userId: "u1" }));
    db.contact.updateMany.mockClear();
    db.contact.findFirst.mockResolvedValue({ id: "c8", optIn: false, optedOutAt: new Date() });
    await expect(startChat(admin, { contactId: "c8", templateId: "tp1", confirmOptIn: true })).rejects.toMatchObject({ status: 422 });
    expect(db.contact.updateMany).not.toHaveBeenCalled();
  });
});
