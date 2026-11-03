"use client";

/**
 * usePromoteDraft (docs/IG-PAGE-ADS-SPEC.md 7.2, 7.3 hooks, D28): the draft a Boost or New ad flow edits, saved on the server.
 *
 * - load(id) reads GET /api/promote/drafts/[id]; create(body) makes it with POST /api/promote/drafts (the server fills every
 *   3.1 default).
 * - stage(set) changes the draft on screen at once (optimistic) and keeps the change for the next save; flush() saves what is
 *   staged with PATCH and expectedUpdatedAt (flow-helpers createAutosaver). The flow flushes after every step and on blur.
 * - A 409 replaces the draft with the latest one and says "Someone else changed this draft. Showing the latest." The latest
 *   version is then the saved one ("Saved"), so the next Continue moves on; `conflicts` counts these, so the screens re-seed
 *   from it. A 409 without the latest draft loads it again (and retry() does too). A slow or failed network keeps "Not saved
 *   yet" and tries again (SAVE_RETRY_MS), and retry() saves now.
 * - A save the server refuses puts the screen back to the last saved draft and says why, except the special-category question
 *   (3.1): the change stays on screen until the member answers, and resend({categoryAnswer}) sends it again with the answer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { promoteText } from "@/lib/promote/copy";
import { applyPath, isDraftPath } from "@/lib/promote/draft-paths";
import type { PromoteLang, PromotionDraft } from "@/lib/promote/types";
import { createAutosaver, errorText, isCategoryQuestion, isDraftDto, parseDraft, saveStateText, type Autosaver, type DraftDto, type SaveState, type SendResult } from "./flow-helpers";

const API_PREFIX = "/api/";

/**
 * A JSON request that never throws: the status (0 when the network failed) and the parsed body.
 * Only this site's own /api/ paths are sent: the literal "/api/" prefix keeps every request same-origin (spend bypass rule
 * B12). Any other address is never sent and answers like a failed network.
 */
export async function jsonRequest(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, body?: unknown): Promise<SendResult> {
  if (!url.startsWith(API_PREFIX)) return { status: 0, body: null };
  try {
    const res = await fetch(`/api/${url.slice(API_PREFIX.length)}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  } catch {
    return { status: 0, body: null };
  }
}

/** The draft with a set applied on screen; a value the draft paths refuse is left out (the server would refuse it too). */
export function applyLocal(draft: PromotionDraft, set: Readonly<Record<string, unknown>>): PromotionDraft {
  let next = draft;
  for (const [path, value] of Object.entries(set)) {
    if (!isDraftPath(path)) continue;
    try {
      next = applyPath(next, path, value);
    } catch {
      // A bad value stays out of the view; the save reports it.
    }
  }
  return next;
}

export type CreateResult = { ok: true; dto: DraftDto } | { ok: false; status: number; message: string; body: unknown };

export type PromoteDraftApi = {
  id: string | null;
  dto: DraftDto | null;
  draft: PromotionDraft | null;
  loading: boolean;
  loadError: string | null;
  state: SaveState;
  /** "Saved" or "Not saved yet". */
  stateText: string;
  /** The conflict sentence or a refusal, for the footer's status line. */
  message: string | null;
  /** The body of the last refusal (a special-category question, a goal not offered). */
  refusal: unknown;
  /** How many times someone else's version replaced this one (409): the screens re-seed from the draft when it changes. */
  conflicts: number;
  create: (body: Record<string, unknown>) => Promise<CreateResult>;
  load: (id: string) => Promise<DraftDto | null>;
  replace: (dto: DraftDto) => void;
  stage: (set: Readonly<Record<string, unknown>>) => void;
  flush: () => Promise<SaveState>;
  /** stage then flush. */
  save: (set: Readonly<Record<string, unknown>>) => Promise<SaveState>;
  retry: () => Promise<SaveState>;
  /** Sends the refused change again with an answer ({categoryAnswer}). */
  resend: (extra: Readonly<Record<string, unknown>>) => Promise<SaveState>;
  /** The last refusal's body right now (not the rendered one), and how many refusals there have been, for after an await. */
  refusalNow: () => unknown;
  refusalCount: () => number;
  discard: (id: string) => Promise<boolean>;
  clearMessage: () => void;
};

export function usePromoteDraft(opts: { id: string | null; lang?: PromoteLang }): PromoteDraftApi {
  const lang = opts.lang ?? "en";
  const [dto, setDto] = useState<DraftDto | null>(null);
  const [draft, setDraft] = useState<PromotionDraft | null>(null);
  const [loading, setLoading] = useState<boolean>(!!opts.id);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [state, setState] = useState<SaveState>("saved");
  const [message, setMessage] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<unknown>(null);
  const [conflicts, setConflicts] = useState(0);
  const saver = useRef<Autosaver | null>(null);
  /** Loads the latest draft after a 409 that didn't carry it, keeping the conflict sentence (set once load exists). */
  const reloadRef = useRef<(message: string) => Promise<void>>(async () => {});
  const idRef = useRef<string | null>(opts.id);
  const savedRef = useRef<DraftDto | null>(null);
  const refusalRef = useRef<unknown>(null);
  const refusals = useRef(0);

  const adopt = useCallback((next: DraftDto) => {
    savedRef.current = next;
    setDto(next);
    setDraft(parseDraft(next.draft));
    idRef.current = next.campaignId;
  }, []);

  const startSaver = useCallback(
    (next: DraftDto) => {
      saver.current?.dispose();
      saver.current = createAutosaver({
        updatedAt: next.updatedAt,
        lang,
        send: (body) => jsonRequest("PATCH", `/api/promote/drafts/${encodeURIComponent(next.campaignId)}`, body),
        onSaved: (saved) => {
          // The server's view wins, with anything staged since laid over it.
          savedRef.current = saved;
          setDto(saved);
          const pending = saver.current?.pending() ?? {};
          setDraft(applyLocal(parseDraft(saved.draft), pending));
          setMessage(null);
          setRefusal(null);
          refusalRef.current = null;
        },
        onConflict: (latest, text) => {
          setMessage(text);
          setRefusal(null);
          refusalRef.current = null;
          if (latest) {
            // The latest version is the saved one now (the saver says "saved" next): show it and re-seed the screens.
            adopt(latest);
            setConflicts((n) => n + 1);
          } else void reloadRef.current(text);
        },
        onError: (text, body) => {
          setMessage(text);
          setRefusal(body);
          refusalRef.current = body;
          refusals.current += 1;
          // A value the server won't take leaves the screen as it was saved (with anything staged since); the question keeps
          // the change on screen until it is answered.
          const saved = savedRef.current;
          if (saved && !isCategoryQuestion(body)) setDraft(applyLocal(parseDraft(saved.draft), saver.current?.pending() ?? {}));
        },
        onState: setState,
      });
    },
    [adopt, lang],
  );

  const replace = useCallback(
    (next: DraftDto) => {
      adopt(next);
      startSaver(next);
      setState("saved");
      setMessage(null);
      setRefusal(null);
    },
    [adopt, startSaver],
  );

  const load = useCallback(
    async (id: string): Promise<DraftDto | null> => {
      setLoading(true);
      setLoadError(null);
      const res = await jsonRequest("GET", `/api/promote/drafts/${encodeURIComponent(id)}`);
      setLoading(false);
      if (res.status === 200 && isDraftDto(res.body)) {
        replace(res.body);
        return res.body;
      }
      setLoadError(errorText(res.body, "flow.load_failed", lang));
      return null;
    },
    [lang, replace],
  );

  // After a 409 without the latest draft: load it (a new saver on the latest version) and keep saying what happened. Until it
  // loads the saver stays "conflict", so Continue waits; a failed load leaves [Save now], which loads it again (retry).
  useEffect(() => {
    reloadRef.current = async (text: string) => {
      const id = idRef.current;
      if (!id) return;
      const next = await load(id);
      if (!next) return;
      setConflicts((n) => n + 1);
      setMessage(text);
    };
  }, [load]);

  useEffect(() => {
    if (opts.id && opts.id !== dto?.campaignId) void load(opts.id);
    // Only the id the page opened with: later drafts arrive through create and replace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.id]);

  useEffect(() => () => saver.current?.dispose(), []);

  const create = useCallback(
    async (body: Record<string, unknown>): Promise<CreateResult> => {
      const res = await jsonRequest("POST", "/api/promote/drafts", { lang, ...body });
      if ((res.status === 200 || res.status === 201) && isDraftDto(res.body)) {
        replace(res.body);
        return { ok: true, dto: res.body };
      }
      return { ok: false, status: res.status, message: errorText(res.body, "flow.create_failed", lang), body: res.body };
    },
    [lang, replace],
  );

  const stage = useCallback((set: Readonly<Record<string, unknown>>) => {
    const paths = Object.fromEntries(Object.entries(set).filter(([k]) => isDraftPath(k)));
    if (!Object.keys(paths).length) return;
    setDraft((d) => (d ? applyLocal(d, paths) : d));
    saver.current?.stage(paths);
  }, []);

  const flush = useCallback(async (): Promise<SaveState> => (saver.current ? saver.current.flush() : "saved"), []);
  /** [Save now]: saves what is waiting, or loads the latest draft when a 409 came without it. */
  const retry = useCallback(async (): Promise<SaveState> => {
    if (saver.current?.state() === "conflict") {
      await reloadRef.current(promoteText("draft.conflict", {}, lang));
      return saver.current?.state() ?? "saved";
    }
    return flush();
  }, [flush, lang]);
  const save = useCallback(
    async (set: Readonly<Record<string, unknown>>) => {
      stage(set);
      return flush();
    },
    [flush, stage],
  );

  const discard = useCallback(async (id: string) => {
    const res = await jsonRequest("DELETE", `/api/promote/drafts/${encodeURIComponent(id)}`);
    return res.status === 200;
  }, []);

  const resend = useCallback(async (extra: Readonly<Record<string, unknown>>): Promise<SaveState> => {
    setRefusal(null);
    setMessage(null);
    refusalRef.current = null;
    return saver.current ? saver.current.resend(extra) : "saved";
  }, []);
  const refusalNow = useCallback(() => refusalRef.current, []);
  const refusalCount = useCallback(() => refusals.current, []);

  const clearMessage = useCallback(() => setMessage(null), []);

  return useMemo(
    () => ({
      id: dto?.campaignId ?? idRef.current,
      dto,
      draft,
      loading,
      loadError,
      state,
      stateText: saveStateText(state, lang),
      message,
      refusal,
      conflicts,
      create,
      load,
      replace,
      stage,
      flush,
      save,
      retry,
      resend,
      refusalNow,
      refusalCount,
      discard,
      clearMessage,
    }),
    [dto, draft, loading, loadError, state, lang, message, refusal, conflicts, create, load, replace, stage, flush, save, retry, resend, refusalNow, refusalCount, discard, clearMessage],
  );
}

export default usePromoteDraft;
