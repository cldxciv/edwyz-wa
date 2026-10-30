"use client";
import { useEffect, useRef, useState } from "react";
import { pollIntervalFor, reconnectDelayMs, updateMatches, type StreamMode } from "./helpers";
import { usePolling } from "./usePolling";

export type StreamState = { n: number; ids: string[]; mode: StreamMode };

/**
 * Live updates over Server-Sent Events. The mode starts as "connecting" (nothing has failed yet), becomes "sse" when the stream
 * opens and "polling" only when it cannot be kept open.
 */
export function useInboxStream(): StreamState {
  const [state, setState] = useState<StreamState>({ n: 0, ids: [], mode: "connecting" });

  useEffect(() => {
    if (typeof EventSource === "undefined") {
      setState((s) => ({ ...s, mode: "polling" }));
      return;
    }
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let disposed = false;

    const bump = (ids: string[], mode?: StreamState["mode"]) =>
      setState((s) => ({ n: s.n + 1, ids, mode: mode ?? s.mode }));

    function connect() {
      if (disposed) return;
      const es = new EventSource("/api/inbox/stream");
      source = es;
      es.onopen = () => {
        attempt = 0;
        // The server only announces changes made after it accepted the connection, so each open is followed by one full refresh.
        bump([], "sse");
      };
      es.addEventListener("update", (e) => {
        try {
          const data = JSON.parse((e as MessageEvent<string>).data) as { conversationIds?: unknown };
          bump(Array.isArray(data.conversationIds) ? data.conversationIds.filter((x): x is string => typeof x === "string") : []);
        } catch {
          bump([]);
        }
      });
      es.onerror = () => {
        // CONNECTING means the browser is already retrying (for example after the 5 minute server limit).
        if (es.readyState !== EventSource.CLOSED) return;
        es.close();
        setState((s) => ({ ...s, mode: "polling" }));
        retry = setTimeout(connect, reconnectDelayMs(attempt++));
      };
    }

    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      source?.close();
    };
  }, []);

  return state;
}

/** Runs fn on mount, whenever a matching stream update arrives, and on a poll (fast fallback, slow safety net). */
export function useStreamRefresh(fn: () => Promise<void> | void, stream: StreamState, conversationId?: string) {
  const ref = useRef(fn);
  const seen = useRef(stream.n);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    if (stream.n === seen.current) return;
    seen.current = stream.n;
    if (updateMatches(stream.ids, conversationId)) void Promise.resolve(ref.current()).catch(() => undefined);
  }, [stream.n, stream.ids, conversationId]);
  usePolling(fn, pollIntervalFor(stream.mode));
}
