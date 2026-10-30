/**
 * The streaming transport of POST /api/eddy/turn (docs/EDDY-SPEC.md 5.12, 7.10, 12.2 risks 10 and 20).
 *
 * - `content-type: text/event-stream`, and `Cache-Control: no-cache, no-store, no-transform`: next.config.ts puts
 *   no-store on every /api response and the Node compression middleware skips a response only when its Cache-Control
 *   holds no-transform, so the route sends all three itself. `X-Accel-Buffering: no` keeps nginx from buffering.
 * - Each event is one SSE frame: `event: <type>` and `data: <json>` (the JSON repeats the type, so a reader that only looks
 *   at data lines works too). A `: ka` comment every 15 s keeps proxies (60 s default timeouts) from cutting a long turn.
 * - A lifetime cap of 150 s: the turn is aborted and the stream closes. `request.signal` is honoured, and so is the reader
 *   going away: both abort the turn, which then repairs its tail and stops.
 * The client reads it with fetch and a ReadableStream reader, not EventSource (5.12).
 */
import { EDDY_DEFAULTS, type EddyEvent } from "./contract";

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-store, no-transform",
  "x-accel-buffering": "no",
  connection: "keep-alive",
};

export const KEEPALIVE_FRAME = ": ka\n\n";

/** One SSE frame for an event. */
export function sseFrame(event: EddyEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Parses a stream of SSE frames back into events (tests, and any server-side reader). Comments are skipped. */
export function parseSseFrames(text: string): EddyEvent[] {
  const out: EddyEvent[] = [];
  for (const frame of text.split("\n\n")) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .join("\n");
    if (data) out.push(JSON.parse(data) as EddyEvent);
  }
  return out;
}

export type SseOptions = {
  /** request.signal: the browser went away, the tab closed, or Stop was tapped. */
  signal?: AbortSignal;
  heartbeatMs?: number;
  lifetimeMs?: number;
  /** Called once when the stream ends for any reason. */
  onClose?: () => void;
};

export type SseRun = (emit: (e: EddyEvent) => void, signal: AbortSignal) => Promise<void>;

/**
 * A streaming Response that runs `run` with an emit function and an abort signal that fires on request.signal, on the
 * reader cancelling, and after the 150 s lifetime. Events emitted after the stream closed are dropped.
 */
export function sseResponse(run: SseRun, o: SseOptions = {}): Response {
  const encoder = new TextEncoder();
  const heartbeatMs = o.heartbeatMs ?? EDDY_DEFAULTS.heartbeatMs;
  const lifetimeMs = o.lifetimeMs ?? EDDY_DEFAULTS.streamLifetimeMs;
  const abort = new AbortController();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let lifetime: ReturnType<typeof setTimeout> | null = null;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const cleanup = () => {
    if (heartbeat) clearInterval(heartbeat);
    if (lifetime) clearTimeout(lifetime);
    heartbeat = null;
    lifetime = null;
    o.signal?.removeEventListener("abort", onRequestAbort);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    cleanup();
    try {
      controllerRef?.close();
    } catch {
      // Already closed or errored by the reader.
    }
    o.onClose?.();
  };
  const write = (chunk: string) => {
    if (closed || !controllerRef) return;
    try {
      controllerRef.enqueue(encoder.encode(chunk));
    } catch {
      closed = true;
      cleanup();
      abort.abort();
    }
  };
  function onRequestAbort() {
    abort.abort();
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (o.signal?.aborted) abort.abort();
      else o.signal?.addEventListener("abort", onRequestAbort, { once: true });
      heartbeat = setInterval(() => write(KEEPALIVE_FRAME), heartbeatMs);
      lifetime = setTimeout(() => abort.abort(), lifetimeMs);
      void (async () => {
        try {
          await run((e) => write(sseFrame(e)), abort.signal);
        } catch {
          write(sseFrame({ type: "error", state: "internal" }));
        } finally {
          close();
        }
      })();
    },
    cancel() {
      // The reader went away: stop the turn.
      abort.abort();
      closed = true;
      cleanup();
      o.onClose?.();
    },
  });

  return new Response(stream, { status: 200, headers: { ...SSE_HEADERS } });
}
