/**
 * An in-house MP4 and MOV box parser for ad media (docs/IG-PAGE-ADS-SPEC.md D21, PRM-03). The VPS has no native media library,
 * so the server reads just enough of the file to check it before Meta sees it: the video track's `tkhd` (size and rotation), the
 * movie's `mvhd` (duration) and the first `stsd` entry (codec: avc1, hvc1 or hev1).
 *
 * It never reads sample data: `mdat` and the sample tables are skipped by their sizes, and only the containers on the path to
 * those three boxes are opened (moov, trak, mdia, minf, stbl, mvex). Every read goes through a ReadBudget, which stops the parse
 * after 2 MB of reads or 50 ms, so a truncated or hostile file is rejected quickly with a plain reason instead of hanging.
 *
 * Shared with probe.ts: ByteSource, ReadBudget and MediaProbeError.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Shared reading primitives
// ---------------------------------------------------------------------------------------------------------------------

/** Random access to a file's bytes. `read` may return fewer bytes only at the end of the file. */
export type ByteSource = { readonly size: number; read(offset: number, length: number): Uint8Array };

/** At most this many bytes are read per probe (D21). */
export const MAX_READ_BYTES = 2 * 1024 * 1024;
/** At most this long per probe (D21). */
export const MAX_PROBE_MS = 50;

export type ProbeReason =
  | "empty"
  | "unknown_format"
  | "truncated"
  | "corrupt"
  | "unsupported_codec"
  | "unsupported_image"
  | "no_video_track"
  | "bad_dimensions"
  | "bad_duration"
  | "odd_rotation"
  | "too_complex";

/** What a person sees for each reason: what went wrong and what to do. */
export const PROBE_MESSAGES: Readonly<Record<ProbeReason, string>> = {
  empty: "This file is empty. Choose another file.",
  unknown_format: "Use a JPG or PNG image, or an MP4 or MOV video.",
  truncated: "This file is incomplete. It may not have finished saving or uploading. Save it again and upload it.",
  corrupt: "This file is damaged and can't be read. Export it again and upload it.",
  unsupported_codec: "Meta can't play this kind of video. Export it as an MP4 with H.264 and upload it again.",
  unsupported_image: "This kind of image can't be used. Save it as a standard JPG or PNG and try again.",
  no_video_track: "This file has no video in it. Choose a video file.",
  bad_dimensions: "We couldn't read this file's size in pixels. Export it again and upload it.",
  bad_duration: "We couldn't read how long this video is. Export it again and upload it.",
  odd_rotation: "This video is turned at an angle Meta can't show. Straighten it in your editor and export it again.",
  too_complex: "This file is too complex to check. Export it again and upload it.",
};

/** A file the probe refuses, with the reason. Thrown inside the parsers; probe.ts turns it into a result. */
export class MediaProbeError extends Error {
  readonly reason: ProbeReason;
  constructor(reason: ProbeReason) {
    super(PROBE_MESSAGES[reason]);
    this.name = "MediaProbeError";
    this.reason = reason;
  }
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Counts every byte read and the time spent, and stops the probe at either cap. */
export class ReadBudget {
  bytesRead = 0;
  private readonly started: number;
  constructor(
    readonly maxBytes: number = MAX_READ_BYTES,
    readonly maxMs: number = MAX_PROBE_MS,
    private readonly clock: () => number = now,
  ) {
    this.started = clock();
  }

  elapsedMs(): number {
    return this.clock() - this.started;
  }

  /** Throws too_complex once the time cap has passed. Called on every box or segment. */
  tick(): void {
    if (this.elapsedMs() > this.maxMs) throw new MediaProbeError("too_complex");
  }

  /** Reads exactly `length` bytes at `offset`, counting them. A short read is a truncated file. */
  read(source: ByteSource, offset: number, length: number): Uint8Array {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) throw new MediaProbeError("corrupt");
    if (offset + length > source.size) throw new MediaProbeError("truncated");
    if (this.bytesRead + length > this.maxBytes) throw new MediaProbeError("too_complex");
    this.bytesRead += length;
    const out = source.read(offset, length);
    this.tick();
    if (!(out instanceof Uint8Array) || out.length < length) throw new MediaProbeError("truncated");
    return out.length === length ? out : out.subarray(0, length);
  }
}

/** A ByteSource over bytes already in memory (no copy). */
export function bytesSource(bytes: Uint8Array): ByteSource {
  return { size: bytes.length, read: (offset, length) => bytes.subarray(offset, offset + length) };
}

export const u16 = (b: Uint8Array, i: number): number => (b[i] << 8) | b[i + 1];
export const u32 = (b: Uint8Array, i: number): number => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const i32 = (b: Uint8Array, i: number): number => u32(b, i) | 0;
/** A 64-bit size or duration; anything past 2^53 cannot be a real file and is refused. */
function u64(b: Uint8Array, i: number): number {
  const hi = u32(b, i);
  if (hi > 0x1fffff) throw new MediaProbeError("corrupt");
  return hi * 2 ** 32 + u32(b, i + 4);
}
const fourcc = (b: Uint8Array, i: number): string => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

// ---------------------------------------------------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------------------------------------------------

/** Top-level box types a QuickTime or ISO file may start with. probe.ts reads bytes 4 to 8 against this list. */
export const FIRST_BOX_TYPES: readonly string[] = ["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot"];

export const VIDEO_CODECS = ["avc1", "hvc1", "hev1"] as const;
export type VideoCodec = (typeof VIDEO_CODECS)[number];

/** Box headers read per file at most. A real file has a few dozen on the path we walk (a fragmented one, two per fragment). */
export const MAX_BOXES = 16384;
/** Pixel sides above this are not a real video. */
export const MAX_VIDEO_SIDE = 16384;
/** Durations above a day are not a real ad video. */
const MAX_DURATION_MS = 24 * 3_600_000;

type Box = { type: string; start: number; payload: number; end: number };

/** A box type is four printable characters (QuickTime also uses the copyright sign). */
const validType = (b: Uint8Array, i: number): boolean => {
  for (let k = i; k < i + 4; k++) if (!((b[k] >= 0x20 && b[k] <= 0x7e) || b[k] === 0xa9)) return false;
  return true;
};

class BoxReader {
  boxes = 0;
  constructor(
    private readonly source: ByteSource,
    readonly budget: ReadBudget,
  ) {}

  /** The box header at `offset`, inside a parent that ends at `parentEnd`. */
  header(offset: number, parentEnd: number, topLevel: boolean): Box {
    if (++this.boxes > MAX_BOXES) throw new MediaProbeError("too_complex");
    this.budget.tick();
    const atFileEnd = parentEnd === this.source.size;
    if (offset + 8 > parentEnd) throw new MediaProbeError(atFileEnd ? "truncated" : "corrupt");
    const h = this.budget.read(this.source, offset, 8);
    if (!validType(h, 4)) throw new MediaProbeError("corrupt");
    const type = fourcc(h, 4);
    let size = u32(h, 0);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > parentEnd) throw new MediaProbeError(atFileEnd ? "truncated" : "corrupt");
      size = u64(this.budget.read(this.source, offset + 8, 8), 0);
      headerSize = 16;
    } else if (size === 0) {
      // "To the end of the file" is allowed for the last top-level box only.
      if (!topLevel) throw new MediaProbeError("corrupt");
      size = parentEnd - offset;
    }
    if (size < headerSize) throw new MediaProbeError("corrupt");
    const end = offset + size;
    if (end > parentEnd) throw new MediaProbeError(atFileEnd ? "truncated" : "corrupt");
    return { type, start: offset, payload: offset + headerSize, end };
  }

  /** The children of a container box, one header at a time. */
  *children(parent: { payload: number; end: number }, skip = 0): Generator<Box> {
    let offset = parent.payload + skip;
    while (offset < parent.end) {
      const box = this.header(offset, parent.end, false);
      yield box;
      offset = box.end;
    }
  }

  /** Up to `want` bytes of a box's payload; fewer only if the box is smaller. Fails when it is smaller than `min`. */
  payload(box: Box, min: number, want: number): Uint8Array {
    const available = box.end - box.payload;
    if (available < min) throw new MediaProbeError("corrupt");
    return this.budget.read(this.source, box.payload, Math.min(want, available));
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The parse
// ---------------------------------------------------------------------------------------------------------------------

export type Rotation = 0 | 90 | 180 | 270;

export type Mp4Info = {
  container: "mp4" | "mov";
  /** The ftyp major brand ("isom", "qt  "), or null when the file has no ftyp (old QuickTime). */
  brand: string | null;
  /** The video track's stored size (tkhd), before rotation. */
  width: number;
  height: number;
  /** Clockwise rotation to show the video upright, from the tkhd matrix. */
  rotation: Rotation;
  /** The size as shown: width and height swapped for 90 and 270. */
  displayWidth: number;
  displayHeight: number;
  durationMs: number;
  codec: VideoCodec;
  /** True when moov comes before mdat, so a player can start before the whole file arrives. */
  faststart: boolean;
};

type Track = { handler: string | null; width: number; height: number; rotation: Rotation | null; codec: string | null; mdhdDurationMs: number | null };

const UNIT = 0x10000;
const near = (v: number, target: number) => Math.abs(v - target) <= 16;

/** The clockwise rotation a tkhd matrix (a, b, c, d in 16.16 fixed point) asks for, or null for a mirror or a skew. */
export function rotationOfMatrix(a: number, b: number, c: number, d: number): Rotation | null {
  if (near(a, UNIT) && near(b, 0) && near(c, 0) && near(d, UNIT)) return 0;
  if (near(a, 0) && near(b, UNIT) && near(c, -UNIT) && near(d, 0)) return 90;
  if (near(a, -UNIT) && near(b, 0) && near(c, 0) && near(d, -UNIT)) return 180;
  if (near(a, 0) && near(b, -UNIT) && near(c, UNIT) && near(d, 0)) return 270;
  return null;
}

function readTkhd(r: BoxReader, box: Box, track: Track): void {
  const head = r.payload(box, 4, 4);
  const v1 = head[0] === 1;
  if (head[0] > 1) throw new MediaProbeError("corrupt");
  const matrixAt = v1 ? 52 : 40;
  const p = r.payload(box, matrixAt + 44, matrixAt + 44);
  track.rotation = rotationOfMatrix(i32(p, matrixAt), i32(p, matrixAt + 4), i32(p, matrixAt + 12), i32(p, matrixAt + 16));
  // 16.16 fixed point; the fraction is dropped.
  track.width = Math.floor(u32(p, matrixAt + 36) / UNIT);
  track.height = Math.floor(u32(p, matrixAt + 40) / UNIT);
}

/** Duration in ms from a version 0 or 1 full box laid out as mvhd or mdhd (creation, modification, timescale, duration). */
function readTimescaled(r: BoxReader, box: Box): { timescale: number; durationMs: number } {
  const head = r.payload(box, 4, 4);
  if (head[0] > 1) throw new MediaProbeError("corrupt");
  const v1 = head[0] === 1;
  const p = r.payload(box, v1 ? 32 : 20, v1 ? 32 : 20);
  const timescale = u32(p, v1 ? 20 : 12);
  const raw = v1 ? u64(p, 24) : u32(p, 16);
  // All ones means "unknown"; a zero timescale cannot be divided by.
  const unknown = v1 ? false : raw === 0xffffffff;
  if (timescale === 0 || unknown) return { timescale, durationMs: 0 };
  return { timescale, durationMs: (raw / timescale) * 1000 };
}

function readHandler(r: BoxReader, box: Box): string {
  const p = r.payload(box, 12, 12);
  return fourcc(p, 8);
}

function readCodec(r: BoxReader, box: Box): string {
  // Full box header (4), entry count (4), then the first sample entry's size (4) and format (4).
  const p = r.payload(box, 16, 16);
  if (u32(p, 4) < 1) throw new MediaProbeError("corrupt");
  const entrySize = u32(p, 8);
  if (entrySize < 8 || box.payload + 8 + entrySize > box.end) throw new MediaProbeError("corrupt");
  if (!validType(p, 12)) throw new MediaProbeError("corrupt");
  return fourcc(p, 12);
}

function readStbl(r: BoxReader, stbl: Box, track: Track): void {
  for (const box of r.children(stbl)) if (box.type === "stsd" && track.codec === null) track.codec = readCodec(r, box);
}

function readMinf(r: BoxReader, minf: Box, track: Track): void {
  for (const box of r.children(minf)) if (box.type === "stbl") readStbl(r, box, track);
}

function readMdia(r: BoxReader, mdia: Box, track: Track): void {
  for (const box of r.children(mdia)) {
    if (box.type === "hdlr" && track.handler === null) track.handler = readHandler(r, box);
    else if (box.type === "mdhd" && track.mdhdDurationMs === null) track.mdhdDurationMs = readTimescaled(r, box).durationMs;
    else if (box.type === "minf") readMinf(r, box, track);
  }
}

function readTrak(r: BoxReader, trak: Box): Track {
  const track: Track = { handler: null, width: 0, height: 0, rotation: null, codec: null, mdhdDurationMs: null };
  let sawTkhd = false;
  for (const box of r.children(trak)) {
    if (box.type === "tkhd" && !sawTkhd) {
      sawTkhd = true;
      readTkhd(r, box, track);
    } else if (box.type === "mdia") readMdia(r, box, track);
  }
  if (!sawTkhd) throw new MediaProbeError("corrupt");
  return track;
}

/**
 * Parses an MP4 or MOV file. Throws MediaProbeError with the reason when the file is truncated, damaged, hostile, has no video
 * track, or uses a codec other than avc1, hvc1 or hev1.
 */
export function parseMp4(source: ByteSource, budget: ReadBudget = new ReadBudget()): Mp4Info {
  if (source.size === 0) throw new MediaProbeError("empty");
  if (source.size < 8) throw new MediaProbeError("truncated");
  // Not an ISO or QuickTime file at all: say so before reading any sizes.
  if (!FIRST_BOX_TYPES.includes(fourcc(budget.read(source, 0, 8), 4))) throw new MediaProbeError("unknown_format");
  const r = new BoxReader(source, budget);
  let brand: string | null = null;
  let quicktime = false;
  let moov: Box | null = null;
  let mdatSeen = false;
  let faststart = false;
  let offset = 0;
  let first = true;
  while (offset < source.size) {
    const box = r.header(offset, source.size, true);
    if (first && !FIRST_BOX_TYPES.includes(box.type)) throw new MediaProbeError("unknown_format");
    first = false;
    if (box.type === "ftyp" && brand === null) {
      const p = r.payload(box, 8, 64);
      brand = fourcc(p, 0);
      quicktime = brand === "qt  ";
      // A compatible "qt  " brand under another major brand is still QuickTime.
      for (let i = 8; !quicktime && i + 4 <= p.length; i += 4) quicktime = fourcc(p, i) === "qt  ";
    } else if (box.type === "moov" && moov === null) {
      moov = box;
      faststart = !mdatSeen;
    } else if (box.type === "mdat") {
      mdatSeen = true;
    }
    offset = box.end;
  }
  // A recording that stopped before the index was written has media but no moov; a file cut right after its moov has no media.
  if (!moov || !mdatSeen) throw new MediaProbeError("truncated");

  let movie = { timescale: 0, durationMs: 0 };
  let fragmentDuration: number | null = null;
  let video: Track | null = null;
  for (const box of r.children(moov)) {
    if (box.type === "mvhd") movie = readTimescaled(r, box);
    else if (box.type === "trak" && video === null) {
      const track = readTrak(r, box);
      if (track.handler === "vide") video = track;
    } else if (box.type === "mvex") {
      for (const child of r.children(box)) {
        if (child.type !== "mehd") continue;
        const head = r.payload(child, 4, 4);
        const v1 = head[0] === 1;
        const p = r.payload(child, v1 ? 12 : 8, v1 ? 12 : 8);
        fragmentDuration = v1 ? u64(p, 4) : u32(p, 4);
      }
    }
  }
  if (!video) throw new MediaProbeError("no_video_track");
  if (video.codec === null) throw new MediaProbeError("corrupt");
  if (!(VIDEO_CODECS as readonly string[]).includes(video.codec)) throw new MediaProbeError("unsupported_codec");
  if (video.rotation === null) throw new MediaProbeError("odd_rotation");
  if (video.width < 1 || video.height < 1 || video.width > MAX_VIDEO_SIDE || video.height > MAX_VIDEO_SIDE) throw new MediaProbeError("bad_dimensions");

  let durationMs = movie.durationMs;
  if (!(durationMs > 0) && fragmentDuration && movie.timescale > 0) durationMs = (fragmentDuration / movie.timescale) * 1000;
  if (!(durationMs > 0) && video.mdhdDurationMs) durationMs = video.mdhdDurationMs;
  if (!(durationMs > 0) || durationMs > MAX_DURATION_MS) throw new MediaProbeError("bad_duration");

  const turned = video.rotation === 90 || video.rotation === 270;
  return {
    container: quicktime || brand === null ? "mov" : "mp4",
    brand,
    width: video.width,
    height: video.height,
    rotation: video.rotation,
    displayWidth: turned ? video.height : video.width,
    displayHeight: turned ? video.width : video.height,
    durationMs: Math.round(durationMs),
    codec: video.codec as VideoCodec,
    faststart,
  };
}
