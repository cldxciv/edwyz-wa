/**
 * Checks an ad's image or video on the server before it goes to Meta (docs/IG-PAGE-ADS-SPEC.md D21, 9.1 promote-probe, PRM-03).
 *
 * - JPEG and PNG sizes come from `image-size`. Its JPEG reader copies the rest of the buffer at every byte it skips, which a
 *   hostile file could turn into minutes of work, so this file first walks the JPEG markers itself (bounded, no copies) and
 *   hands `image-size` only the parts it needs: the EXIF block (for the orientation) and the frame header (for the size).
 * - A JPEG must reach its image data (SOS) and that data must end (EOI). Data after the end is fine: Google Pixel and Samsung
 *   Motion Photos append a video of several MB to the photo. The end is looked for in the last 64 KB, then by walking the image
 *   data forward from SOS within the read cap; only when the cap runs out first does the file's tail decide (bare image data
 *   there means the file was cut short; anything else is data after the image).
 * - MP4 and MOV go to the in-house box parser (mp4.ts): size and rotation from tkhd, duration from mvhd, codec from stsd.
 * - Hard caps (D21): 2 MB of reads and 50 ms per file. A truncated, damaged or hostile file is refused with a plain reason.
 *
 * probeMedia never throws for a bad file: it returns `{ok: false, reason, message}`.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { imageSize } from "image-size";
import {
  bytesSource,
  type ByteSource,
  FIRST_BOX_TYPES,
  MAX_PROBE_MS,
  MAX_READ_BYTES,
  MediaProbeError,
  parseMp4,
  PROBE_MESSAGES,
  ReadBudget,
  type Rotation,
  u16,
  u32,
  type VideoCodec,
} from "./mp4";

export { bytesSource, type ByteSource, MAX_PROBE_MS, MAX_READ_BYTES, MediaProbeError, PROBE_MESSAGES, type ProbeReason } from "./mp4";

export type ImageProbe = {
  kind: "image";
  format: "jpeg" | "png";
  /** Stored size. */
  width: number;
  height: number;
  /** EXIF orientation (1 to 8), when the JPEG has one. */
  orientation: number | null;
  /** The size as shown: swapped for EXIF orientations 5 to 8. */
  displayWidth: number;
  displayHeight: number;
  bytes: number;
};

export type VideoProbe = {
  kind: "video";
  format: "mp4" | "mov";
  width: number;
  height: number;
  rotation: Rotation;
  displayWidth: number;
  displayHeight: number;
  durationMs: number;
  codec: VideoCodec;
  faststart: boolean;
  bytes: number;
};

export type MediaProbe = ImageProbe | VideoProbe;

export type ProbeResult =
  | { ok: true; media: MediaProbe; bytesRead: number; ms: number }
  | { ok: false; reason: import("./mp4").ProbeReason; message: string; bytesRead: number; ms: number };

export type ProbeOptions = { maxBytes?: number; maxMs?: number; clock?: () => number };

/** Pixel sides above this are not a real photo. */
export const MAX_IMAGE_SIDE = 30000;
/** JPEG segments walked before the frame header at most (real files have under 20). */
const MAX_JPEG_SEGMENTS = 512;
/** Consecutive 0xFF fill bytes allowed before a marker. */
const MAX_FILL_BYTES = 64;
/** How far back from the end the end marker (JPEG EOI, PNG IEND) is looked for. */
const TAIL_WINDOW = 64 * 1024;
/** Bytes read per step while walking a JPEG's image data for its end. */
const SCAN_CHUNK = 64 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IEND = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
const fourcc = (b: Uint8Array, i: number) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
const startsWith = (b: Uint8Array, sig: readonly number[]) => sig.every((v, i) => b[i] === v);

function indexOf(haystack: Uint8Array, needle: readonly number[]): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let k = 0; k < needle.length; k++) if (haystack[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

const validSide = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_IMAGE_SIDE;

// ---------------------------------------------------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------------------------------------------------

/** Frame headers image-size reads (baseline, extended and progressive). Other SOF kinds are refused. */
const SOF_SUPPORTED = new Set([0xc0, 0xc1, 0xc2]);
/** Every SOF marker: C0 to CF except DHT (C4), JPG (C8) and DAC (CC). */
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
/** Markers with no length: TEM and RST0 to RST7. */
const standalone = (m: number) => m === 0x01 || (m >= 0xd0 && m <= 0xd7);
const EXIF_ID = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
/** What may follow FF inside compressed image data: a stuffed 00, a restart marker (or TEM), or more fill bytes. */
const inImageData = (m: number) => m === 0x00 || m === 0xff || standalone(m);

/** True when every FF in the bytes is followed by 00, a restart marker or more fill: compressed image data and nothing else. */
function onlyImageData(b: Uint8Array): boolean {
  for (let i = b.indexOf(0xff); i >= 0 && i + 1 < b.length; i = b.indexOf(0xff, i + 1)) if (!inImageData(b[i + 1])) return false;
  return true;
}

/**
 * Walks a JPEG's image data from its first scan to the end marker (FF D9). Stuffed bytes and restart markers belong to the data;
 * any other marker segment (a progressive file's next tables and scans) is skipped by its length. True at the end marker, false
 * when the read cap runs out first. A file that ends before the marker is truncated.
 */
function walkToImageEnd(source: ByteSource, budget: ReadBudget, from: number): boolean {
  let pos = from;
  let segments = 0;
  for (;;) {
    if (source.size - pos < 2) throw new MediaProbeError("truncated");
    const n = Math.min(SCAN_CHUNK, source.size - pos, budget.maxBytes - budget.bytesRead);
    if (n < 2) return false;
    const chunk = budget.read(source, pos, n);
    let next = pos + n;
    for (let i = chunk.indexOf(0xff); i >= 0; i = chunk.indexOf(0xff, i + 1)) {
      if (i + 1 >= n) {
        // An FF at the chunk's end: the next chunk starts from it.
        next = pos + i;
        break;
      }
      const marker = chunk[i + 1];
      if (inImageData(marker)) continue;
      if (marker === 0xd9) return true;
      if (marker === 0xd8) throw new MediaProbeError("corrupt");
      if (++segments > MAX_JPEG_SEGMENTS) throw new MediaProbeError("too_complex");
      const at = pos + i;
      if (at + 4 > source.size) throw new MediaProbeError("truncated");
      let length: number;
      if (i + 3 < n) length = u16(chunk, i + 2);
      else if (budget.maxBytes - budget.bytesRead >= 2) length = u16(budget.read(source, at + 2, 2), 0);
      else return false;
      if (length < 2) throw new MediaProbeError("corrupt");
      next = at + 2 + length;
      if (next > source.size) throw new MediaProbeError("truncated");
      break;
    }
    pos = next;
  }
}

function probeJpeg(source: ByteSource, budget: ReadBudget): ImageProbe {
  let pos = 2;
  let exif: Uint8Array | null = null;
  let sof: Uint8Array | null = null;
  /** Where the first scan's image data starts (just after its SOS header). */
  let scanStart = -1;
  for (let segments = 0; scanStart < 0; segments++) {
    if (segments > MAX_JPEG_SEGMENTS) throw new MediaProbeError("too_complex");
    budget.tick();
    if (pos + 2 > source.size) throw new MediaProbeError("truncated");
    let head = budget.read(source, pos, 2);
    if (head[0] !== 0xff) throw new MediaProbeError("corrupt");
    for (let fill = 0; head[1] === 0xff; fill++) {
      if (fill >= MAX_FILL_BYTES) throw new MediaProbeError("corrupt");
      pos += 1;
      if (pos + 2 > source.size) throw new MediaProbeError("truncated");
      head = budget.read(source, pos, 2);
    }
    const marker = head[1];
    if (standalone(marker)) {
      pos += 2;
      continue;
    }
    // The end, or image data, before any frame header: there is no size to read.
    if (marker === 0xd9 || marker === 0xd8 || marker === 0x00 || (marker === 0xda && sof === null)) throw new MediaProbeError("corrupt");
    if (pos + 4 > source.size) throw new MediaProbeError("truncated");
    const length = u16(budget.read(source, pos + 2, 2), 0);
    if (length < 2) throw new MediaProbeError("corrupt");
    const end = pos + 2 + length;
    if (end > source.size) throw new MediaProbeError("truncated");
    if (marker === 0xda) {
      // The first scan (SOS): the image data starts after its header.
      scanStart = end;
    } else if (isSof(marker) && sof === null) {
      if (!SOF_SUPPORTED.has(marker)) throw new MediaProbeError("unsupported_image");
      if (length < 8) throw new MediaProbeError("corrupt");
      sof = budget.read(source, pos, 2 + length);
    } else if (marker === 0xe1 && exif === null && length >= 2 + EXIF_ID.length) {
      const id = budget.read(source, pos + 4, EXIF_ID.length);
      if (startsWith(id, EXIF_ID)) exif = budget.read(source, pos, 2 + length);
    }
    pos = end;
  }
  if (sof === null) throw new MediaProbeError("corrupt");

  // The image data must end. A file cut short loses its end marker, and image data never holds FF D9 (an FF there is always
  // followed by 00 or a restart marker), so FF D9 after the scan starts is the end. Data after the end (a Motion Photo's video)
  // is fine, so the end is looked for in the tail first (most files), then by walking the image data forward. If the read cap
  // runs out before the walk finds it (a large Motion Photo), the tail decides: bare image data there means the file was cut
  // short; anything else is data after the image.
  const tailStart = Math.max(scanStart, source.size - TAIL_WINDOW);
  const tail = budget.read(source, tailStart, source.size - tailStart);
  if (indexOf(tail, [0xff, 0xd9]) < 0 && !walkToImageEnd(source, budget, scanStart) && onlyImageData(tail)) throw new MediaProbeError("truncated");

  // image-size skips the first marker after SOI without looking at it, so the parts follow an empty APP0 when there is no EXIF.
  const app0 = Uint8Array.of(0xff, 0xe0, 0x00, 0x02);
  const parts = [Uint8Array.of(0xff, 0xd8), exif ?? app0, sof, Uint8Array.of(0xff, 0xd9)];
  const compact = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    compact.set(p, at);
    at += p.length;
  }
  let size: ReturnType<typeof imageSize>;
  try {
    size = imageSize(compact);
  } catch {
    throw new MediaProbeError("corrupt");
  }
  budget.tick();
  if (size.type !== "jpg" || !validSide(size.width) || !validSide(size.height)) throw new MediaProbeError("bad_dimensions");
  // The frame header says the same as image-size, or the file is not what it seems.
  if (size.height !== u16(sof, 5) || size.width !== u16(sof, 7)) throw new MediaProbeError("corrupt");
  const orientation = typeof size.orientation === "number" && Number.isInteger(size.orientation) && size.orientation >= 1 && size.orientation <= 8 ? size.orientation : null;
  const turned = orientation !== null && orientation >= 5;
  return {
    kind: "image",
    format: "jpeg",
    width: size.width,
    height: size.height,
    orientation,
    displayWidth: turned ? size.height : size.width,
    displayHeight: turned ? size.width : size.height,
    bytes: source.size,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------------------------------------------------

function probePng(source: ByteSource, budget: ReadBudget): ImageProbe {
  // Signature (8), IHDR length (4) and type (4), 13 bytes of header, CRC (4).
  if (source.size < 33 + IEND.length) throw new MediaProbeError("truncated");
  const head = budget.read(source, 0, 33);
  // Apple's "CgBI" PNGs (and anything else without IHDR first) are not standard PNGs.
  if (fourcc(head, 12) !== "IHDR") throw new MediaProbeError(fourcc(head, 12) === "CgBI" ? "unsupported_image" : "corrupt");
  if (u32(head, 8) !== 13) throw new MediaProbeError("corrupt");
  const tailStart = Math.max(33, source.size - TAIL_WINDOW);
  if (indexOf(budget.read(source, tailStart, source.size - tailStart), IEND) < 0) throw new MediaProbeError("truncated");
  let size: ReturnType<typeof imageSize>;
  try {
    size = imageSize(head);
  } catch {
    throw new MediaProbeError("corrupt");
  }
  budget.tick();
  if (size.type !== "png" || !validSide(size.width) || !validSide(size.height)) throw new MediaProbeError("bad_dimensions");
  return { kind: "image", format: "png", width: size.width, height: size.height, orientation: null, displayWidth: size.width, displayHeight: size.height, bytes: source.size };
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------------------------------

function probeWith(source: ByteSource, budget: ReadBudget): MediaProbe {
  if (source.size === 0) throw new MediaProbeError("empty");
  const head = budget.read(source, 0, Math.min(12, source.size));
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return probeJpeg(source, budget);
  if (head.length >= 8 && startsWith(head, PNG_SIGNATURE)) return probePng(source, budget);
  if (head.length >= 8 && FIRST_BOX_TYPES.includes(fourcc(head, 4))) {
    const info = parseMp4(source, budget);
    return {
      kind: "video",
      format: info.container,
      width: info.width,
      height: info.height,
      rotation: info.rotation,
      displayWidth: info.displayWidth,
      displayHeight: info.displayHeight,
      durationMs: info.durationMs,
      codec: info.codec,
      faststart: info.faststart,
      bytes: source.size,
    };
  }
  if (head.length < 8) throw new MediaProbeError("truncated");
  throw new MediaProbeError("unknown_format");
}

/** Probes an image or video held in memory, or behind a ByteSource. Never throws for a bad file. */
export function probeMedia(input: Uint8Array | ByteSource, opts: ProbeOptions = {}): ProbeResult {
  const source = input instanceof Uint8Array ? bytesSource(input) : input;
  const budget = new ReadBudget(opts.maxBytes ?? MAX_READ_BYTES, opts.maxMs ?? MAX_PROBE_MS, opts.clock);
  try {
    const media = probeWith(source, budget);
    // The last read may have finished past the time cap.
    budget.tick();
    return { ok: true, media, bytesRead: budget.bytesRead, ms: budget.elapsedMs() };
  } catch (e) {
    if (!(e instanceof MediaProbeError)) {
      // A read that failed (a file that changed under us, an I/O error) is reported as unreadable, never thrown.
      return { ok: false, reason: "corrupt", message: PROBE_MESSAGES.corrupt, bytesRead: budget.bytesRead, ms: budget.elapsedMs() };
    }
    return { ok: false, reason: e.reason, message: e.message, bytesRead: budget.bytesRead, ms: budget.elapsedMs() };
  }
}

/** A ByteSource over a file on disk, read with synchronous positioned reads. Close it when done. */
export function fileSource(path: string): ByteSource & { close(): void } {
  const fd = openSync(path, "r");
  const size = fstatSync(fd).size;
  let closed = false;
  return {
    size,
    read(offset, length) {
      const buf = new Uint8Array(length);
      let got = 0;
      while (got < length) {
        const n = readSync(fd, buf, got, length - got, offset + got);
        if (n === 0) break;
        got += n;
      }
      return got === length ? buf : buf.subarray(0, got);
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
}

/** Probes a file on disk (only the bytes the probe needs are read). */
export function probeFile(path: string, opts: ProbeOptions = {}): ProbeResult {
  let source: (ByteSource & { close(): void }) | null = null;
  try {
    source = fileSource(path);
    return probeMedia(source, opts);
  } catch {
    return { ok: false, reason: "corrupt", message: PROBE_MESSAGES.corrupt, bytesRead: 0, ms: 0 };
  } finally {
    source?.close();
  }
}
