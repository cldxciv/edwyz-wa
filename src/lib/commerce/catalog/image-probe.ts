/**
 * Checks a product photo before it is kept (docs/specs/META-CATALOG-COMMERCE-SPEC.md 2.3 and 3.4): JPEG or PNG only, at least
 * 500 x 500 pixels, at most 8 MB. Meta refuses anything else, so the owner hears it at once, in plain words, instead of
 * seeing "Needs a fix" minutes later.
 *
 * It wraps the one media parser (src/lib/promote/probe.ts: bounded reads, truncated and hostile files refused) and adds only
 * the shop's rules. No new parser and no new dependency. Server only: the file variant reads from disk.
 */
import { type ByteSource, fileSource, type ProbeReason, probeMedia, PROBE_MESSAGES } from "@/lib/promote/probe";

export const PRODUCT_IMAGE_RULES = Object.freeze({
  /** Both sides at least this many pixels. */
  minSide: 500,
  /** At most 8 MB. */
  maxBytes: 8 * 1024 * 1024,
  formats: Object.freeze(["jpeg", "png"] as const),
});

export type ProductImageReason = "too_large" | "wrong_format" | "too_small" | "empty" | "incomplete" | "damaged";

export type ProductImageCheck =
  | { ok: true; format: "jpeg" | "png"; contentType: "image/jpeg" | "image/png"; extension: "jpg" | "png"; width: number; height: number; bytes: number }
  | { ok: false; reason: ProductImageReason; message: string };

/** What the owner sees for each refusal: what is wrong and what to do. */
export const PRODUCT_IMAGE_MESSAGES: Readonly<Record<Exclude<ProductImageReason, "too_small">, string>> = Object.freeze({
  too_large: "This photo is larger than 8 MB. Use a smaller photo, or take it again with your phone camera.",
  wrong_format: "Use a JPG or PNG photo. Other kinds of files, like WebP, HEIC or videos, can't be shown on WhatsApp.",
  empty: PROBE_MESSAGES.empty,
  incomplete: PROBE_MESSAGES.truncated,
  damaged: "This photo is damaged and can't be read. Save it again as a JPG or PNG and upload it.",
});

/** "This photo is 400 x 400 pixels. Use one at least 500 x 500 pixels." */
export function tooSmallMessage(width: number, height: number): string {
  const min = PRODUCT_IMAGE_RULES.minSide;
  return `This photo is ${width} x ${height} pixels. Use one at least ${min} x ${min} pixels.`;
}

const refuse = (reason: Exclude<ProductImageReason, "too_small">): ProductImageCheck => ({ ok: false, reason, message: PRODUCT_IMAGE_MESSAGES[reason] });

/** The shop's reason for a probe refusal. */
function reasonOf(probe: ProbeReason): Exclude<ProductImageReason, "too_small" | "too_large"> {
  switch (probe) {
    case "empty":
      return "empty";
    case "truncated":
      return "incomplete";
    case "unknown_format":
    case "unsupported_image":
    case "unsupported_codec":
    case "no_video_track":
    case "bad_duration":
    case "odd_rotation":
      return "wrong_format";
    case "corrupt":
    case "bad_dimensions":
    case "too_complex":
      return "damaged";
  }
}

/**
 * Checks a photo held in memory (or behind a ByteSource). The size cap is checked before a single byte is parsed; the
 * smaller side as shown (after the EXIF turn) must reach 500 pixels.
 */
export function checkProductImage(input: Uint8Array | ByteSource): ProductImageCheck {
  const size = input instanceof Uint8Array ? input.length : input.size;
  if (size === 0) return refuse("empty");
  if (size > PRODUCT_IMAGE_RULES.maxBytes) return refuse("too_large");
  const result = probeMedia(input);
  if (!result.ok) return refuse(reasonOf(result.reason));
  const media = result.media;
  if (media.kind !== "image") return refuse("wrong_format");
  const width = media.displayWidth;
  const height = media.displayHeight;
  if (Math.min(width, height) < PRODUCT_IMAGE_RULES.minSide) return { ok: false, reason: "too_small", message: tooSmallMessage(width, height) };
  return media.format === "png"
    ? { ok: true, format: "png", contentType: "image/png", extension: "png", width, height, bytes: size }
    : { ok: true, format: "jpeg", contentType: "image/jpeg", extension: "jpg", width, height, bytes: size };
}

/** Checks a photo stored on disk, reading only the bytes the probe needs. */
export function checkProductImageFile(path: string): ProductImageCheck {
  let source: ReturnType<typeof fileSource> | null = null;
  try {
    source = fileSource(path);
    return checkProductImage(source);
  } catch {
    return refuse("damaged");
  } finally {
    source?.close();
  }
}
