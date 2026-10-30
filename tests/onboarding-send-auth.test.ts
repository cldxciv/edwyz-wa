import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  message: { findFirst: vi.fn(), updateMany: vi.fn() },
  platformSetting: { upsert: vi.fn(), deleteMany: vi.fn() },
  accessToken: { findFirst: vi.fn() },
}));
const graphFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/integrations/events", () => ({ emitEvent: async () => undefined }));
vi.mock("@/lib/graph", async () => ({ ...(await vi.importActual<object>("@/lib/graph")), graphFetch }));
// The spend send gate (docs/SPEND-CONTROLS-SPEC.md 4.9) is covered by spend-messaging.test.ts and inbox-send.test.ts; here it lets the send through.
vi.mock("@/lib/spend/messaging/gate", () => ({ messagingGate: async () => ({ action: "send", overLimit: false, spend: {}, run: (fn: () => unknown) => fn() }), finishSend: async () => undefined }));

import { NoValidTokenError } from "@/lib/crypto/tokens";
import { GraphError } from "@/lib/graph";
import { processSendJob } from "@/lib/inbox/send";
import { resetTokenWorksThrottle } from "@/lib/onboarding/token-health";
import { failureHint } from "@/components/inbox/ux";

const row = {
  id: "m1",
  status: "queued",
  wamid: null,
  type: "text",
  body: "hello",
  mediaUrl: null,
  mediaMime: null,
  statusTimeline: [],
  conversation: { contact: { phone: "+919876543210" }, phoneNumber: { phoneNumberId: "meta_phone_1" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  db.message.findFirst.mockResolvedValue(row);
  db.message.updateMany.mockResolvedValue({ count: 1 });
  db.platformSetting.upsert.mockResolvedValue({});
  db.platformSetting.deleteMany.mockResolvedValue({ count: 0 });
  // The workspace token was stored long before any send in these tests.
  db.accessToken.findFirst.mockResolvedValue({ id: "tok", createdAt: new Date(Date.now() - 86_400_000), expiresAt: null });
  resetTokenWorksThrottle();
});

describe("a send that fails because the WhatsApp token is bad", () => {
  it("error 190 fails the message with code 190, remembers the rejection for this workspace and does not retry", async () => {
    graphFetch.mockRejectedValue(new GraphError("Error validating access token: Session has expired", 400, 190));
    await processSendJob({ messageId: "m1", tenantId: "t1" });
    expect(graphFetch).toHaveBeenCalledTimes(1);
    expect(db.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "m1", tenantId: "t1" }, data: expect.objectContaining({ status: "failed", errorCode: "190" }) }));
    expect(db.platformSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { key: "wa-auth-rejected:t1" } }));
  });

  it("an expired stored token fails the message as auth_expired", async () => {
    graphFetch.mockRejectedValue(new NoValidTokenError());
    await processSendJob({ messageId: "m1", tenantId: "t1" });
    expect(db.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed", errorCode: "auth_expired" }) }));
  });

  it("other failures do not mark the connection as rejected", async () => {
    graphFetch.mockRejectedValue(new GraphError("24h window", 400, 131047));
    await processSendJob({ messageId: "m1", tenantId: "t1" });
    expect(db.platformSetting.upsert).not.toHaveBeenCalled();
  });

  it("a failing flag write never changes how the send ends", async () => {
    graphFetch.mockRejectedValue(new GraphError("expired", 400, 190));
    db.platformSetting.upsert.mockRejectedValue(new Error("db"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await processSendJob({ messageId: "m1", tenantId: "t1" });
    expect(db.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ errorCode: "190" }) }));
    spy.mockRestore();
  });

  it("a 190 that comes back after a reconnect stored a newer token does not flag the new token", async () => {
    graphFetch.mockImplementation(async () => {
      // The reconnect finishes while the call is in flight.
      db.accessToken.findFirst.mockResolvedValue({ id: "new", createdAt: new Date(Date.now() + 5), expiresAt: null });
      throw new GraphError("Error validating access token", 400, 190);
    });
    await processSendJob({ messageId: "m1", tenantId: "t1" });
    expect(db.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed", errorCode: "190" }) }));
    expect(db.platformSetting.upsert).not.toHaveBeenCalled();
  });

  it("a send Meta accepts clears a rejected flag left by an earlier one-off 190, after the wamid is stored", async () => {
    graphFetch.mockResolvedValue({ messages: [{ id: "wamid.1" }] });
    await processSendJob({ messageId: "m1", tenantId: "t1" });
    expect(db.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "sent", wamid: "wamid.1" }) }));
    expect(db.platformSetting.deleteMany).toHaveBeenCalledWith({ where: { key: "wa-auth-rejected:t1" } });
    // The wamid goes in first so a status webhook arriving right after Meta's 200 finds its row; the flag clean-up follows.
    expect(db.message.updateMany.mock.invocationCallOrder[0]).toBeLessThan(db.platformSetting.deleteMany.mock.invocationCallOrder[0]);
  });

  it("a template queued before the contact sent STOP is failed at send time, not sent", async () => {
    db.message.findFirst.mockResolvedValue({ ...row, type: "template", conversation: { contact: { phone: "+919876543210", optedOutAt: new Date() }, phoneNumber: { phoneNumberId: "meta_phone_1" } } });
    await processSendJob({ messageId: "m1", tenantId: "t1", template: { name: "promo", language: "en", components: [] } });
    expect(graphFetch).not.toHaveBeenCalled();
    expect(db.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed", errorCode: "opted_out" }) }));
  });

  it("free-form replies inside the service window are not affected by that check", async () => {
    db.message.findFirst.mockResolvedValue({ ...row, conversation: { contact: { phone: "+919876543210", optedOutAt: new Date() }, phoneNumber: { phoneNumberId: "meta_phone_1" } } });
    graphFetch.mockResolvedValue({ messages: [{ id: "wamid.2" }] });
    await processSendJob({ messageId: "m1", tenantId: "t1" });
    expect(graphFetch).toHaveBeenCalledTimes(1);
  });

  it("the inbox explains both codes in plain words", () => {
    for (const code of ["190", "auth_expired"]) expect(failureHint(code)).toMatch(/reconnect WhatsApp in Settings/);
  });
});
