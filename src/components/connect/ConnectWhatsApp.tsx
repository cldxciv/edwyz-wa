"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, Button, ProgressBar, Skeleton, StatusPill, cn, confirm, toast } from "@/components/ui";
import { GRAPH_API_VERSION } from "@/lib/config";
import {
  PAYMENT_URL,
  POPUP_SCREENS,
  PREPARE_CHECKLIST,
  STAGES,
  classifyFailure,
  currentStage,
  describeCancelStep,
  failedStepTitle,
  liveAnnouncement,
  mergeSteps,
  setupProgress,
  stageState,
  stepPill,
  type FlowView,
  type StageNumber,
  type StageState,
  type StepState,
} from "./helpers";
import { createLoginPreloader, loginOptions, type StartInfo } from "./login";
import { tokenBannerContent, type TokenView } from "./token-banner";

type SignupMessage = {
  type?: string;
  event?: string;
  data?: { waba_id?: string; phone_number_id?: string; current_step?: string; error_message?: string };
};
type FBLoginResponse = { authResponse?: { code?: string } | null };
type FBSdk = {
  init: (options: Record<string, unknown>) => void;
  login: (callback: (response: FBLoginResponse) => void, options: Record<string, unknown>) => void;
};
declare global {
  interface Window {
    FB?: FBSdk;
    fbAsyncInit?: () => void;
  }
}

type Detail = { message?: string; cancelledAt?: string | null; steps: StepState[]; fresh?: boolean; previousFailure?: string | null };

const FINISH_EVENTS = ["FINISH", "FINISH_ONLY_WABA", "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", "FINISH_OBO_MIGRATION", "FINISH_GRANT_ONLY_API_ACCESS"];
const isFacebookOrigin = (origin: string) => {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && (url.hostname === "facebook.com" || url.hostname.endsWith(".facebook.com"));
  } catch {
    return false;
  }
};

function loadSdk(appId: string): Promise<FBSdk> {
  return new Promise((resolve, reject) => {
    const ready = () => {
      window.FB?.init({ appId, autoLogAppEvents: true, xfbml: false, version: GRAPH_API_VERSION });
      if (window.FB) resolve(window.FB);
      else reject(new Error("sdk"));
    };
    if (window.FB) return ready();
    window.fbAsyncInit = ready;
    const script = document.createElement("script");
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.onerror = () => reject(new Error("sdk"));
    document.body.appendChild(script);
  });
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? "Something went wrong.");
  return json;
}

function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function Marker({ n, state }: { n: number; state: StageState }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-sm font-semibold",
        state === "done" && "border-accent bg-accent text-on-accent",
        state === "current" && "border-accent bg-accent-soft text-accent-ink",
        state === "failed" && "border-bad bg-bad-soft text-bad-fg",
        state === "upcoming" && "border-border-strong bg-raised text-muted",
      )}
    >
      {state === "done" ? <Check /> : state === "failed" ? "!" : n}
    </span>
  );
}

function PopupGuide() {
  return (
    <ol className="mt-2 space-y-3">
      {POPUP_SCREENS.map((s, i) => (
        <li key={s.title} className="flex gap-3 text-sm">
          <span aria-hidden className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-muted">
            {i + 1}
          </span>
          <span>
            <span className="block font-medium">{s.title}</span>
            <span className="block text-muted">{s.text}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Moves keyboard focus to its content when it appears, so a keyboard or screen reader user lands on the result of what they just did. */
function FocusTarget({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div ref={ref} tabIndex={-1} role="group" aria-label={label} className="rounded-lg">
      {children}
    </div>
  );
}

function FailureAlert({
  message,
  stage,
  stoppedAt,
  onRetry,
  busy,
  reconnecting,
}: {
  message: string;
  stage: 2 | 3;
  stoppedAt: string | null;
  onRetry: () => void;
  busy: boolean;
  reconnecting?: boolean;
}) {
  const f = classifyFailure(message, stage);
  const title = reconnecting ? "Reconnecting did not finish" : f.title;
  return (
    <FocusTarget label={title}>
      <Alert tone={reconnecting ? "warn" : "bad"} title={title}>
        {reconnecting && <p className="mt-1 font-medium">Your current connection still works.</p>}
        {reconnecting && <p className="mt-1">{f.title}.</p>}
        <p className="mt-1 font-medium">What to check</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {f.causes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        {stage === 3 && stoppedAt && (
          <p className="mt-2">
            It stopped at: {stoppedAt}.{f.resumes ? " Nothing is lost. When you try again, we carry on from the step that stopped." : ""}
          </p>
        )}
        <details className="mt-2">
          <summary className="min-h-8 cursor-pointer py-1 font-medium">Details</summary>
          <p className="break-words">{message}</p>
        </details>
        <Button className="mt-3" onClick={onRetry} loading={busy}>
          Try again
        </Button>
      </Alert>
    </FocusTarget>
  );
}

function SetupProgress({ reported }: { reported: StepState[] }) {
  const steps = useMemo(() => {
    const merged = mergeSteps(reported);
    return reported.length === 0 ? merged.map((s, i) => (i === 0 ? { ...s, status: "started" as const } : s)) : merged;
  }, [reported]);
  return (
    <div className="mt-3">
      <ProgressBar label="Setup progress" showLabel showValue value={setupProgress(steps)} />
      <p className="mt-2 text-sm text-muted">Keep this tab open. It usually takes less than a minute.</p>
      <ol className="mt-3 space-y-3">
        {steps.map((s) => {
          const pill = stepPill(s.status);
          return (
            <li key={s.step}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">{s.title}</p>
                <StatusPill status={pill.status} label={pill.label} />
              </div>
              <p className="mt-0.5 text-sm text-muted">{s.text}</p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Stage({ n, state, headingRef, children }: { n: StageNumber; state: StageState; headingRef: (el: HTMLHeadingElement | null) => void; children?: ReactNode }) {
  const info = STAGES[n - 1];
  return (
    <li aria-current={state === "current" || state === "failed" ? "step" : undefined} className="relative flex gap-4 pb-6 last:pb-0">
      <div className="flex flex-col items-center">
        <Marker n={n} state={state} />
        {n < STAGES.length && <span aria-hidden className="mt-1 w-px flex-1 bg-border" />}
      </div>
      <div className="min-w-0 flex-1 pb-1">
        <div className="flex flex-wrap items-center justify-between gap-x-3">
          <h3 ref={headingRef} tabIndex={-1} className={cn("text-base font-semibold", state === "upcoming" && "text-muted")}>
            {info.title}
          </h3>
          <span className="text-xs text-muted">
            {state === "done" ? "Done" : state === "failed" ? "Needs attention" : `${info.time}${state === "current" ? " - you are here" : ""}`}
          </span>
        </div>
        {state === "done" && <span className="sr-only">Completed.</span>}
        {children}
      </div>
    </li>
  );
}

export function ConnectWhatsApp() {
  const [view, setView] = useState<FlowView>({ name: "loading" });
  const [detail, setDetail] = useState<Detail>({ steps: [] });
  const signup = useRef<{ wabaId?: string; phoneNumberId?: string; cancelledAt?: string | null; error?: string; event?: string }>({});
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const alive = useRef(true);
  const wasConnected = useRef(false);
  const [token, setToken] = useState<TokenView | null>(null);
  const [reconnectIssue, setReconnectIssue] = useState<{ message: string; stage: 2 | 3 } | null>(null);
  const stageHeadings = useRef<Partial<Record<number, HTMLHeadingElement | null>>>({});
  const previousView = useRef<FlowView["name"]>("loading");

  const stopPolling = useCallback(() => {
    if (poll.current) clearInterval(poll.current);
    poll.current = null;
  }, []);

  useEffect(() => {
    alive.current = true;
    api<{ status: string; steps: StepState[]; token?: TokenView }>("/api/onboarding/status")
      .then((s) => {
        if (!alive.current) return;
        setToken(s.token ?? null);
        if (s.status === "live") {
          wasConnected.current = true;
          setView({ name: "connected" });
          return;
        }
        setDetail({ steps: s.steps, previousFailure: s.status === "failed" ? (failedStepTitle(s.steps) ?? "an earlier attempt") : null });
        setView({ name: "idle" });
      })
      .catch(() => alive.current && setView({ name: "idle" }));
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!isFacebookOrigin(event.origin)) return;
      let data: SignupMessage;
      try {
        data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (data?.type !== "WA_EMBEDDED_SIGNUP") return;
      if (data.event && FINISH_EVENTS.includes(data.event)) {
        signup.current.event = data.event;
        signup.current.wabaId = data.data?.waba_id;
        signup.current.phoneNumberId = data.data?.phone_number_id;
      } else if (data.event === "CANCEL") {
        signup.current.cancelledAt = data.data?.current_step ?? null;
        signup.current.error = data.data?.error_message;
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      stopPolling();
    };
  }, [stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    poll.current = setInterval(async () => {
      try {
        const { steps } = await api<{ steps: StepState[] }>("/api/onboarding/status");
        if (alive.current) setDetail((d) => ({ ...d, steps }));
      } catch {
        // the final response from /complete decides the outcome
      }
    }, 1500);
  }, [stopPolling]);

  const fail = useCallback((message: string, stage: 2 | 3) => {
    if (wasConnected.current) {
      setReconnectIssue({ message, stage });
      setView({ name: "connected" });
      return;
    }
    setDetail((d) => ({ ...d, message }));
    setView({ name: "error", stage });
  }, []);

  const finish = useCallback(
    async (code: string, state: string) => {
      for (let i = 0; i < 20 && !signup.current.wabaId; i++) await new Promise((r) => setTimeout(r, 150));
      if (!alive.current) return;
      const { wabaId, phoneNumberId } = signup.current;
      if (!wabaId || !phoneNumberId) {
        fail("Meta did not return your WhatsApp account details. Please try again.", 2);
        return;
      }
      setDetail((d) => ({ ...d, steps: [] }));
      setView({ name: "connecting" });
      startPolling();
      try {
        await api("/api/onboarding/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, wabaId, phoneNumberId, state, flow: signup.current.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" ? "coexistence" : "standard" }),
        });
        if (!alive.current) return;
        wasConnected.current = true;
        setToken(null);
        setDetail((d) => ({ ...d, fresh: true }));
        setView({ name: "connected" });
        toast.success("WhatsApp is connected");
      } catch (e) {
        stopPolling();
        const latest = await api<{ steps: StepState[] }>("/api/onboarding/status").catch(() => null);
        if (!alive.current) return;
        if (latest) setDetail((d) => ({ ...d, steps: latest.steps }));
        fail(e instanceof Error ? e.message : "Something went wrong.", 3);
      } finally {
        stopPolling();
      }
    },
    [fail, startPolling, stopPolling],
  );

  // The SDK and the signup state are fetched ahead of the click so FB.login can run synchronously inside the click handler
  // (popup blockers only allow a window opened straight from a user gesture). A state is single use, so each one is taken once.
  const preloader = useMemo(() => createLoginPreloader<FBSdk>({ fetchStart: () => api<StartInfo>("/api/onboarding/start"), loadSdk }), []);

  useEffect(() => {
    if (view.name === "idle" || view.name === "connected" || view.name === "cancelled" || view.name === "error") void preloader.prepare();
  }, [preloader, view.name]);

  const connect = useCallback(() => {
    const before = wasConnected.current;
    signup.current = {};
    setDetail((d) => ({ ...d, message: undefined, cancelledAt: null, fresh: false }));
    setReconnectIssue(null);
    setView({ name: "waiting" });

    const launch = (fb: FBSdk, { configId, state }: StartInfo) =>
      fb.login((response) => {
        if (!alive.current) return;
        const code = response.authResponse?.code;
        if (code) {
          void finish(code, state);
        } else if (signup.current.error) {
          fail(signup.current.error, 2);
        } else if (before) {
          setView({ name: "connected" });
          toast.info("Reconnecting was canceled. Your connection is unchanged.");
        } else {
          setDetail((d) => ({ ...d, cancelledAt: signup.current.cancelledAt ?? null }));
          setView({ name: "cancelled" });
        }
      }, loginOptions(configId));

    const failed = (e: unknown) => {
      if (!alive.current) return;
      fail(e instanceof Error && e.message !== "sdk" ? e.message : "Could not load the Facebook sign-in. Check your connection or ad blocker and try again.", 2);
    };

    // Fast path: nothing is awaited before FB.login, so the click's user activation is still intact.
    const ready = preloader.take();
    if (ready) {
      try {
        launch(ready.sdk, ready.info);
      } catch (e) {
        failed(e);
      }
      void preloader.prepare();
      return;
    }
    // Fallback (first click before the preload finished, or a stale state): fetch and load, then open the window.
    preloader
      .load()
      .then(({ info, sdk }) => {
        if (alive.current) launch(sdk, info);
      })
      .catch(failed);
  }, [fail, finish, preloader]);

  async function reconnect() {
    const ok = await confirm({
      title: "Connect WhatsApp again?",
      body: "You will go through the Facebook window again. Use this if messages stopped arriving or you want to use a different number.",
      confirmLabel: "Connect again",
    });
    if (ok) void connect();
  }

  useEffect(() => {
    const before = previousView.current;
    previousView.current = view.name;
    if (before === "loading" || before === view.name) return;
    if (view.name === "cancelled" || view.name === "error") return;
    if (view.name === "connected" && reconnectIssue) return;
    stageHeadings.current[currentStage(view)]?.focus();
  }, [view, reconnectIssue]);

  const headingRef = (n: StageNumber) => (el: HTMLHeadingElement | null) => {
    stageHeadings.current[n] = el;
  };

  const busy = view.name === "waiting" || view.name === "connecting";
  const tokenNotice = tokenBannerContent(token ? { ...token, canReconnect: true } : null);
  const now = currentStage(view);
  const cancelledAt = describeCancelStep(detail.cancelledAt);

  if (view.name === "loading") {
    return (
      <section aria-busy="true" aria-labelledby="connect-heading" className="rounded-card border border-border bg-raised p-5 shadow-raised">
        <h2 id="connect-heading" className="text-lg font-semibold">
          Connect your WhatsApp number
        </h2>
        <div className="mt-4 space-y-4">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-8 w-1/2" />
        </div>
        <span role="status" className="sr-only">
          Checking your connection
        </span>
      </section>
    );
  }

  return (
    <section aria-labelledby="connect-heading" className="rounded-card border border-border bg-raised p-5 shadow-raised">
      <h2 id="connect-heading" className="text-lg font-semibold">
        Connect your WhatsApp number
      </h2>
      <p className="mt-1 text-sm text-muted">Four short steps, about 5 minutes. You sign in inside Facebook&apos;s own window, so we never see your Facebook password.</p>
      <p role="status" aria-live="polite" className="sr-only">
        {liveAnnouncement(view, detail.steps, !!detail.fresh)}
      </p>

      <ol className="mt-6">
        <Stage n={1} state={stageState(1, view)} headingRef={headingRef(1)}>
          {now === 1 && (
            <div className="mt-2 space-y-4">
              {detail.previousFailure && (
                <Alert tone="warn" title="Your last attempt did not finish">
                  It stopped at &quot;{detail.previousFailure}&quot;. Nothing is lost. If you connect again, we carry on from there.
                </Alert>
              )}
              <div>
                <p className="text-sm font-medium">Have these ready</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted">
                  {PREPARE_CHECKLIST.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
              <details className="rounded-control border border-border bg-surface px-3">
                <summary className="min-h-10 cursor-pointer py-2.5 text-sm font-medium">What will Facebook ask me?</summary>
                <div className="pb-3">
                  <p className="text-sm text-muted">You may not see every screen. Meta skips the ones your account has already done.</p>
                  <PopupGuide />
                </div>
              </details>
              <Button size="lg" onClick={() => void connect()} loading={busy}>
                Connect WhatsApp
              </Button>
            </div>
          )}
        </Stage>

        <Stage n={2} state={stageState(2, view)} headingRef={headingRef(2)}>
          {view.name === "waiting" && (
            <div className="mt-2 space-y-3">
              <p className="text-sm">
                <strong className="font-semibold">Continue in the Facebook window.</strong> It opens in a new window on top of this page. Here is what it will ask:
              </p>
              <PopupGuide />
              <Alert tone="info">
                No window? Your browser may have blocked the pop-up. Allow pop-ups for this site, then select Try again.
                <span className="mt-2 block">
                  <Button size="sm" variant="secondary" className="max-sm:min-h-10" onClick={() => void connect()}>
                    Try again
                  </Button>
                </span>
              </Alert>
            </div>
          )}
          {view.name === "cancelled" && (
            <div className="mt-2 space-y-3">
              <FocusTarget label="The Facebook window was closed">
                <Alert tone="info" title="The Facebook window was closed">
                  You stopped {cancelledAt ? `while ${cancelledAt}` : "before the end"}. No changes were made, so you can start again whenever you like.
                </Alert>
              </FocusTarget>
              <Button onClick={() => void connect()}>Try again</Button>
            </div>
          )}
          {view.name === "error" && view.stage === 2 && detail.message && (
            <div className="mt-2">
              <FailureAlert message={detail.message} stage={2} stoppedAt={null} onRetry={() => void connect()} busy={false} />
            </div>
          )}
          {now > 2 && <p className="mt-1 text-sm text-muted">You signed in and chose your WhatsApp account.</p>}
        </Stage>

        <Stage n={3} state={stageState(3, view)} headingRef={headingRef(3)}>
          {view.name === "connecting" && <SetupProgress reported={detail.steps} />}
          {view.name === "error" && view.stage === 3 && detail.message && (
            <div className="mt-2 space-y-3">
              <FailureAlert message={detail.message} stage={3} stoppedAt={failedStepTitle(detail.steps)} onRetry={() => void connect()} busy={false} />
            </div>
          )}
          {now > 3 && <p className="mt-1 text-sm text-muted">Your number is registered and messages now arrive in your inbox.</p>}
          {now < 3 && <p className="mt-1 text-sm text-muted">Automatic. We link your account and switch the number on. Takes under a minute.</p>}
        </Stage>

        <Stage n={4} state={stageState(4, view)} headingRef={headingRef(4)}>
          {now === 4 ? (
            <div className="mt-2 space-y-4">
              {!reconnectIssue && !detail.fresh && tokenNotice && (
                <Alert tone={tokenNotice.tone} title={tokenNotice.tone === "bad" ? "Your WhatsApp connection needs to be renewed" : "Your WhatsApp connection will expire soon"}>
                  <p>{tokenNotice.text}</p>
                  <Button className="mt-3" onClick={() => void connect()} loading={busy}>
                    Reconnect now
                  </Button>
                </Alert>
              )}
              {reconnectIssue && <FailureAlert message={reconnectIssue.message} stage={reconnectIssue.stage} stoppedAt={null} onRetry={() => void connect()} busy={false} reconnecting />}
              <Alert tone="good" title={detail.fresh ? "WhatsApp is connected" : "Your WhatsApp number is connected"}>
                One thing is left, and it happens on Meta&apos;s side.
              </Alert>
              <p className="text-sm text-muted">
                Meta charges for messages directly, so it needs a payment method on your WhatsApp account before you can message customers. You add it in Meta&apos;s own tool, WhatsApp Manager, not in Edwyz. We cannot see whether you have done it.
              </p>
              <div className="flex flex-wrap gap-2">
                <a
                  href={PAYMENT_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-on-accent shadow-raised transition-colors duration-(--dur-fast) hover:bg-accent-strong"
                >
                  Open WhatsApp Manager
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
                <Link
                  href="/app/templates"
                  className="inline-flex min-h-10 items-center justify-center rounded-full border border-border-strong bg-raised px-5 text-sm font-semibold shadow-raised transition-colors duration-(--dur-fast) hover:bg-surface-2"
                >
                  Go to templates
                </Link>
              </div>
              <details className="rounded-control border border-border bg-surface px-3">
                <summary className="min-h-10 cursor-pointer py-2.5 text-sm font-medium">Good to know before your first message</summary>
                <ul className="list-disc space-y-1 pb-3 pl-5 text-sm text-muted">
                  <li>New businesses can start conversations with up to 250 people in 24 hours. Meta raises this as your messages get good feedback.</li>
                  <li>You can reply freely for 24 hours after a customer writes to you. After that, only approved templates can be sent.</li>
                  <li>Send marketing messages only to people who agreed to receive them.</li>
                </ul>
              </details>
              <details className="rounded-control border border-border bg-surface px-3">
                <summary className="min-h-10 cursor-pointer py-2.5 text-sm font-medium">Connect again or use a different number</summary>
                <div className="space-y-2 pb-3">
                  <p className="text-sm text-muted">Use this if messages stopped arriving or you changed your number.</p>
                  <Button variant="secondary" onClick={() => void reconnect()}>
                    Connect WhatsApp again
                  </Button>
                </div>
              </details>
            </div>
          ) : (
            <p className="mt-1 text-sm text-muted">Meta needs a payment method on your WhatsApp account before you can message customers. We will show you where.</p>
          )}
        </Stage>
      </ol>
    </section>
  );
}
