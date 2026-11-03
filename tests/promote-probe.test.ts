import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("image-size", async (importOriginal) => {
  const actual = await importOriginal<typeof import("image-size")>();
  return { ...actual, imageSize: vi.fn(actual.imageSize) };
});

import { imageSize } from "image-size";
import { MAX_BOXES, parseMp4, ReadBudget, rotationOfMatrix } from "@/lib/promote/mp4";
import { bytesSource, type ByteSource, MAX_PROBE_MS, MAX_READ_BYTES, PROBE_MESSAGES, probeFile, probeMedia, type ProbeReason } from "@/lib/promote/probe";

/**
 * docs/IG-PAGE-ADS-SPEC.md D21 and 9.1 (promote-probe): JPEG and PNG sizes through image-size; MP4 and MOV size, rotation,
 * duration and codec from the in-house box parser, including a rotated 9:16 video; truncated and hostile files rejected within
 * 50 ms and 2 MB of reads.
 *
 * Fixtures (tests/fixtures/promote-media) were made with ffmpeg 9 from its test pattern, for example:
 *   ffmpeg -f lavfi -i testsrc=size=64x36:rate=10 -t 1.5 -c:v libx264 -pix_fmt yuv420p -movflags +faststart landscape-avc1.mp4
 *   ffmpeg -display_rotation:v:0 -90 -i unrotated-128x72.mp4 -c copy -movflags +faststart portrait-rotated-avc1.mp4
 *   ffmpeg -f lavfi -i testsrc=size=64x36:rate=10 -t 1 -c:v libx265 -tag:v hvc1 hevc-hvc1.mov   (and -tag:v hev1 for hev1)
 * motion-photo.jpg is landscape.jpg with an MP4 appended after its end marker, the way Google Pixel and Samsung Motion Photos
 * store their video: the ftyp and moov of landscape-avc1.mp4 around a 192 KiB mdat of seeded bytes (moov last), with no FF D9
 * pair anywhere in the MP4, so its last 64 KB hold no JPEG end marker.
 */

const DIR = path.join(process.cwd(), "tests", "fixtures", "promote-media");
const fixture = (name: string) => new Uint8Array(readFileSync(path.join(DIR, name)));
const FIXTURES = ["landscape.jpg", "square.png", "landscape-avc1.mp4", "moov-at-end.mp4", "portrait-rotated-avc1.mp4", "hevc-hvc1.mov", "hevc-hev1.mp4", "vp9.mp4", "audio-only.m4a"];

// ----- Byte builders -----
const concat = (...parts: (Uint8Array | number[])[]) => {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
};
const be16 = (n: number) => [(n >>> 8) & 255, n & 255];
const be32 = (n: number) => {
  const u = n >>> 0;
  return [(u >>> 24) & 255, (u >>> 16) & 255, (u >>> 8) & 255, u & 255];
};
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const zeros = (n: number) => new Array<number>(n).fill(0);
const box = (type: string, ...payload: (Uint8Array | number[])[]) => {
  const body = concat(...payload);
  return concat(be32(8 + body.length), ascii(type), body);
};
const full = (version: number, flags = 0) => [version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255];
/** `unit` repeated `times` times, without spreading a huge argument list. */
const repeat = (unit: Uint8Array | number[], times: number) => {
  const u = unit instanceof Uint8Array ? unit : Uint8Array.from(unit);
  const out = new Uint8Array(u.length * times);
  for (let i = 0; i < times; i++) out.set(u, i * u.length);
  return out;
};

const IDENTITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
const ROT90 = [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000];
const ROT180 = [-0x10000, 0, 0, 0, -0x10000, 0, 0, 0, 0x40000000];
const ROT270 = [0, -0x10000, 0, 0x10000, 0, 0, 0, 0, 0x40000000];
const MIRROR = [-0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

type Mp4Spec = {
  brand?: string;
  codec?: string;
  width?: number;
  height?: number;
  matrix?: number[];
  timescale?: number;
  duration?: number;
  mvhdVersion?: 0 | 1;
  tkhdVersion?: 0 | 1;
  mdhdDuration?: number;
  handler?: string;
  extraMoov?: Uint8Array[];
  mdat?: Uint8Array;
  moovFirst?: boolean;
};

function mvhd(timescale: number, duration: number, version: 0 | 1) {
  return version === 1 ? box("mvhd", full(1), zeros(8), zeros(8), be32(timescale), be32(Math.floor(duration / 2 ** 32)), be32(duration % 2 ** 32), zeros(80)) : box("mvhd", full(0), zeros(4), zeros(4), be32(timescale), be32(duration), zeros(80));
}
function tkhd(width: number, height: number, matrix: number[], version: 0 | 1) {
  const times = version === 1 ? concat(zeros(8), zeros(8), be32(1), zeros(4), zeros(8)) : concat(zeros(4), zeros(4), be32(1), zeros(4), zeros(4));
  return box("tkhd", full(version, 7), times, zeros(8), zeros(8), concat(...matrix.map(be32)), be32(width * 0x10000), be32(height * 0x10000));
}
function mp4(s: Mp4Spec = {}) {
  const timescale = s.timescale ?? 1000;
  const trak = box(
    "trak",
    tkhd(s.width ?? 1080, s.height ?? 1920, s.matrix ?? IDENTITY, s.tkhdVersion ?? 0),
    box(
      "mdia",
      box("mdhd", full(0), zeros(4), zeros(4), be32(timescale), be32(s.mdhdDuration ?? s.duration ?? 15000), zeros(4)),
      box("hdlr", full(0), zeros(4), ascii(s.handler ?? "vide"), zeros(12), [0]),
      box("minf", box("vmhd", full(0, 1), zeros(8)), box("stbl", box("stsd", full(0), be32(1), box(s.codec ?? "avc1", zeros(78))), box("stts", full(0), be32(0)))),
    ),
  );
  const moov = box("moov", mvhd(timescale, s.duration ?? 15000, s.mvhdVersion ?? 0), trak, ...(s.extraMoov ?? []));
  const ftyp = box("ftyp", ascii(s.brand ?? "isom"), be32(512), ascii("isomiso2avc1mp41"));
  const mdat = s.mdat ?? box("mdat", zeros(64));
  return s.moovFirst === false ? concat(ftyp, mdat, moov) : concat(ftyp, moov, mdat);
}

function failOf(input: Uint8Array | ByteSource, opts?: Parameters<typeof probeMedia>[1]): ProbeReason {
  const r = probeMedia(input, opts);
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r.media)}`);
  return r.reason;
}

/** A JPEG with an EXIF orientation, spliced in after SOI. */
function withExifOrientation(jpeg: Uint8Array, orientation: number) {
  const tiff = concat(ascii("MM"), be16(0x2a), be32(8), be16(1), be16(0x0112), be16(3), be32(1), be16(orientation), be16(0), be32(0));
  const payload = concat(ascii("Exif"), [0, 0], tiff);
  return concat(jpeg.subarray(0, 2), [0xff, 0xe1], be16(payload.length + 2), payload, jpeg.subarray(2));
}
const indexOf = (b: Uint8Array, needle: number[]) => {
  for (let i = 0; i + needle.length <= b.length; i++) if (needle.every((v, k) => b[i + k] === v)) return i;
  return -1;
};

/** Small seeded PRNG, so a fuzz failure can be replayed. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A source that records every read, to check the 2 MB cap from the outside. */
function counting(bytes: Uint8Array) {
  let read = 0;
  const src: ByteSource = {
    size: bytes.length,
    read(offset, length) {
      read += length;
      return bytes.subarray(offset, offset + length);
    },
  };
  return { src, read: () => read };
}

function within(input: Uint8Array) {
  const c = counting(input);
  const t0 = performance.now();
  const r = probeMedia(c.src);
  const ms = performance.now() - t0;
  return { r, ms, read: c.read() };
}

beforeEach(() => {
  vi.mocked(imageSize).mockClear();
});

describe("caps (D21)", () => {
  it("are 2 MB of reads and 50 ms", () => {
    expect(MAX_READ_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_PROBE_MS).toBe(50);
  });

  it("every reason has plain copy that says what to do", () => {
    for (const [reason, text] of Object.entries(PROBE_MESSAGES)) {
      expect(text, reason).toMatch(/[.!]$/);
      expect(text.length, reason).toBeLessThan(140);
      expect(text, reason).not.toMatch(/moov|mdat|tkhd|codec|EOI|IHDR|box/i);
    }
  });
});

describe("images through image-size", () => {
  it("reads a JPEG's size", () => {
    const r = probeMedia(fixture("landscape.jpg"));
    expect(r.ok && r.media).toMatchObject({ kind: "image", format: "jpeg", width: 64, height: 36, orientation: null, displayWidth: 64, displayHeight: 36 });
    expect(imageSize).toHaveBeenCalled();
  });

  it("reads a PNG's size", () => {
    const r = probeMedia(fixture("square.png"));
    expect(r.ok && r.media).toMatchObject({ kind: "image", format: "png", width: 48, height: 48, displayWidth: 48, displayHeight: 48 });
    expect(imageSize).toHaveBeenCalledTimes(1);
  });

  it("reads the EXIF orientation and swaps the shown size for orientations 5 to 8", () => {
    const six = probeMedia(withExifOrientation(fixture("landscape.jpg"), 6));
    expect(six.ok && six.media).toMatchObject({ width: 64, height: 36, orientation: 6, displayWidth: 36, displayHeight: 64 });
    const three = probeMedia(withExifOrientation(fixture("landscape.jpg"), 3));
    expect(three.ok && three.media).toMatchObject({ orientation: 3, displayWidth: 64, displayHeight: 36 });
  });

  it("hands image-size only the frame header and EXIF, never the whole file", () => {
    probeMedia(fixture("landscape.jpg"));
    const input = vi.mocked(imageSize).mock.calls[0][0];
    expect(input.length).toBeLessThan(64);
    expect([...input.subarray(0, 2)]).toEqual([0xff, 0xd8]);
  });

  it("refuses JPEG kinds Meta does not take, and PNGs that are not standard", () => {
    const jpeg = fixture("landscape.jpg");
    const sof = indexOf(jpeg, [0xff, 0xc0]);
    expect(sof).toBeGreaterThan(0);
    const lossless = jpeg.slice();
    lossless[sof + 1] = 0xc3;
    expect(failOf(lossless)).toBe("unsupported_image");

    const png = fixture("square.png");
    const cgbi = png.slice();
    cgbi.set(ascii("CgBI"), 12);
    expect(failOf(cgbi)).toBe("unsupported_image");
  });

  it("refuses impossible sizes", () => {
    const png = fixture("square.png");
    const zero = png.slice();
    zero.set(be32(0), 16);
    expect(failOf(zero)).toBe("bad_dimensions");
    const huge = png.slice();
    huge.set(be32(0x7fffffff), 16);
    expect(failOf(huge)).toBe("bad_dimensions");
    const jpeg = fixture("landscape.jpg");
    const sof = indexOf(jpeg, [0xff, 0xc0]);
    const flat = jpeg.slice();
    flat.set(be16(0), sof + 5);
    expect(failOf(flat)).toBe("bad_dimensions");
  });
});

describe("MP4 and MOV through the box parser", () => {
  it("reads an H.264 MP4: size, duration, codec, no rotation, moov first", () => {
    const r = probeMedia(fixture("landscape-avc1.mp4"));
    expect(r.ok && r.media).toEqual({ kind: "video", format: "mp4", width: 64, height: 36, rotation: 0, displayWidth: 64, displayHeight: 36, durationMs: 1500, codec: "avc1", faststart: true, bytes: fixture("landscape-avc1.mp4").length });
    expect(imageSize).not.toHaveBeenCalled();
  });

  it("reads an MP4 whose moov comes after mdat, without reading the media", () => {
    const r = probeMedia(fixture("moov-at-end.mp4"));
    expect(r.ok && r.media).toMatchObject({ format: "mp4", durationMs: 1000, codec: "avc1", faststart: false });
    expect(r.bytesRead).toBeLessThan(600);
  });

  it("reads a rotated 9:16 phone video: stored 16:9, shown 9:16", () => {
    const r = probeMedia(fixture("portrait-rotated-avc1.mp4"));
    expect(r.ok && r.media).toMatchObject({ format: "mp4", width: 128, height: 72, rotation: 90, displayWidth: 72, displayHeight: 128, durationMs: 2000, codec: "avc1" });
    if (!r.ok || r.media.kind !== "video") throw new Error("unreachable");
    expect(r.media.displayWidth / r.media.displayHeight).toBeCloseTo(9 / 16, 2);
  });

  it("reads a QuickTime MOV with hvc1, and an MP4 with hev1", () => {
    expect(probeMedia(fixture("hevc-hvc1.mov"))).toMatchObject({ ok: true, media: { format: "mov", codec: "hvc1", width: 64, height: 36, durationMs: 1000 } });
    expect(probeMedia(fixture("hevc-hev1.mp4"))).toMatchObject({ ok: true, media: { format: "mp4", codec: "hev1", width: 64, height: 36, durationMs: 1000 } });
  });

  it("refuses other codecs and files with no video", () => {
    expect(failOf(fixture("vp9.mp4"))).toBe("unsupported_codec");
    expect(failOf(fixture("audio-only.m4a"))).toBe("no_video_track");
  });

  it("reads every rotation from the matrix and refuses a mirror", () => {
    expect(rotationOfMatrix(0x10000, 0, 0, 0x10000)).toBe(0);
    for (const [matrix, rotation] of [[ROT90, 90], [ROT180, 180], [ROT270, 270]] as const) {
      const r = probeMedia(mp4({ width: 1920, height: 1080, matrix }));
      expect(r.ok && r.media, String(rotation)).toMatchObject({ rotation, displayWidth: rotation === 180 ? 1920 : 1080, displayHeight: rotation === 180 ? 1080 : 1920 });
    }
    expect(failOf(mp4({ matrix: MIRROR }))).toBe("odd_rotation");
  });

  it("reads version 1 headers, 64-bit box sizes and a last box that runs to the end of the file", () => {
    expect(probeMedia(mp4({ mvhdVersion: 1, tkhdVersion: 1, duration: 30_000 }))).toMatchObject({ ok: true, media: { durationMs: 30_000, width: 1080, height: 1920 } });
    const large = concat(be32(1), ascii("mdat"), be32(0), be32(16 + 32), zeros(32));
    expect(probeMedia(mp4({ mdat: large }))).toMatchObject({ ok: true });
    const toEnd = concat(be32(0), ascii("mdat"), zeros(40));
    expect(probeMedia(mp4({ mdat: toEnd }))).toMatchObject({ ok: true });
    expect(probeMedia(mp4({ brand: "qt  " }))).toMatchObject({ ok: true, media: { format: "mov" } });
  });

  it("falls back to the track duration when the movie has none, and refuses a video with no length", () => {
    expect(probeMedia(mp4({ duration: 0, mdhdDuration: 9_000 }))).toMatchObject({ ok: true, media: { durationMs: 9_000 } });
    expect(failOf(mp4({ duration: 0, mdhdDuration: 0 }))).toBe("bad_duration");
    expect(failOf(mp4({ timescale: 0 }))).toBe("bad_duration");
    expect(failOf(mp4({ duration: 0xffffffff, mdhdDuration: 0 }))).toBe("bad_duration");
  });

  it("refuses impossible sizes", () => {
    expect(failOf(mp4({ width: 0 }))).toBe("bad_dimensions");
    expect(failOf(mp4({ height: 40_000 }))).toBe("bad_dimensions");
  });

  it("parseMp4 refuses a file that is not ISO or QuickTime", () => {
    expect(() => parseMp4(bytesSource(fixture("landscape.jpg")))).toThrow(PROBE_MESSAGES.unknown_format);
  });
});

describe("files that are not media", () => {
  it("names the problem", () => {
    expect(failOf(new Uint8Array(0))).toBe("empty");
    expect(failOf(new TextEncoder().encode("%PDF-1.7 not an image at all"))).toBe("unknown_format");
    expect(failOf(new TextEncoder().encode("GIF89a......................"))).toBe("unknown_format");
    expect(failOf(Uint8Array.of(0xff, 0xd8))).toBe("truncated");
    expect(failOf(Uint8Array.of(1, 2, 3))).toBe("truncated");
  });

  it("probes a file on disk, and a missing file is refused, not thrown", () => {
    expect(probeFile(path.join(DIR, "portrait-rotated-avc1.mp4"))).toMatchObject({ ok: true, media: { rotation: 90 } });
    expect(probeFile(path.join(DIR, "no-such-file.mp4"))).toMatchObject({ ok: false, reason: "corrupt" });
  });
});

describe("truncated files (fuzz: every cut point)", () => {
  it.each(FIXTURES)("%s cut anywhere is refused within 50 ms and 2 MB", (name) => {
    const bytes = fixture(name);
    probeMedia(bytes); // warm up
    let worst = 0;
    for (let cut = 0; cut < bytes.length; cut++) {
      const { r, ms, read } = within(bytes.subarray(0, cut));
      if (r.ok) throw new Error(`${name} cut at ${cut} of ${bytes.length} was accepted`);
      expect(["empty", "truncated", "corrupt", "unknown_format", "no_video_track", "unsupported_codec", "bad_dimensions", "bad_duration"]).toContain(r.reason);
      expect(read).toBeLessThanOrEqual(MAX_READ_BYTES);
      worst = Math.max(worst, ms);
    }
    expect(worst).toBeLessThan(MAX_PROBE_MS);
  });
});

describe("data after a JPEG's end (Motion Photos)", () => {
  const EOI = [0xff, 0xd9];
  /** landscape.jpg up to where its image data starts (just past its SOS header). */
  function jpegHead() {
    const jpeg = fixture("landscape.jpg");
    const sos = indexOf(jpeg, [0xff, 0xda]);
    return jpeg.subarray(0, sos + 2 + ((jpeg[sos + 2] << 8) | jpeg[sos + 3]));
  }
  /** Bytes shaped like compressed image data: every FF is followed by a stuffed 00, so no marker and no end. */
  function imageData(n: number, seed: number) {
    const rand = prng(seed);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = Math.floor(rand() * 256);
      if (out[i] === 0xff) {
        if (i + 1 < n) out[++i] = 0;
        else out[i] = 0x7f;
      }
    }
    return out;
  }
  /** Bytes shaped like a video's: anything, but never the pair FF D9. */
  function videoData(n: number, seed: number) {
    const rand = prng(seed);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.floor(rand() * 256);
    for (let i = 0; i + 1 < n; i++) if (out[i] === 0xff && out[i + 1] === 0xd9) out[i + 1] = 0xd8;
    return out;
  }

  it("a Motion Photo (a video of over 64 KB after the photo, no end marker in its last 64 KB) is a whole photo", () => {
    const bytes = fixture("motion-photo.jpg");
    const photo = fixture("landscape.jpg").length;
    expect(bytes.length - photo).toBeGreaterThan(64 * 1024);
    expect(indexOf(bytes.subarray(bytes.length - 64 * 1024), EOI)).toBe(-1);
    const r = probeMedia(bytes);
    expect(r.ok && r.media).toMatchObject({ kind: "image", format: "jpeg", width: 64, height: 36, displayWidth: 64, displayHeight: 36, bytes: bytes.length });
    // The end is found by walking the photo's own data: the tail, then one 64 KB step of the walk, never the whole video.
    expect(r.bytesRead).toBeLessThan(2 * 64 * 1024 + 2 * photo);
    expect(r.bytesRead).toBeLessThan(bytes.length);
    expect(probeFile(path.join(DIR, "motion-photo.jpg"))).toMatchObject({ ok: true, media: { width: 64, height: 36 } });
  });

  it("cut anywhere in its video it is still a whole photo; cut anywhere in the photo it is refused", () => {
    const bytes = fixture("motion-photo.jpg");
    const photo = fixture("landscape.jpg").length;
    for (let cut = photo; cut <= bytes.length; cut += 997) expect(probeMedia(bytes.subarray(0, cut)).ok, `cut at ${cut}`).toBe(true);
    for (let cut = 0; cut < photo; cut++) expect(probeMedia(bytes.subarray(0, cut)).ok, `cut at ${cut}`).toBe(false);
  });

  it("a large photo with a video after it: the walk runs out of reads first, and a tail that is not image data means a whole photo", () => {
    const bytes = concat(jpegHead(), imageData(2_500_000, 1), EOI, videoData(300_000, 2));
    within(bytes); // warm up
    const { r, read, ms } = within(bytes);
    expect(r).toMatchObject({ ok: true, media: { width: 64, height: 36 } });
    expect(read).toBeLessThanOrEqual(MAX_READ_BYTES);
    expect(ms).toBeLessThan(MAX_PROBE_MS);
  });

  it("a large photo cut short in its image data is still refused as truncated (its tail is bare image data)", () => {
    const bytes = concat(jpegHead(), imageData(2_500_000, 3));
    within(bytes); // warm up
    const { r, read, ms } = within(bytes);
    expect(r).toMatchObject({ ok: false, reason: "truncated" });
    expect(read).toBeLessThanOrEqual(MAX_READ_BYTES);
    expect(ms).toBeLessThan(MAX_PROBE_MS);
  });

  it("a large photo that ends where it should is settled from its tail, with few reads", () => {
    const { r, read } = within(concat(jpegHead(), imageData(2_500_000, 4), EOI));
    expect(r.ok).toBe(true);
    expect(read).toBeLessThan(64 * 1024 + 4096);
  });

  it("the walk skips a progressive file's tables and next scan by their lengths", () => {
    // Table bytes that would read as markers if walked byte by byte (FF D8 would be refused as damaged).
    const tables = concat([0xff, 0xc4], be16(2 + 6), [0x00, 0xff, 0xd8, 0xff, 0xd9, 0x01]);
    const scan = concat([0xff, 0xda], be16(8), [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
    expect(probeMedia(concat(jpegHead(), imageData(20_000, 5), tables, scan, imageData(20_000, 6), EOI, videoData(100_000, 7)))).toMatchObject({ ok: true });
    expect(failOf(concat(jpegHead(), imageData(20_000, 5), [0xff, 0xc4], be16(2 + 60_000), zeros(10)))).toBe("truncated");
    expect(failOf(concat(jpegHead(), imageData(20_000, 5), [0xff, 0xd8], imageData(100, 8)))).toBe("corrupt");
  });

  it("a frame header with no image data after it is refused", () => {
    const head = jpegHead();
    const sos = indexOf(head, [0xff, 0xda]);
    expect(failOf(head.subarray(0, sos))).toBe("truncated");
    expect(failOf(concat(head.subarray(0, sos), EOI))).toBe("corrupt");
  });
});

describe("hostile files", () => {
  const cases: [string, () => Uint8Array, ProbeReason][] = [
    ["a box smaller than its header", () => concat(box("ftyp", ascii("isom"), be32(0)), be32(4), ascii("moov"), zeros(32)), "corrupt"],
    ["a 64-bit size past 2^53", () => concat(box("ftyp", ascii("isom"), be32(0)), be32(1), ascii("mdat"), be32(0x00ffffff), be32(0), zeros(32)), "corrupt"],
    ["a child larger than its parent", () => concat(box("ftyp", ascii("isom"), be32(0)), box("moov", be32(4096), ascii("trak"), zeros(16)), box("mdat", zeros(8))), "corrupt"],
    ["a size-0 box inside moov", () => concat(box("ftyp", ascii("isom"), be32(0)), box("moov", be32(0), ascii("trak"), zeros(16)), box("mdat", zeros(8))), "corrupt"],
    ["a tkhd too short to hold a size", () => concat(box("ftyp", ascii("isom"), be32(0)), box("moov", box("trak", box("tkhd", full(0), zeros(8)))), box("mdat", zeros(8))), "corrupt"],
    ["a box type with control bytes", () => concat(box("ftyp", ascii("isom"), be32(0)), be32(16), [1, 2, 3, 4], zeros(8)), "corrupt"],
    ["a moov with 100,000 tiny boxes", () => concat(box("ftyp", ascii("isom"), be32(0)), box("moov", repeat(box("free"), 100_000)), box("mdat", zeros(8))), "too_complex"],
    ["3 MB of tiny top-level boxes", () => concat(box("ftyp", ascii("isom"), be32(0)), repeat(box("free"), 393_216)), "too_complex"],
    ["a 3 MB mdat and no moov", () => concat(box("ftyp", ascii("isom"), be32(0)), box("mdat", new Uint8Array(3 * 1024 * 1024))), "truncated"],
    ["a moov and no media", () => { const f = mp4(); return f.subarray(0, f.length - 72); }, "truncated"],
    ["2 MB of JPEG fill bytes", () => concat([0xff, 0xd8], new Uint8Array(2 * 1024 * 1024).fill(0xff)), "corrupt"],
    ["600 empty JPEG segments before the frame", () => concat([0xff, 0xd8], repeat([0xff, 0xe2, 0x00, 0x02], 600), fixture("landscape.jpg").subarray(2)), "too_complex"],
    ["1 MB of zeros after a JPEG segment (the copy-per-byte trap)", () => concat([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], zeros(14), new Uint8Array(1024 * 1024)), "corrupt"],
    ["image data before any JPEG frame header", () => concat([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08], zeros(6), [0xff, 0xd9]), "corrupt"],
    ["a JPEG segment longer than the file", () => concat([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff], zeros(10)), "truncated"],
    ["a PNG whose header chunk has the wrong length", () => { const p = fixture("square.png").slice(); p.set(be32(14), 8); return p; }, "corrupt"],
    ["a PNG with IHDR missing", () => { const p = fixture("square.png").slice(); p.set(ascii("IDAT"), 12); return p; }, "corrupt"],
  ];

  it.each(cases)("%s is refused within 50 ms and 2 MB", (_name, make, reason) => {
    const bytes = make();
    within(bytes); // warm up
    const { r, ms, read } = within(bytes);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
    expect(read).toBeLessThanOrEqual(MAX_READ_BYTES);
    expect(ms).toBeLessThan(MAX_PROBE_MS);
  });

  it("the box cap is what stops a file of endless boxes", () => {
    const many = concat(box("ftyp", ascii("isom"), be32(0)), repeat(box("free"), MAX_BOXES + 10), box("mdat", zeros(8)));
    const r = probeMedia(many);
    expect(r).toMatchObject({ ok: false, reason: "too_complex" });
    expect(r.bytesRead).toBeLessThan(MAX_BOXES * 8 + 64);
  });

  it("random byte damage never throws and never breaks the caps", () => {
    const rand = prng(20261031);
    for (const name of FIXTURES) {
      const original = fixture(name);
      for (let round = 0; round < 150; round++) {
        const bytes = original.slice();
        const hits = 1 + Math.floor(rand() * 8);
        // Damage the headers most of the time (where the parsers look), anywhere otherwise.
        for (let h = 0; h < hits; h++) bytes[Math.floor(rand() * (rand() < 0.8 ? Math.min(600, bytes.length) : bytes.length))] = Math.floor(rand() * 256);
        const { r, read, ms } = within(bytes);
        expect(typeof r.ok).toBe("boolean");
        expect(read).toBeLessThanOrEqual(MAX_READ_BYTES);
        expect(ms).toBeLessThan(MAX_PROBE_MS);
        if (!r.ok) expect(PROBE_MESSAGES[r.reason]).toBe(r.message);
      }
    }
  });

  it("stops at 50 ms of a slow source (fake clock), and at the read cap", () => {
    let t = 0;
    const clock = () => (t += 7);
    expect(failOf(fixture("landscape-avc1.mp4"), { clock })).toBe("too_complex");
    expect(failOf(fixture("landscape-avc1.mp4"), { maxBytes: 100 })).toBe("too_complex");
    const budget = new ReadBudget(10, 50);
    expect(() => budget.read(bytesSource(new Uint8Array(64)), 0, 11)).toThrow(PROBE_MESSAGES.too_complex);
  });

  it("a source that comes back short is truncated, and one that throws is refused, not thrown", () => {
    const bytes = fixture("landscape-avc1.mp4");
    const short: ByteSource = { size: bytes.length, read: (o, l) => bytes.subarray(o, o + Math.max(0, l - 1)) };
    expect(failOf(short)).toBe("truncated");
    const broken: ByteSource = {
      size: bytes.length,
      read: () => {
        throw new Error("EIO");
      },
    };
    expect(failOf(broken)).toBe("corrupt");
  });
});
