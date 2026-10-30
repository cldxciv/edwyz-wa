import { mediaPublicUrl } from "@/lib/content/media";
import { MEDIA_KEY_PATTERN } from "@/lib/content/limits";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";
import { LIMITS } from "./model";

export const MATERIAL_KINDS = ["text", "media", "document"] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];
export const MAX_MATERIALS = 200;
const MAX_LINK = 1000;
const MIME = /^[a-z]+\/[a-z0-9.+-]+$/i;

export type MaterialInput = { name: string; kind: MaterialKind; body: string | null; mediaKey: string | null; mediaMime: string | null };

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** A media reference is either an https link to the file or a file key from the workspace media library. */
export function validMediaRef(value: string): boolean {
  if (MEDIA_KEY_PATTERN.test(value)) return true;
  if (value.length > MAX_LINK) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function validateMaterial(raw: unknown, partial = false): Partial<MaterialInput> {
  if (!isRecord(raw)) throw new HttpError(400, "Invalid reply material.");
  const out: Partial<MaterialInput> = {};
  const has = (k: string) => raw[k] !== undefined;
  const need = (k: string) => {
    if (!partial && !has(k)) throw new HttpError(400, `${k} is required.`);
    return has(k);
  };
  if (need("name")) {
    if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.trim().length > LIMITS.name) throw new HttpError(400, `Give the material a name of up to ${LIMITS.name} characters.`);
    out.name = raw.name.trim();
  }
  if (need("kind")) {
    if (!(MATERIAL_KINDS as readonly unknown[]).includes(raw.kind)) throw new HttpError(400, "Choose text, media or document.");
    out.kind = raw.kind as MaterialKind;
  }
  if (has("body")) {
    if (raw.body !== null && (typeof raw.body !== "string" || raw.body.length > LIMITS.text)) throw new HttpError(400, `The text can be up to ${LIMITS.text} characters.`);
    out.body = typeof raw.body === "string" && raw.body.trim() ? raw.body.trim() : null;
  }
  if (has("mediaKey")) {
    if (raw.mediaKey !== null && (typeof raw.mediaKey !== "string" || !validMediaRef(raw.mediaKey.trim()))) throw new HttpError(400, "Use a secure https link to the file, or pick a file from your media library.");
    out.mediaKey = typeof raw.mediaKey === "string" && raw.mediaKey.trim() ? raw.mediaKey.trim() : null;
  }
  if (has("mediaMime")) {
    if (raw.mediaMime !== null && (typeof raw.mediaMime !== "string" || !MIME.test(raw.mediaMime.trim()) || raw.mediaMime.length > 100)) throw new HttpError(400, "The file type is not valid.");
    out.mediaMime = typeof raw.mediaMime === "string" && raw.mediaMime.trim() ? raw.mediaMime.trim().toLowerCase() : null;
  }
  return out;
}

function assertComplete(m: { kind: string; body: string | null; mediaKey: string | null }) {
  if (m.kind === "text" && !m.body) throw new HttpError(400, "Write the text of this material.");
  if (m.kind !== "text" && !m.mediaKey) throw new HttpError(400, "Add the file link or pick a file for this material.");
}

export const listMaterials = (tenantId: string) => prisma.replyMaterial.findMany({ where: { tenantId }, orderBy: { name: "asc" }, take: MAX_MATERIALS });

export async function getMaterial(tenantId: string, id: string) {
  return prisma.replyMaterial.findFirst({ where: { id, tenantId } });
}

function isUniqueViolation(error: unknown) {
  return (error as { code?: string } | null)?.code === "P2002";
}

export async function createMaterial(tenantId: string, raw: unknown) {
  const input = validateMaterial(raw);
  const data = { name: input.name!, kind: input.kind!, body: input.body ?? null, mediaKey: input.kind === "text" ? null : (input.mediaKey ?? null), mediaMime: input.kind === "text" ? null : (input.mediaMime ?? null) };
  assertComplete(data);
  if ((await prisma.replyMaterial.count({ where: { tenantId } })) >= MAX_MATERIALS) throw new HttpError(409, `You can keep up to ${MAX_MATERIALS} reply materials.`);
  try {
    return await prisma.replyMaterial.create({ data: { tenantId, ...data } });
  } catch (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, "You already have a material with this name.");
    throw error;
  }
}

export async function updateMaterial(tenantId: string, id: string, raw: unknown) {
  const patch = validateMaterial(raw, true);
  const current = await getMaterial(tenantId, id);
  if (!current) throw new HttpError(404, "Reply material not found.");
  const next = { ...current, ...patch };
  if (next.kind === "text") Object.assign(next, { mediaKey: null, mediaMime: null });
  assertComplete(next);
  try {
    await prisma.replyMaterial.updateMany({ where: { id, tenantId }, data: { name: next.name, kind: next.kind, body: next.body, mediaKey: next.mediaKey, mediaMime: next.mediaMime } });
  } catch (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, "You already have a material with this name.");
    throw error;
  }
  return getMaterial(tenantId, id);
}

/** Rules that send this material, so the page can warn before it is deleted. */
export async function rulesUsingMaterial(tenantId: string, id: string): Promise<string[]> {
  const rules = await prisma.automationRule.findMany({ where: { tenantId, version: 2 }, select: { name: true, actions: true } });
  return rules.filter((r) => Array.isArray(r.actions) && (r.actions as { type?: string; materialId?: string }[]).some((a) => a?.type === "send_material" && a.materialId === id)).map((r) => r.name);
}

export async function deleteMaterial(tenantId: string, id: string) {
  const { count } = await prisma.replyMaterial.deleteMany({ where: { id, tenantId } });
  if (count === 0) throw new HttpError(404, "Reply material not found.");
}

export type MaterialSend =
  | { kind: "text"; text: string }
  | { kind: "media"; mediaType: "image" | "video" | "audio" | "document"; media: string; caption: string | null; filename?: string; mime?: string };

function mediaTypeFor(kind: string, mime: string | null, ref: string): "image" | "video" | "audio" | "document" {
  if (kind === "document") return "document";
  const m = mime ?? "";
  if (m.startsWith("video/") || /\.(mp4|mov)$/i.test(ref)) return "video";
  if (m.startsWith("audio/")) return "audio";
  return "image";
}

function filenameFor(ref: string, fallback: string): string {
  if (MEDIA_KEY_PATTERN.test(ref)) return fallback;
  try {
    const last = decodeURIComponent(new URL(ref).pathname.split("/").pop() ?? "");
    return last && last.length <= 120 ? last : fallback;
  } catch {
    return fallback;
  }
}

/** What to send for a material: the text with placeholders already filled by the caller, or a media message with a public link. */
export function prepareMaterial(tenantId: string, material: { kind: string; name: string; body: string | null; mediaKey: string | null; mediaMime: string | null }, render: (text: string) => string): MaterialSend {
  if (material.kind === "text") return { kind: "text", text: render(material.body ?? "") };
  const ref = material.mediaKey ?? "";
  const media = MEDIA_KEY_PATTERN.test(ref) ? mediaPublicUrl(tenantId, ref) : ref;
  const mediaType = mediaTypeFor(material.kind, material.mediaMime, ref);
  const caption = material.body ? render(material.body) : null;
  return {
    kind: "media",
    mediaType,
    media,
    caption: mediaType === "audio" ? null : caption,
    ...(mediaType === "document" ? { filename: filenameFor(ref, material.name) } : {}),
    ...(material.mediaMime ? { mime: material.mediaMime } : {}),
  };
}
