import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  phoneNumber: { findFirst: vi.fn() },
  broadcast: { updateMany: vi.fn() },
}));
const graph = vi.hoisted(() => {
  class GraphError extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  }
  return { graphUpload: vi.fn(), graphFetch: vi.fn(), GraphError };
});
const media = vi.hoisted(() => ({ downloadMetaMedia: vi.fn() }));
const auditMock = vi.hoisted(() => vi.fn(async () => {}));
const authMock = vi.hoisted(() => ({ role: "admin" as "admin" | "agent" }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/graph", () => graph);
vi.mock("@/lib/inbox/media", () => media);
vi.mock("@/lib/auth/audit", () => ({ audit: auditMock }));
vi.mock("@/lib/auth", () => ({ getActor: async () => ({ userId: "u1", tenantId: "t1", role: authMock.role }) }));
vi.mock("@/lib/auth/csrf", () => ({ assertSameOrigin: () => undefined }));

import { assertMediaReady, mediaWakeAt, refreshBroadcastMedia, uploadBroadcastMedia } from "@/lib/broadcasts/media";
import { POST } from "@/app/api/broadcasts/media/route";

const actor = { userId: "u1", tenantId: "t1", role: "admin" as const };
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const now = new Date("2026-10-30T10:00:00Z");
const DAY = 86_400_000;
const upload = (daysOld: number) => ({ source: "upload", value: "old111", filename: "offer.jpg", uploadedAt: new Date(now.getTime() - daysOld * DAY).toISOString(), phoneNumberId: "p1" });

beforeEach(() => {
  vi.resetAllMocks();
  authMock.role = "admin";
  db.phoneNumber.findFirst.mockResolvedValue({ id: "p1", phoneNumberId: "meta_p1" });
  db.broadcast.updateMany.mockResolvedValue({ count: 1 });
});

describe("uploading a broadcast's header file", () => {
  it("uploads to the sending number at WhatsApp and returns what the value mapping keeps", async () => {
    graph.graphUpload.mockResolvedValue({ id: "998877" });
    const out = await uploadBroadcastMedia(actor, "p1", "image", { bytes: jpeg, mime: "image/jpeg", filename: "my offer.jpg" }, now);
    expect(db.phoneNumber.findFirst).toHaveBeenCalledWith({ where: { id: "p1", tenantId: "t1" }, select: { id: true, phoneNumberId: true } });
    expect(graph.graphUpload).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", path: "meta_p1/media", fields: { messaging_product: "whatsapp", type: "image/jpeg" } }));
    expect(out).toEqual({ id: "998877", type: "image", mime: "image/jpeg", filename: "my_offer.jpg", bytes: jpeg.byteLength, uploadedAt: now.toISOString(), phoneNumberId: "p1" });
  });
  it("refuses another workspace's number, a file of the wrong kind, and explains WhatsApp's refusal", async () => {
    db.phoneNumber.findFirst.mockResolvedValueOnce(null);
    await expect(uploadBroadcastMedia(actor, "foreign", "image", { bytes: jpeg, mime: "image/jpeg", filename: "a.jpg" })).rejects.toMatchObject({ status: 404 });
    await expect(uploadBroadcastMedia(actor, "p1", "video", { bytes: jpeg, mime: "image/jpeg", filename: "a.jpg" })).rejects.toThrow(/a video/);
    graph.graphUpload.mockRejectedValueOnce(new graph.GraphError("Invalid parameter", 400));
    await expect(uploadBroadcastMedia(actor, "p1", "image", { bytes: jpeg, mime: "image/jpeg", filename: "a.jpg" })).rejects.toMatchObject({ status: 422 });
    graph.graphUpload.mockResolvedValueOnce({ id: "../x" });
    await expect(uploadBroadcastMedia(actor, "p1", "image", { bytes: jpeg, mime: "image/jpeg", filename: "a.jpg" })).rejects.toMatchObject({ status: 502 });
  });
  it("the route needs an admin, the number and a header kind", async () => {
    const req = (query: string) => new Request(`https://wa.edwyz.com/api/broadcasts/media${query}`, { method: "POST", headers: { "content-type": "image/jpeg", "x-file-name": "a.jpg" }, body: jpeg });
    expect((await POST(req("?type=image"))).status).toBe(400);
    expect((await POST(req("?phoneNumberId=p1&type=sticker"))).status).toBe(400);
    graph.graphUpload.mockResolvedValue({ id: "998877" });
    const ok = await POST(req("?phoneNumberId=p1&type=image"));
    expect(ok.status).toBe(200);
    expect((await ok.json()).media).toMatchObject({ id: "998877", type: "image", phoneNumberId: "p1" });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", action: "broadcast.media_uploaded" }));
    authMock.role = "agent";
    expect((await POST(req("?phoneNumberId=p1&type=image"))).status).toBe(403);
  });
});

describe("keeping an uploaded file alive at WhatsApp", () => {
  const b = (map: Record<string, unknown>) => ({ id: "b1", tenantId: "t1", phoneNumberId: "p1", variableMap: map });

  it("uploads a 20-day-old file again from its old id and stores the new id on the broadcast", async () => {
    media.downloadMetaMedia.mockResolvedValue({ bytes: Buffer.from(jpeg), mime: "image/jpeg" });
    graph.graphUpload.mockResolvedValue({ id: "new222" });
    const map = { header: upload(21), "1": { source: "field", key: "name" } };
    const out = await refreshBroadcastMedia(b(map), now);
    expect(media.downloadMetaMedia).toHaveBeenCalledWith("t1", "old111");
    expect(graph.graphUpload).toHaveBeenCalledWith(expect.objectContaining({ path: "meta_p1/media" }));
    expect(out?.header).toEqual({ ...upload(21), value: "new222", uploadedAt: now.toISOString() });
    expect(out?.["1"]).toEqual(map["1"]);
    expect(db.broadcast.updateMany).toHaveBeenCalledWith({ where: { id: "b1", tenantId: "t1" }, data: { variableMap: out } });
  });
  it("leaves a fresh file, and a map without files, alone without touching the database", async () => {
    const map = { header: upload(3) };
    expect(await refreshBroadcastMedia(b(map), now)).toBe(map);
    expect(await refreshBroadcastMedia({ id: "b1", tenantId: "t1", phoneNumberId: "p1", variableMap: null }, now)).toBeNull();
    expect(db.phoneNumber.findFirst).not.toHaveBeenCalled();
    expect(db.broadcast.updateMany).not.toHaveBeenCalled();
  });
  it("keeps the current id when the refresh fails, and refuses to start once WhatsApp no longer keeps it", async () => {
    media.downloadMetaMedia.mockRejectedValue(new Error("gone"));
    const map = { header: upload(22) };
    expect(await refreshBroadcastMedia(b(map), now)).toBe(map);
    expect(db.broadcast.updateMany).not.toHaveBeenCalled();
    await expect(assertMediaReady(b(map), now)).resolves.toBeUndefined();
    await expect(assertMediaReady(b({ header: upload(30) }), now)).rejects.toMatchObject({ status: 409 });
  });
  it("wakes a waiting broadcast when the next refresh is due, or an hour later when one already failed", () => {
    expect(mediaWakeAt({ header: upload(5) }, now)).toEqual(new Date(now.getTime() + 15 * DAY));
    expect(mediaWakeAt({ header: upload(25) }, now)).toEqual(new Date(now.getTime() + 60 * 60_000));
    expect(mediaWakeAt({ "1": { source: "static", value: "x" } }, now)).toBeNull();
  });
});
