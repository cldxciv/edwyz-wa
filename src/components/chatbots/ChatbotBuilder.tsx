"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Alert, Badge, Button, Card, EmptyState, ErrorState, FormField, Input, KeyboardKey, Select, Skeleton, StatusPill, Tabs, Tooltip, apiFetch, confirm, tabIds, toast, type TabItem } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { canManage, useApi, useRole } from "@/components/contacts/hooks";
import { addKeywords, humanError, publishFailure } from "@/components/automation/helpers";
import { CANVAS_ID, Canvas } from "./Canvas";
import { BotSettings, type BotOptions } from "./BotSettings";
import { INSPECTOR_HEADING_ID, Inspector, type MemberOption, type TemplateOption } from "./Inspector";
import { SessionsPanel } from "./SessionsPanel";
import { PreviewPanel } from "./PreviewPanel";
import { StarterGallery } from "./StarterGallery";
import { GROUPS, NODE_META, describeStep, handlesOf } from "./catalog";
import { TRIGGER_HELP, TRIGGER_LABEL, docFromChatbot, docToPayload, hasUnpublishedChanges, isDirty, newDoc, unwrapChatbot, type Doc } from "./editor";
import { addNode, connect, duplicateNode, moveNode, nodeById, reconnectEdge, removeEdge, removeNode, restoreNode, setStart, snapshotNode, updateNode, type DeletedStep } from "./flow";
import { canRedo, canUndo, commit, createHistory, endBatch, redo, undo, type History } from "./history";
import { NODE_W, autoLayout, freeSpot, nodeHeight } from "./layout";
import { getStarter, starterDoc, type Starter } from "./starters";
import { COMPACT_QUERY, WIDE_QUERY, matches, useMediaQuery } from "./useMedia";
import { hasErrors, serverIssuesOf, validateFlowIssues, validateTrigger, validateTriggerConflicts, type Issue } from "./validation";
import { fitView, reveal, screenToCanvas, zoomAt, type View } from "./viewport";
import { NODE_TYPES, type Chatbot, type ChatbotSummary, type FlowDefinition, type FlowNode, type NodeType, type Point, type TriggerType } from "./types";

type Tab = "step" | "settings" | "checks" | "preview" | "sessions";

const touch = "max-sm:min-h-10";
const ID_PREFIX = "cb";
const ADD_STEP_ID = "cb-add-step";


function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export function ChatbotBuilder({ id, starter }: { id?: string; starter?: string }) {
  const router = useRouter();
  const role = useRole();
  const editable = canManage(role);
  const remote = useApi<unknown>(id ? `/api/chatbots/${id}` : null);
  const templates = useApi<{ templates: TemplateOption[] }>("/api/templates");
  const members = useApi<{ members: MemberOption[] }>("/api/workspace/members");
  const options = useApi<BotOptions>("/api/chatbots/options");
  // The other chatbots, so Checks can warn when a published one already starts on the same trigger.
  const siblings = useApi<{ chatbots: ChatbotSummary[] }>("/api/chatbots");

  const initialStarter = !id ? getStarter(starter) : undefined;
  const [meta, setMeta] = useState<Chatbot | null>(null);
  const [hist, setHist] = useState<History<Doc>>(() => createHistory(initialStarter ? starterDoc(initialStarter) : newDoc()));
  const [saved, setSaved] = useState<Doc>(() => newDoc());
  const [ready, setReady] = useState(!id);
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("settings");
  const [busy, setBusy] = useState<"save" | "publish" | null>(null);
  const [keywordText, setKeywordText] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [skipGallery, setSkipGallery] = useState(false);
  const [starterName, setStarterName] = useState<string | null>(initialStarter?.name ?? null);
  const [attempted, setAttempted] = useState(false);
  const [announce, setAnnounce] = useState("");
  const size = useRef({ w: 800, h: 500 });
  const fitted = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const keywordRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<(() => void) | null>(null);
  const deleteToast = useRef<string | null>(null);
  const flip = useRef(false);
  const compact = useMediaQuery(COMPACT_QUERY);

  const present = hist.present;
  // Words typed in the settings box but not added yet still count: they are added when the box loses focus, and when saving or publishing.
  const doc = useMemo<Doc>(
    () => (present.triggerType === "keyword" && keywordText.trim() ? { ...present, triggerKeywords: addKeywords(present.triggerKeywords, keywordText) } : present),
    [present, keywordText],
  );
  const flow = doc.flow;
  const dirty = isDirty(saved, doc);
  // Problems the server found when publishing; they go away with the next edit.
  const [serverIssues, setServerIssues] = useState<{ doc: Doc; list: Issue[] } | null>(null);
  const otherBots = siblings.data?.chatbots;
  const issues = useMemo(
    () => [
      ...validateTrigger(doc.triggerType, doc.triggerKeywords, doc.name),
      ...validateTriggerConflicts(doc, id, otherBots ?? []),
      ...validateFlowIssues(flow),
      ...(serverIssues?.doc === doc ? serverIssues.list : []),
    ],
    [doc, id, otherBots, flow, serverIssues],
  );
  const blocked = hasErrors(issues);
  const badNodes = useMemo(() => new Set(issues.filter((i) => i.severity === "error" && i.nodeId).map((i) => i.nodeId as string)), [issues]);
  const warnNodes = useMemo(() => new Set(issues.filter((i) => i.severity === "warning" && i.nodeId).map((i) => i.nodeId as string)), [issues]);
  const selected = nodeById(flow, selectedId);

  const dismissDeleteToast = useCallback(() => {
    if (deleteToast.current) toast.dismiss(deleteToast.current);
    deleteToast.current = null;
  }, []);
  // Any new edit makes an old "Undo" on the deleted-step message unsafe, so the message goes away with it.
  const apply = useCallback(
    (fn: (d: Doc) => Doc, key: string | null = null) => {
      dismissDeleteToast();
      setHist((h) => commit(h, fn(h.present), key));
    },
    [dismissDeleteToast],
  );
  const applyFlow = useCallback((fn: (f: FlowDefinition) => FlowDefinition, key: string | null = null) => apply((d) => ({ ...d, flow: fn(d.flow) }), key), [apply]);

  useEffect(() => {
    if (!id || !remote.data) return;
    const c = unwrapChatbot<Chatbot>(remote.data);
    setMeta(c);
    const d = docFromChatbot(c);
    setSaved(d);
    setHist((h) => (ready ? h : createHistory(d)));
    setReady(true);
  }, [id, remote.data, ready]);

  useEffect(() => {
    if (!ready || fitted.current) return;
    fitted.current = true;
    setView(fitView(flow, size.current.w, size.current.h));
  }, [ready, flow]);

  // Runs after every render: moves the keyboard focus to where the last action left it, because the control that was used is often gone.
  useEffect(() => {
    const run = pendingFocus.current;
    if (!run) return;
    pendingFocus.current = null;
    run();
  });

  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  const guardPushed = useRef(false);
  const leaving = useRef(false);

  const askToLeave = useCallback(
    () =>
      confirm({
        title: "Leave without saving?",
        body: "Your changes to this chatbot have not been saved. If you leave now they are lost.",
        confirmLabel: "Leave without saving",
        cancelLabel: "Keep editing",
        tone: "danger",
      }),
    [],
  );

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    // Links inside the app do not unload the page, so ask before following one.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
      let url: URL;
      try {
        url = new URL(link.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      void askToLeave().then((ok) => {
        if (ok) router.push(`${url.pathname}${url.search}${url.hash}`);
      });
    };
    document.addEventListener("click", onClick, true);
    // The browser Back button: put one extra history entry in front so Back lands on this page, where we can ask first.
    if (!guardPushed.current) {
      window.history.pushState(window.history.state, "", window.location.href);
      guardPushed.current = true;
    }
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, askToLeave, router]);

  useEffect(() => {
    const onPop = () => {
      if (!guardPushed.current || leaving.current) return;
      if (!dirtyRef.current) {
        guardPushed.current = false;
        window.history.back();
        return;
      }
      window.history.pushState(window.history.state, "", window.location.href);
      void askToLeave().then((ok) => {
        if (!ok) return;
        leaving.current = true;
        guardPushed.current = false;
        window.history.go(-2);
      });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [askToLeave]);

  function say(text: string) {
    flip.current = !flip.current;
    setAnnounce(flip.current ? text : `${text}\u00a0`);
  }

  const focusById = (id: string) => () => document.getElementById(id)?.focus();
  const focusCanvas = focusById(CANVAS_ID);

  /** After the Step tab is showing the chosen step: on a phone or tablet scroll to the panel, then focus the step's heading. */
  function showInspector() {
    pendingFocus.current = () => {
      const heading = document.getElementById(INSPECTOR_HEADING_ID);
      if (!matches(WIDE_QUERY)) {
        panelRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
        heading?.focus({ preventScroll: true });
      } else heading?.focus();
    };
  }

  function showPanel(next: Tab) {
    setTab(next);
    pendingFocus.current = focusById(tabIds(ID_PREFIX, next).panel);
  }

  function fit(f: FlowDefinition = flow) {
    setView(fitView(f, size.current.w, size.current.h));
  }

  function addStep(type: NodeType) {
    if (!editable) return;
    const center = screenToCanvas(view, size.current.w / 2, size.current.h / 2);
    const n = flow.nodes.length % 6;
    const want: Point = { x: Math.round(center.x - NODE_W / 2 + n * 24), y: Math.round(center.y - 40 + n * 24) };
    const r = addNode(flow, type, want);
    if (!r.id) {
      toast.error("A chatbot can have at most 100 steps. Remove one to add another.");
      return;
    }
    const newId = r.id;
    // Never on top of another step: move it below the ones in the way, then pan so it is in view.
    const height = nodeHeight(nodeById(r.flow, newId) as FlowNode);
    const pos = freeSpot(flow, want, height);
    let next = moveNode(r.flow, newId, pos);
    setView((v) => reveal(v, { x: pos.x, y: pos.y, w: NODE_W, h: height }, size.current.w, size.current.h));
    const from = selected;
    if (from) {
      const free = handlesOf(from).find((h) => !next.edges.some((e) => e.from === from.id && e.label === h.label));
      if (free) next = connect(next, from.id, free.label, newId);
    }
    applyFlow(() => next);
    setSelectedId(newId);
    setSelectedEdge(null);
    setTab("step");
    showInspector();
    say(`Added ${NODE_META[type].label}. Its settings are open in the Step tab.`);
  }

  function removeSelected(nodeId: string) {
    const snapshot = snapshotNode(flow, nodeId);
    if (!snapshot) return;
    const node = snapshot.node;
    applyFlow((f) => removeNode(f, nodeId));
    setSelectedId(null);
    setSelectedEdge(null);
    pendingFocus.current = focusCanvas;
    deleteToast.current = toast.info(`${NODE_META[node.type].label} deleted.`, { action: { label: "Undo", onAction: () => restoreStep(snapshot) } });
  }

  /** Puts back the step that was deleted, with its connections, whatever else was edited since. */
  function restoreStep(d: DeletedStep) {
    applyFlow((f) => restoreNode(f, d));
    setSelectedId(d.node.id);
    setTab("step");
    showInspector();
    say("Step restored.");
  }

  function stepHistory(fn: typeof undo) {
    dismissDeleteToast();
    setHist((h) => fn(h));
  }

  function duplicateSelected(nodeId: string) {
    const r = duplicateNode(flow, nodeId);
    if (!r.id) {
      toast.error("A chatbot can have at most 100 steps. Remove one to add another.");
      return;
    }
    applyFlow(() => r.flow);
    setSelectedId(r.id);
    showInspector();
    say("Step copied. The copy is open in the Step tab.");
  }

  function applyStarter(s: Starter) {
    const d = starterDoc(s);
    apply(() => d);
    setSelectedId(null);
    setSelectedEdge(null);
    setStarterName(s.name);
    setTab("settings");
    setView(fitView(d.flow, size.current.w, size.current.h));
    pendingFocus.current = focusCanvas;
    say(`${s.name} template added with ${d.flow.nodes.length} steps.`);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (editable) void save();
    } else if (!typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      stepHistory(e.shiftKey ? redo : undo);
    } else if (!typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      stepHistory(redo);
    }
  }

  function commitKeywords() {
    if (doc.triggerType !== "keyword" || !keywordText.trim()) return;
    const text = keywordText;
    apply((d) => ({ ...d, triggerKeywords: addKeywords(d.triggerKeywords, text) }));
    setKeywordText("");
  }

  /** publishing: the save is the first half of Publish, so the "still the published version" reminder would only confuse. */
  async function save(opts: { publishing?: boolean } = {}): Promise<string | null> {
    commitKeywords();
    if (!doc.name.trim()) {
      setAttempted(true);
      setTab("settings");
      toast.error("Give the chatbot a name before saving.", { key: "need-name" });
      requestAnimationFrame(() => nameRef.current?.focus());
      return null;
    }
    setBusy("save");
    try {
      const body = docToPayload(doc);
      let targetId = id;
      if (id) await apiFetch(`/api/chatbots/${id}`, { method: "PATCH", body });
      else targetId = unwrapChatbot<{ id: string }>(await apiFetch("/api/chatbots", { method: "POST", body })).id;
      if (!targetId) throw new Error("");
      setSaved(doc);
      setHist((h) => endBatch(h));
      if (!id) {
        toast.success("Chatbot created as a draft. Publish it when you are ready.");
        if (guardPushed.current) {
          // Step back over the extra history entry first, so the new address replaces this page instead of sitting after it.
          leaving.current = true;
          await new Promise<void>((done) => {
            const timer = window.setTimeout(done, 400);
            window.addEventListener("popstate", () => { window.clearTimeout(timer); done(); }, { once: true });
            window.history.back();
          });
          guardPushed.current = false;
          leaving.current = false;
        }
        router.replace(`/app/automation/chatbots/${targetId}`);
        return targetId;
      }
      remote.reload();
      // Saving never changes a live bot, its trigger included: customers keep the published version until Publish changes.
      toast.success(meta?.status === "published" && !opts.publishing ? "Draft saved. Customers keep getting the published version until you publish the changes." : "Draft saved.");
      return targetId;
    } catch (e) {
      toast.error(humanError(e, "save this chatbot"));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    commitKeywords();
    if (blocked) {
      setAttempted(true);
      setTab("checks");
      toast.error("Fix the problems under Checks before publishing.", { key: "fix-first" });
      return;
    }
    const target = dirty || !id ? await save({ publishing: true }) : id;
    if (!target) return;
    setBusy("publish");
    try {
      await apiFetch(`/api/chatbots/${target}/publish`, { method: "POST", body: {} });
      toast.success("Published. New matching conversations will use this version.");
      remote.reload();
    } catch (e) {
      const failure = publishFailure(e, doc.name.trim() || "this chatbot");
      if (failure.kind === "invalid") {
        const list = serverIssuesOf(e, flow);
        if (list.length > 0) setServerIssues({ doc, list });
        setAttempted(true);
        setTab("checks");
      }
      toast.error(failure.message);
    } finally {
      setBusy(null);
    }
  }

  async function unpublish() {
    if (!id) return;
    const ok = await confirm({
      title: `Unpublish "${doc.name.trim() || "this chatbot"}"?`,
      body: "Customers will stop getting this bot's replies. You can publish it again at any time.",
      confirmLabel: "Unpublish chatbot",
    });
    if (!ok) return;
    setBusy("publish");
    try {
      await apiFetch(`/api/chatbots/${id}/unpublish`, { method: "POST", body: {} });
      toast.success("Unpublished. The bot will no longer start.");
      remote.reload();
    } catch (e) {
      toast.error(humanError(e, "unpublish this chatbot"));
    } finally {
      setBusy(null);
    }
  }

  if (id && remote.loading) {
    return (
      <div aria-busy="true">
        <span role="status" className="sr-only">
          Loading chatbot
        </span>
        <Skeleton className="mb-2 h-4 w-40" />
        <Skeleton className="mb-6 h-8 w-72" />
        <Skeleton className="h-[62vh] min-h-[420px] w-full" />
      </div>
    );
  }
  if (id && remote.error && !meta) {
    return (
      <ErrorState
        title="We could not open this chatbot"
        message="It may have been deleted, or the connection dropped. Try again, or go back to your chatbots."
        action={
          <>
            <Button onClick={remote.reload}>Try again</Button>
            <Link href="/app/automation/chatbots" className="inline-flex min-h-10 items-center rounded-full border border-border-strong bg-raised px-5 text-sm font-semibold hover:bg-surface-2">
              Back to chatbots
            </Link>
          </>
        }
      />
    );
  }

  const status = meta?.status ?? "draft";
  const errorCount = issues.filter((i) => i.severity === "error").length;
  const title = doc.name.trim() || "New chatbot";
  const showGallery = !id && flow.nodes.length === 0 && !skipGallery && editable;

  const tabs: TabItem[] = [
    { id: "step", label: "Step" },
    { id: "settings", label: "Settings" },
    { id: "checks", label: "Checks", badge: issues.length > 0 ? issues.length : undefined },
    { id: "preview", label: "Preview" },
    ...(id ? [{ id: "sessions", label: "Conversations" }] : []),
  ];

  return (
    <div onKeyDown={onKeyDown}>
      <PageHeader
        title={title}
        breadcrumbs={[{ label: "Chatbots", href: "/app/automation/chatbots" }, { label: id ? "Edit chatbot" : "New chatbot" }]}
        actions={
          editable ? (
            <>
              <Button variant="secondary" loading={busy === "save"} disabled={busy === "publish" || (!dirty && Boolean(id))} onClick={() => void save()}>
                Save draft
              </Button>
              {status === "published" && (
                <Button variant="secondary" disabled={busy !== null} onClick={() => void unpublish()}>
                  Unpublish
                </Button>
              )}
              <Button loading={busy === "publish"} disabled={busy === "save"} onClick={() => void publish()}>
                {status === "published" ? "Publish changes" : "Publish"}
              </Button>
            </>
          ) : undefined
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={status} />
          {meta && hasUnpublishedChanges(meta) && <Badge tone="warn">Changes not published yet</Badge>}
          {dirty && (
            <Badge tone="warn" dot>
              Unsaved changes
            </Badge>
          )}
          {editable && (
            <span className="text-xs text-muted max-sm:hidden">
              Press <KeyboardKey keys={["Ctrl", "S"]} />{" "}to save
            </span>
          )}
        </div>
      </PageHeader>

      {role && !editable && (
        <Alert tone="info" className="mb-4">
          You can look at this chatbot. Only admins and owners can change it.
        </Alert>
      )}
      {starterName && !id && flow.nodes.length > 0 && (
        <Alert tone="info" title={`Started from the "${starterName}" template`} className="mb-4">
          The wording is a sample. Open each step and change it to match your business, then try it in the Preview tab.
        </Alert>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>

      {showGallery && (
        <section aria-labelledby="cb-start-heading" className="mb-6">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 id="cb-start-heading" className="text-base font-semibold">
                Start with a template
              </h2>
              <p className="text-sm text-muted">Pick one to see how a chatbot works, then change anything. Or begin with an empty canvas.</p>
            </div>
            <Button
              variant="ghost"
              onClick={() => {
                setSkipGallery(true);
                pendingFocus.current = focusById(ADD_STEP_ID);
              }}
            >
              Start from an empty canvas
            </Button>
          </div>
          <StarterGallery onPick={applyStarter} />
        </section>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-3">
          <div role="toolbar" aria-label="Chatbot tools" className="flex flex-wrap items-center gap-2">
            {editable && (
              <Button id={ADD_STEP_ID} size="sm" className={touch} aria-expanded={paletteOpen} aria-controls="cb-palette" onClick={() => setPaletteOpen((o) => !o)}>
                {paletteOpen ? "Close step list" : "Add a step"}
              </Button>
            )}
            <Button size="sm" variant="secondary" className={touch} disabled={!canUndo(hist) || !editable} onClick={() => stepHistory(undo)}>
              Undo
            </Button>
            <Button size="sm" variant="secondary" className={touch} disabled={!canRedo(hist) || !editable} onClick={() => stepHistory(redo)}>
              Redo
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className={touch}
              disabled={!editable || flow.nodes.length === 0}
              onClick={() => {
                const f = autoLayout(flow);
                applyFlow(() => f);
                fit(f);
              }}
            >
              Tidy up
            </Button>
            <span className="flex-1" />
            {!compact && (
              <>
            <Tooltip content="Zoom out">
              <Button size="sm" variant="secondary" className={`${touch} max-sm:min-w-10`} aria-label="Zoom out" onClick={() => setView((v) => zoomAt(v, 0.8, size.current.w / 2, size.current.h / 2))}>
                <Icon>
                  <path d="M5 12h14" />
                </Icon>
              </Button>
            </Tooltip>
            <Tooltip content="Zoom in">
              <Button size="sm" variant="secondary" className={`${touch} max-sm:min-w-10`} aria-label="Zoom in" onClick={() => setView((v) => zoomAt(v, 1.25, size.current.w / 2, size.current.h / 2))}>
                <Icon>
                  <path d="M12 5v14M5 12h14" />
                </Icon>
              </Button>
            </Tooltip>
            <Button size="sm" variant="secondary" className={touch} onClick={() => fit()}>
              Fit to screen
            </Button>
              </>
            )}
          </div>

          {paletteOpen && editable && (
            // The columns follow the card's own width (a container query), not the window's: next to the side panel the canvas column is narrow.
            <Card id="cb-palette" className="@container" title="Add a step" description="The new step connects to the step you have selected, if it has a free exit.">
              <div className="grid gap-4 @md:grid-cols-2 @4xl:grid-cols-4">
                {GROUPS.map((g) => (
                  <div key={g}>
                    <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">{g}</h3>
                    <ul className="space-y-1.5">
                      {NODE_TYPES.filter((t) => NODE_META[t].group === g).map((t) => (
                        <li key={t}>
                          <button
                            type="button"
                            onClick={() => addStep(t)}
                            className="flex min-h-10 w-full flex-col justify-center rounded-control border border-border-strong bg-raised px-3 py-1.5 text-left hover:bg-surface-2"
                          >
                            <span className="text-sm font-medium">{NODE_META[t].label}</span>
                            <span className="text-xs text-muted">{NODE_META[t].help}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Canvas
            flow={flow}
            view={view}
            onView={setView}
            selectedId={selectedId}
            selectedEdgeId={selectedEdge}
            badNodes={badNodes}
            warnNodes={warnNodes}
            readOnly={!editable}
            compact={compact}
            onActivate={() => {
              const wide = matches(WIDE_QUERY);
              say(wide ? "Step selected. Its settings are in the Step tab." : "Step selected. Its settings are in the Step tab below.");
              if (!wide) showInspector();
            }}
            onSelect={(nid) => {
              setSelectedId(nid);
              if (nid) setTab("step");
            }}
            onSelectEdge={setSelectedEdge}
            onMove={(nid, pos) => applyFlow((f) => moveNode(f, nid, pos), `move:${nid}`)}
            onMoveEnd={() => setHist((h) => endBatch(h))}
            onConnect={(from, label, to) => applyFlow((f) => connect(f, from, label, to))}
            onReconnect={(edgeId, to) => applyFlow((f) => reconnectEdge(f, edgeId, to))}
            onDelete={(nid) => editable && removeSelected(nid)}
            onSize={(w, h) => {
              size.current = { w, h };
            }}
          />
          {selectedEdge && editable && (
            <Alert
              tone="info"
              action={
                <Button
                  size="sm"
                  variant="danger"
                  className={touch}
                  onClick={() => {
                    applyFlow((f) => removeEdge(f, selectedEdge));
                    setSelectedEdge(null);
                  }}
                >
                  Remove this connection
                </Button>
              }
            >
              A connection is selected.
            </Alert>
          )}
          <details className="text-sm text-muted">
            <summary className="min-h-10 cursor-pointer font-medium leading-10 text-foreground">How to use the canvas</summary>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li>Drag a step to move it. Drag the background to look around. To zoom, hold Ctrl (Cmd on a Mac) and scroll, pinch on a trackpad, or use the zoom buttons.</li>
              <li>To connect steps, drag from the round dot on the right of a step onto another step.</li>
              <li>With a keyboard, select a step, move it with the arrow keys, and choose what comes next in the Step tab.</li>
              <li>On a phone or small touch screen the canvas is for viewing: scroll to look around and tap a step to edit it in the Step tab.</li>
            </ul>
          </details>
        </div>

        <div ref={panelRef} className="min-w-0 scroll-mt-4 xl:self-start">
        <Card>
          <Tabs tabs={tabs} label="Chatbot panels" variant="pill" value={tab} onChange={(t) => setTab(t as Tab)} idPrefix={ID_PREFIX} />
          <div role="tabpanel" id={tabIds(ID_PREFIX, tab).panel} aria-labelledby={tabIds(ID_PREFIX, tab).tab} tabIndex={0} className="mt-4 outline-offset-4">
            {tab === "step" && (
              <StepPanel
                flow={flow}
                selectedId={selectedId}
                onPick={(v) => {
                  setSelectedId(v);
                  setSelectedEdge(null);
                }}
              >
                {selected ? (
                  <fieldset disabled={!editable} className="min-w-0 border-0 p-0">
                    <Inspector
                      key={selected.id}
                      node={selected}
                      flow={flow}
                      templates={templates.data?.templates ?? []}
                      members={members.data?.members ?? []}
                      teams={options.data?.teams ?? []}
                      onData={(patch, structural) =>
                        applyFlow(
                          (f) => updateNode(f, selected.id, (n) => ({ ...n, data: { ...n.data, ...patch } }) as FlowNode),
                          structural ? null : `data:${selected.id}:${Object.keys(patch).join(",")}`,
                        )
                      }
                      onConnect={(label, to) => applyFlow((f) => (to ? connect(f, selected.id, label, to) : { ...f, edges: f.edges.filter((e) => !(e.from === selected.id && e.label === label)) }))}
                      onDelete={() => removeSelected(selected.id)}
                      onDuplicate={() => duplicateSelected(selected.id)}
                      onSetStart={() => applyFlow((f) => setStart(f, selected.id))}
                    />
                  </fieldset>
                ) : (
                  <EmptyState
                    compact
                    title="No step selected"
                    body={flow.nodes.length === 0 ? "Add your first step to start building." : "Select a step on the canvas, or choose one from the list above, to change it."}
                    action={
                      editable && flow.nodes.length === 0 ? (
                        <Button
                          onClick={() => {
                            setPaletteOpen(true);
                            pendingFocus.current = () => document.querySelector<HTMLElement>("#cb-palette button")?.focus();
                          }}
                        >
                          Add a step
                        </Button>
                      ) : undefined
                    }
                  />
                )}
              </StepPanel>
            )}
            {tab === "settings" && <SettingsPanel doc={doc} editable={editable} attempted={attempted} nameRef={nameRef} keywordRef={keywordRef} keywordText={keywordText} setKeywordText={setKeywordText} commitKeywords={commitKeywords} apply={apply} options={options.data} members={members.data?.members ?? []} />}
            {tab === "checks" && (
              <Checks
                issues={issues}
                flow={flow}
                onPick={(i) => {
                  if (i.nodeId) {
                    setSelectedId(i.nodeId);
                    setSelectedEdge(null);
                    setTab("step");
                    showInspector();
                    say("Step selected. Its settings are in the Step tab.");
                  } else if (i.tab) showPanel(i.tab);
                }}
              />
            )}
            {tab === "preview" && <PreviewPanel flow={flow} triggerType={doc.triggerType} keywords={doc.triggerKeywords} />}
            {tab === "sessions" && id && <SessionsPanel chatbotId={id} />}
          </div>
          {tab !== "checks" && errorCount > 0 && (
            <p className="mt-4 text-xs text-muted">
              {errorCount} {errorCount === 1 ? "problem" : "problems"} to fix before you can publish.{" "}
              <button type="button" className="font-medium text-accent-ink underline underline-offset-2" onClick={() => showPanel("checks")}>
                See Checks
              </button>
            </p>
          )}
        </Card>
        </div>
      </div>
    </div>
  );
}

function StepPanel({ flow, selectedId, onPick, children }: { flow: FlowDefinition; selectedId: string | null; onPick: (id: string | null) => void; children: ReactNode }) {
  return (
    <div className="space-y-4">
      {flow.nodes.length > 0 && (
        <FormField label="Step to edit">
          <Select value={selectedId ?? ""} onChange={(e) => onPick(e.target.value || null)}>
            <option value="">Choose a step</option>
            {flow.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {describeStep(flow.nodes, n)}
              </option>
            ))}
          </Select>
        </FormField>
      )}
      {children}
    </div>
  );
}

function SettingsPanel({
  doc,
  editable,
  attempted,
  nameRef,
  keywordRef,
  keywordText,
  setKeywordText,
  commitKeywords,
  apply,
  options,
  members,
}: {
  doc: Doc;
  editable: boolean;
  attempted: boolean;
  nameRef: RefObject<HTMLInputElement | null>;
  keywordRef: RefObject<HTMLInputElement | null>;
  keywordText: string;
  setKeywordText: (v: string) => void;
  commitKeywords: () => void;
  apply: (fn: (d: Doc) => Doc, key?: string | null) => void;
  options: BotOptions | null;
  members: MemberOption[];
}) {
  const [touchedName, setTouchedName] = useState(false);
  const add = commitKeywords;
  const nameError = (touchedName || attempted) && !doc.name.trim() ? "Give the chatbot a name your team will recognise, for example \"Welcome menu\"." : null;
  const keywordError = attempted && doc.triggerType === "keyword" && doc.triggerKeywords.length === 0 ? "Add at least one word so the bot knows when to start." : null;
  return (
    <fieldset disabled={!editable} className="min-w-0 space-y-5 border-0 p-0">
      <legend className="sr-only">Chatbot settings</legend>
      <h2 className="text-base font-semibold">Name and start</h2>
      <FormField label="Chatbot name" required hint="Only your team sees this." error={nameError}>
        <Input ref={nameRef} value={doc.name} maxLength={80} placeholder="e.g. Welcome menu" onBlur={() => setTouchedName(true)} onChange={(e) => apply((d) => ({ ...d, name: e.target.value }), "name")} />
      </FormField>
      <FormField label="When should this chatbot start?" hint={TRIGGER_HELP[doc.triggerType]}>
        <Select value={doc.triggerType} onChange={(e) => apply((d) => ({ ...d, triggerType: e.target.value as TriggerType }))}>
          {(Object.keys(TRIGGER_LABEL) as TriggerType[]).map((t) => (
            <option key={t} value={t}>
              {TRIGGER_LABEL[t]}
            </option>
          ))}
        </Select>
      </FormField>
      {doc.triggerType === "keyword" && (
        <div className="space-y-2">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <FormField label="Words that start the chatbot" required hint="Type a word and press Enter, or separate several with commas. Capital letters do not matter." error={keywordError}>
                <Input
                  ref={keywordRef}
                  value={keywordText}
                  maxLength={200}
                  placeholder="e.g. price, pricing"
                  onChange={(e) => setKeywordText(e.target.value)}
                  onBlur={add}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      add();
                    }
                  }}
                />
              </FormField>
            </div>
            <Button type="button" variant="secondary" className="mt-[1.625rem]" disabled={!keywordText.trim()} onClick={add}>
              Add
            </Button>
          </div>
          {doc.triggerKeywords.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5" aria-label="Words that start the chatbot">
              {doc.triggerKeywords.map((k) => (
                <li key={k} className="flex items-center gap-1 rounded-full border border-border bg-surface py-0.5 pl-2.5 pr-1 text-sm">
                  {k}
                  <button
                    type="button"
                    aria-label={`Remove the word ${k}`}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-foreground"
                    onClick={() => {
                      apply((d) => ({ ...d, triggerKeywords: d.triggerKeywords.filter((x) => x !== k) }));
                      keywordRef.current?.focus();
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" aria-hidden>
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">No words added yet.</p>
          )}
        </div>
      )}
      <BotSettings doc={doc} triggerType={doc.triggerType} options={options} members={members} apply={apply} />
    </fieldset>
  );
}

function Checks({ issues, flow, onPick }: { issues: Issue[]; flow: FlowDefinition; onPick: (i: Issue) => void }) {
  if (issues.length === 0) {
    return (
      <Alert tone="good" title="No problems found">
        This chatbot is ready to publish. Try it in the Preview tab first.
      </Alert>
    );
  }
  const groups: { title: string; tone: "bad" | "warn"; items: Issue[] }[] = [
    { title: "Fix before publishing", tone: "bad", items: issues.filter((i) => i.severity === "error") },
    { title: "Worth a look", tone: "warn", items: issues.filter((i) => i.severity === "warning") },
  ];
  return (
    <div className="space-y-5">
      {groups
        .filter((g) => g.items.length > 0)
        .map((g) => (
          <section key={g.title} aria-label={g.title}>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              {g.title}
              <Badge tone={g.tone}>{g.items.length}</Badge>
            </h2>
            <ul className="space-y-1.5">
              {g.items.map((i, k) => {
                const node = i.nodeId ? nodeById(flow, i.nodeId) : undefined;
                const where = node ? describeStep(flow.nodes, node) : null;
                const go = i.nodeId ? "Go to step" : i.tab ? "Open settings" : null;
                return (
                  <li key={`${g.tone}-${k}`} className="rounded-control border border-border p-2.5 text-sm">
                    <p>{i.message}</p>
                    {where && <p className="mt-0.5 text-xs text-muted">{where}</p>}
                    {go && (
                      <Button size="sm" variant="ghost" className={`-ml-3 mt-1 ${touch}`} onClick={() => onPick(i)}>
                        {go}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
    </div>
  );
}
