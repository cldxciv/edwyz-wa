import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { GraphError, graphUpload } from "@/lib/graph";
import { downloadMetaMedia } from "@/lib/inbox/media";
import { describeError } from "@/lib/safe-error";
import { type Actor, HttpError } from "@/lib/tenancy";
import { checkUpload } from "@/lib/templates/upload";
import { UPLOAD_REFRESH_MS, UPLOAD_TTL_MS, type VariableMap, nextUploadRefresh, uploadUsable, uploadedKeys } from "./mapping";

/*
 * The real header file of a broadcast (an image, video or PDF), uploaded to WhatsApp for the number that sends it. Nothing is
 * stored here: the broadcast's value mapping keeps Meta's media id ({ source: "upload" }), and the message sends { id }. Meta keeps
 * an uploaded file for 30 days, so a file older than 20 days is downloaded with its old id and uploaded again before a long or
 * scheduled broadcast needs it.
 */

export type HeaderKind = "image" | "video" | "document";
export const HEADER_KINDS: readonly HeaderKind[] = ["image", "video", "document"];
export type BroadcastMedia = { id: string; type: HeaderKind; mime: string; filename: string; bytes: number; uploadedAt: string; phoneNumberId: string };

const MEDIA_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HOUR_MS = 60 * 60_000;
const UPLOAD_FAILED = "We could not upload this file to WhatsApp. Try again.";

const article = (kind: HeaderKind) => (kind === "image" ? "an image" : `a ${kind}`);

async function uploadTo(tenantId: string, metaPhoneId: string, file: { bytes: Uint8Array; mime: string; filename: string }): Promise<string> {
  let id: unknown;
  try {
    const res = await graphUpload<{ id?: unknown }>({ tenantId, path: `${metaPhoneId}/media`, fields: { messaging_product: "whatsapp", type: file.mime }, file });
    id = res?.id;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof GraphError && e.status >= 400 && e.status < 500) throw new HttpError(422, "WhatsApp did not accept this file. Check its type and size, then try again.");
    throw new HttpError(502, UPLOAD_FAILED);
  }
  if (typeof id !== "string" || !MEDIA_ID.test(id)) throw new HttpError(502, UPLOAD_FAILED);
  return id;
}

/** Uploads the file a broadcast's header shows, for the workspace number `phoneRowId`, and returns what the value mapping keeps. */
export async function uploadBroadcastMedia(
  actor: Actor,
  phoneRowId: string,
  expected: HeaderKind | null,
  file: { bytes: Uint8Array; mime: string; filename: string },
  now: Date = new Date(),
): Promise<BroadcastMedia> {
  const phone = await prisma.phoneNumber.findFirst({ where: { id: phoneRowId, tenantId: actor.tenantId }, select: { id: true, phoneNumberId: true } });
  if (!phone) throw new HttpError(404, "Phone number not found.");
  const checked = checkUpload(file);
  const type = checked.type.toLowerCase() as HeaderKind;
  if (expected && expected !== type) throw new HttpError(400, `This template shows ${article(expected)} at the top. Choose ${article(expected)} file.`);
  const id = await uploadTo(actor.tenantId, phone.phoneNumberId, { bytes: file.bytes, mime: checked.mime, filename: checked.filename });
  return { id, type, mime: checked.mime, filename: checked.filename, bytes: file.bytes.byteLength, uploadedAt: now.toISOString(), phoneNumberId: phone.id };
}

const mapOf = (raw: unknown): VariableMap | null => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as VariableMap) : null);

type MediaBroadcast = { id: string; tenantId: string; phoneNumberId: string; variableMap?: unknown };

/**
 * Uploads again every file of the broadcast's map that is due (older than 20 days, still inside Meta's 30), and stores the new ids.
 * Returns the map to send with. A file that cannot be refreshed keeps its id; once that has expired its recipients are treated like
 * a missing value (skipped, the fallback link, or the broadcast stops). Never throws.
 */
export async function refreshBroadcastMedia(b: MediaBroadcast, now: Date = new Date()): Promise<VariableMap | null> {
  const map = mapOf(b.variableMap);
  const due = uploadedKeys(map).filter((k) => {
    const age = now.getTime() - Date.parse(map?.[k]?.uploadedAt ?? "");
    return age >= UPLOAD_REFRESH_MS && age < UPLOAD_TTL_MS;
  });
  if (!map || due.length === 0) return map;
  try {
    const phone = await prisma.phoneNumber.findFirst({ where: { id: b.phoneNumberId, tenantId: b.tenantId }, select: { phoneNumberId: true } });
    if (!phone) return map;
    const next: VariableMap = { ...map };
    for (const key of due) {
      const src = map[key];
      try {
        const file = await downloadMetaMedia(b.tenantId, src.value as string);
        const id = await uploadTo(b.tenantId, phone.phoneNumberId, { bytes: new Uint8Array(file.bytes), mime: file.mime ?? "application/octet-stream", filename: src.filename ?? "file" });
        next[key] = { ...src, value: id, uploadedAt: now.toISOString() };
      } catch (error) {
        console.error("[broadcast] could not upload a header file again; the current one is kept:", describeError(error));
      }
    }
    if (JSON.stringify(next) === JSON.stringify(map)) return map;
    await prisma.broadcast.updateMany({ where: { id: b.id, tenantId: b.tenantId }, data: { variableMap: next as unknown as Prisma.InputJsonObject } });
    return next;
  } catch (error) {
    console.error("[broadcast] could not refresh the uploaded header files:", describeError(error));
    return map;
  }
}

/**
 * When a waiting (scheduled) broadcast must wake up to keep its uploaded files alive: the next refresh, or an hour from now when a
 * refresh is already due (it failed, and is tried again). Null when the map has no uploaded file.
 */
export function mediaWakeAt(variableMap: unknown, now: Date): Date | null {
  const next = nextUploadRefresh(mapOf(variableMap));
  if (!next) return null;
  return next.getTime() > now.getTime() ? next : new Date(now.getTime() + HOUR_MS);
}

/** Refuses to start a broadcast whose uploaded file has expired at WhatsApp and could not be uploaded again. */
export async function assertMediaReady(b: MediaBroadcast, now: Date = new Date()): Promise<void> {
  if (uploadedKeys(mapOf(b.variableMap)).length === 0) return;
  const map = await refreshBroadcastMedia(b, now);
  if (uploadedKeys(map).some((k) => !uploadUsable(map?.[k], now))) {
    throw new HttpError(409, "WhatsApp keeps an uploaded file for 30 days, and the one for this broadcast is older. Make a new broadcast and upload the file again.");
  }
}

/**
 * The uploaded files of a new broadcast must belong to the number that sends it (a media id only works for the number it was
 * uploaded to). One that is gone at WhatsApp is refused, and an old one uploaded again, when the broadcast starts (assertMediaReady),
 * so a follow-up of an older broadcast can still reuse its file.
 */
export function assertUploadsFit(map: VariableMap | null, phoneRowId: string, now: Date = new Date()): void {
  for (const key of uploadedKeys(map)) {
    const src = map?.[key];
    if (src?.phoneNumberId !== phoneRowId) throw new HttpError(400, "The file was uploaded for another WhatsApp number. Upload it again for the number you send from.");
    if (now.getTime() - Date.parse(src.uploadedAt ?? "") >= UPLOAD_TTL_MS) throw new HttpError(400, "WhatsApp no longer keeps the file you uploaded. Upload it again.");
  }
}
