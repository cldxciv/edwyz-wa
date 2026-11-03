/**
 * Shared parts of the per-channel publishers (docs/specs/PAGE-IG-PUBLISHING-INSIGHTS-LIVE-THREADS-SPEC.md 3.1, 4.3; package
 * SOC-03): the error and result types, the media a publisher receives, and the progress kept in PostTarget.progress so that a
 * repeated run reuses what Meta already returned and never makes a second container, video or upload session.
 *
 * Until SOC-10 turns ../publishers.ts into a barrel that re-exports this file, that file keeps its own PublishError and nothing
 * imports this one from publish.ts, so the two classes never meet in one instanceof check.
 */
import { GraphError } from "@/lib/graph";
import { explainMetaError, QUOTA_RECHECK_MS, unclearOutcome, type ErrorContext, type PlainError } from "../errors";
import type { MediaKind } from "../limits";

/**
 * A failed step. retry: a later attempt may succeed (Meta refused, or nothing was sent). The message is plain copy (errors.ts),
 * never Meta's own text. `plain` says what to do: a "wait" answer becomes a Deferred, an "unclear" one fails without a retry.
 */
export class PublishError extends Error {
  constructor(
    message: string,
    public retry = false,
    public plain?: PlainError,
  ) {
    super(message);
  }

  /** The step may have reached Meta: fail it and ask the owner to check before posting again (3.5 last row). */
  get unclear(): boolean {
    return this.plain?.action === "unclear";
  }
}

export type Deferred = { defer: { ms: number; message: string } };
export type Published = { externalId: string; permalink?: string | null };

/** One media file of the post, already resolved by publish.ts (SOC-10) from the library. */
export type MediaFile = {
  key: string;
  kind: MediaKind;
  /** The file on disk, streamed to Meta's upload hosts. */
  path: string;
  bytes: number;
  width?: number;
  height?: number;
  durationMs?: number;
  /** The signed public URL (1 h) Meta fetches for photos and Threads media. */
  url: string;
};

export type PublishPhase = "upload" | "create" | "publish";

/** PostTarget.progress (4.3): written before each next step; never returned to the browser. */
export type PostTargetProgress = {
  phase?: PublishPhase;
  /** ISO time, refreshed every 30 s during uploads and waits. */
  heartbeatAt?: string;
  /** F3 / F10 unpublished photo ids. */
  photoIds?: string[];
  /** F4 "upload:…". */
  uploadSession?: string;
  /** Bytes Meta confirmed. */
  uploadOffset?: number;
  /** F5 "h". */
  fileHandle?: string;
  /** F7 / F11 video id. */
  videoId?: string;
  /** The Instagram or Threads parent container. */
  containerId?: string;
  /** Instagram or Threads carousel children, in media order. */
  children?: string[];
  /** Replaces the old "#n|" error prefix for new rows. */
  attempts?: number;
  /** The failure was an unclear outcome (3.5 last row). */
  unclear?: boolean;
};

/** Where a publisher keeps its progress. save() must have stored the change before it resolves: the next step depends on it. */
export interface ProgressStore {
  /** The progress as last saved (a copy). */
  read(): PostTargetProgress;
  /** Merges `patch` (a key set to undefined is removed) and stores it. Resolves with the new progress. */
  save(patch: PostTargetProgress): Promise<PostTargetProgress>;
}

/** A target whose heartbeat is older than this, in a create or publish phase, is an unclear outcome (3.1). */
export const HEARTBEAT_STALE_MS = 2 * 60_000;
/** How often a long upload or wait refreshes the heartbeat. */
export const HEARTBEAT_EVERY_MS = 30_000;
const MAX_IDS = 20;
const MAX_ID_LENGTH = 200;

const PHASES: readonly PublishPhase[] = ["upload", "create", "publish"];

export function mergeProgress(current: PostTargetProgress, patch: PostTargetProgress): PostTargetProgress {
  const next: Record<string, unknown> = { ...current, ...patch };
  for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key];
  return next as PostTargetProgress;
}

/** A store in memory, for tests and for a run that persists elsewhere. `saves` lists each stored state in order. */
export function memoryProgressStore(initial: PostTargetProgress = {}): ProgressStore & { saves: PostTargetProgress[] } {
  let current = parseProgress(initial);
  const saves: PostTargetProgress[] = [];
  return {
    saves,
    read: () => ({ ...current }),
    async save(patch) {
      current = mergeProgress(current, patch);
      saves.push({ ...current });
      return { ...current };
    },
  };
}

const idList = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.length <= MAX_IDS && v.every((x) => typeof x === "string" && x.length > 0 && x.length <= MAX_ID_LENGTH) ? [...(v as string[])] : undefined;
const id = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH ? v : undefined);
const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);

/** Reads PostTarget.progress from the database (any JSON) and keeps only well-formed known keys. */
export function parseProgress(raw: unknown): PostTargetProgress {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: PostTargetProgress = {
    phase: typeof r.phase === "string" && (PHASES as readonly string[]).includes(r.phase) ? (r.phase as PublishPhase) : undefined,
    heartbeatAt: typeof r.heartbeatAt === "string" && !Number.isNaN(Date.parse(r.heartbeatAt)) ? r.heartbeatAt : undefined,
    photoIds: idList(r.photoIds),
    uploadSession: id(r.uploadSession),
    uploadOffset: count(r.uploadOffset),
    fileHandle: id(r.fileHandle),
    videoId: id(r.videoId),
    containerId: id(r.containerId),
    children: idList(r.children),
    attempts: count(r.attempts),
    unclear: r.unclear === true ? true : undefined,
  };
  return mergeProgress({}, out);
}

/** Records the phase before a step (with a fresh heartbeat), so an interrupted run can tell an upload from a create (3.1). */
export function setPhase(store: ProgressStore, phase: PublishPhase, now: Date = new Date()): Promise<PostTargetProgress> {
  return store.save({ phase, heartbeatAt: now.toISOString() });
}

/** Refreshes the heartbeat during an upload or a wait, at most once every 30 s. Resolves true when it wrote. */
export async function heartbeat(store: ProgressStore, now: Date = new Date(), everyMs = HEARTBEAT_EVERY_MS): Promise<boolean> {
  const last = store.read().heartbeatAt;
  if (last && now.getTime() - Date.parse(last) < everyMs) return false;
  await store.save({ heartbeatAt: now.toISOString() });
  return true;
}

/** True when the heartbeat is missing, unreadable or older than maxAgeMs (2 min). */
export function isStale(heartbeatAt: string | Date | null | undefined, now: Date = new Date(), maxAgeMs = HEARTBEAT_STALE_MS): boolean {
  if (!heartbeatAt) return true;
  const at = heartbeatAt instanceof Date ? heartbeatAt.getTime() : Date.parse(heartbeatAt);
  if (Number.isNaN(at)) return true;
  return now.getTime() - at > maxAgeMs;
}

/**
 * What to do with a target found in "processing" (3.1):
 * - fresh: no step started;
 * - busy: a run is still alive (heartbeat under 2 min): leave it alone;
 * - resume: an upload was interrupted: continue from the stored offset (uploading posts nothing);
 * - unclear: a create or publish step was interrupted: fail it with the "Check first" copy.
 */
export function interruptedState(progress: PostTargetProgress, now: Date = new Date()): "fresh" | "busy" | "resume" | "unclear" {
  if (!progress.phase) return "fresh";
  if (!isStale(progress.heartbeatAt, now)) return "busy";
  return progress.phase === "upload" ? "resume" : "unclear";
}

/** A PublishError from a plain answer: retry and wait are safe to repeat; fail and unclear are not. */
export function publishErrorFrom(plain: PlainError): PublishError {
  return new PublishError(plain.copy, plain.action === "retry" || plain.action === "wait", plain);
}

/** The Deferred for a "wait" answer: the copy is the message the owner reads while the post waits. */
export function deferFor(plain: PlainError): Deferred {
  return { defer: { ms: plain.waitMs ?? QUOTA_RECHECK_MS, message: plain.copy } };
}

/**
 * Today's semantics (publishers.ts): a step that creates the post must never be repeated after an unclear outcome, so on a
 * creating step a 5xx or a connection that may have been sent ends the target as unclear; otherwise a retryable transport error,
 * a 5xx or a lost connection may be retried. Two refinements from 3.5: a connection that never left this host (the transport's
 * ambiguous=false, status 0: refused or not resolved) is safe to retry even on a creating step, because nothing reached Meta; and
 * the copy now comes from errors.ts, which also marks Meta's rate-limit codes (4, 17, 32, 613, 80001, 80002) and its download
 * failures as safe to retry, and a full daily limit as a wait.
 */
export function toPublishError(e: unknown, creates: boolean, ctx: ErrorContext = {}): PublishError {
  if (e instanceof PublishError) return e;
  if (!(e instanceof GraphError)) return new PublishError("The post could not be published.");
  const step = creates ? (ctx.step === "publish" ? "publish" : "create") : ctx.step === "upload" ? "upload" : "read";
  const purpose = ctx.purpose ?? "post";
  if (creates && (e.ambiguous || e.status >= 500)) {
    const plain = { ...unclearOutcome({ ...ctx, purpose }), ref: e.status === 0 ? "network" : `meta:${e.code ?? "none"}` };
    return new PublishError(plain.copy, false, plain);
  }
  const plain = explainMetaError(e, { ...ctx, purpose, step });
  const retry = plain.action === "retry" || plain.action === "wait" || (plain.action !== "unclear" && (e.retryable || e.status >= 500 || e.status === 0));
  return new PublishError(plain.copy, retry, plain);
}
