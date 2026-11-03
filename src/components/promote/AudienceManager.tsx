"use client";

/**
 * AudienceManager (docs/IG-PAGE-ADS-SPEC.md 3.7, 4.8, 4.10, 7.3, D17; PRM-15b): /app/ads/audiences.
 *
 * - The list: each audience with its status chip (Getting ready, Ready, Too small, Problem, always in words) and its size
 *   range ("About 1.2–1.8 lakh people"), from GET /api/promote/audiences.
 * - Make an audience: only the kinds PROMOTE_AUDIENCES offers (saved; then people who engaged, website visitors and
 *   lookalikes; then customer lists). POST /api/promote/audiences.
 * - Past customers: the count first (GET ?preview=customer_list, the database only), then a confirm card: "Share 1,240
 *   contacts with Meta …", the hashing sentence and the lawful basis. Under 100 people nothing can be shared.
 * - Refresh: POST …/[id]/refresh (a customer list shows the share card again, because it sends the list again).
 * - Delete: a danger confirm with focus on Cancel first, then DELETE …/[id] (Meta first, then here).
 * - Meta's audience terms missing: the 409 answer's fix, an OpensMetaButton custom_audience_tos whose address the server
 *   resolved from the allowlist.
 */
import { useId, useState } from "react";
import { Alert, Button, Card, Dialog, EmptyState, ErrorState, FormField, Input, Select, Skeleton, StatusPill, apiFetch, confirm, toast } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { useApi } from "@/components/contacts/hooks";
import { AUDIENCE_EVENTS } from "@/lib/promote/catalog/audience-events";
import type { AudienceChip, AudienceKind } from "@/lib/promote/audiences";
import type { PromoteAudiences } from "@/lib/promote/flags";
import { OpensMetaButton } from "./OpensMetaButton";
import {
  AUDIENCE_EVENT_TEXT,
  AUDIENCE_KIND_TEXT,
  AUDIENCE_TEXT,
  LOOKALIKE_RANGE,
  audienceBody,
  audienceChipView,
  audienceKindsFor,
  audienceSizeText,
  customerListConfirm,
  customerPreviewPath,
  emptyAudienceForm,
  retentionFor,
  type AudienceForm,
} from "./results-helpers";

export const AUDIENCE_MANAGER_TEST_ID = "audience-manager";

export type AudienceOption = { id: string; name: string };

export type AudienceManagerProps = {
  /** promoteAccess.audiences: what PROMOTE_AUDIENCES offers now. */
  level: PromoteAudiences;
  /** Owners and admins. */
  canWrite: boolean;
  /** Meta's audience terms screen for the spending ad account, resolved on the server (meta-screens.ts). */
  termsHref?: string | null;
  /** Where people engaged: Instagram accounts, Pages and lead forms of the workspace (row ids, never Meta ids). */
  sources?: Partial<Record<"instagram" | "page" | "lead_form", AudienceOption[]>>;
  /** Segments a customer list can be made from. */
  segments?: AudienceOption[];
};

type AudienceRow = {
  id: string;
  kind: AudienceKind;
  name: string;
  status: string;
  chip: AudienceChip;
  sizeLine: string | null;
  problem: string | null;
  usable: boolean;
  available: boolean;
  details: Record<string, unknown>;
};

type ListAnswer = { audiences: AudienceRow[]; kinds: string[]; customerLists: { used: number; max: number } };
type Count = { included: number; total: number; line?: string; tooSmall?: boolean };
type Share = { mode: "create" | "refresh"; count: Count; body?: Record<string, unknown>; audience?: AudienceRow };

const SOURCE_OF: Partial<Record<AudienceKind, "instagram" | "page" | "lead_form">> = {
  engagement_instagram: "instagram",
  engagement_page: "page",
  engagement_lead_form: "lead_form",
};

/** The terms fix carried by a 409 answer ({ kind: "custom_audience_tos", fix: { href } }). */
function termsFixOf(e: unknown): { href: string | null } | null {
  const body = (e as { body?: { kind?: unknown; fix?: { href?: unknown } } }).body;
  if (body?.kind !== "custom_audience_tos") return null;
  return { href: typeof body.fix?.href === "string" ? body.fix.href : null };
}

export function AudienceManager({ level, canWrite, termsHref, sources = {}, segments = [] }: AudienceManagerProps) {
  const listId = useId();
  const formId = useId();
  const { data, error, loading, reload, retry } = useApi<ListAnswer>(canWrite ? "/api/promote/audiences" : null);
  const kinds = audienceKindsFor(level, data?.kinds ?? null);
  const [kind, setKind] = useState<AudienceKind>(kinds[0] ?? "saved");
  const [form, setForm] = useState<AudienceForm>(emptyAudienceForm);
  const [problem, setProblem] = useState<string | null>(null);
  const [terms, setTerms] = useState<{ href: string | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [share, setShare] = useState<Share | null>(null);
  const [said, setSaid] = useState("");

  if (!canWrite) {
    return (
      <div data-testid={AUDIENCE_MANAGER_TEST_ID}>
        <PageHeader title={AUDIENCE_TEXT.heading} breadcrumbs={[{ label: "Ad campaigns", href: "/app/ads" }, { label: AUDIENCE_TEXT.heading }]} />
        <EmptyState title={AUDIENCE_TEXT.heading} body={AUDIENCE_TEXT.agentsOnly} />
      </div>
    );
  }

  const audiences = data?.audiences ?? [];
  const seeds = audiences.filter((a) => a.kind !== "saved" && a.kind !== "lookalike" && a.available && a.status === "ready");
  const active = kinds.includes(kind) ? kind : (kinds[0] ?? "saved");
  const set = <K extends keyof AudienceForm>(key: K, value: AudienceForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  function announce(text: string) {
    setSaid(text);
    toast.success(text);
  }

  async function post(body: Record<string, unknown>) {
    setBusy("create");
    setProblem(null);
    setTerms(null);
    try {
      const res = await apiFetch<{ audience: { name: string }; notice?: string }>("/api/promote/audiences", { method: "POST", body });
      announce(res.notice ?? (active === "saved" ? AUDIENCE_TEXT.saved(res.audience.name) : AUDIENCE_TEXT.created(res.audience.name)));
      setForm(emptyAudienceForm());
      setShare(null);
      reload();
    } catch (e) {
      const fix = termsFixOf(e);
      if (fix) setTerms({ href: fix.href ?? termsHref ?? null });
      setProblem((e as Error).message);
      setShare(null);
    } finally {
      setBusy(null);
    }
  }

  async function submit() {
    const built = audienceBody(active, form);
    if (!built.ok) return setProblem(built.problem);
    setProblem(null);
    if (active !== "customer_list") return void post(built.body);
    // A customer list shares contacts: count first, then the confirm card.
    setBusy("count");
    try {
      const res = await apiFetch<{ count: Count }>(customerPreviewPath({ segmentId: form.segmentId, tag: form.tag }));
      setShare({ mode: "create", count: res.count, body: built.body });
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function refresh(a: AudienceRow) {
    if (a.kind === "customer_list") {
      const selection = (a.details.selection ?? {}) as { segmentId?: string; tag?: string };
      setBusy(`refresh:${a.id}`);
      try {
        const res = await apiFetch<{ count: Count }>(customerPreviewPath(selection));
        setShare({ mode: "refresh", count: res.count, audience: a });
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setBusy(null);
      }
      return;
    }
    await runRefresh(a);
  }

  async function runRefresh(a: AudienceRow) {
    setBusy(`refresh:${a.id}`);
    try {
      const res = await apiFetch<{ notice?: string }>(`/api/promote/audiences/${encodeURIComponent(a.id)}/refresh`, { method: "POST" });
      announce(res.notice ?? AUDIENCE_TEXT.refreshed(a.name));
      setShare(null);
      reload();
    } catch (e) {
      const fix = termsFixOf(e);
      if (fix) setTerms({ href: fix.href ?? termsHref ?? null });
      toast.error((e as Error).message);
      setShare(null);
    } finally {
      setBusy(null);
    }
  }

  async function remove(a: AudienceRow) {
    const ok = await confirm({ title: AUDIENCE_TEXT.deleteTitle(a.name), body: AUDIENCE_TEXT.deleteBody, confirmLabel: AUDIENCE_TEXT.deleteConfirm, tone: "danger" });
    if (!ok) return;
    setBusy(`delete:${a.id}`);
    try {
      await apiFetch(`/api/promote/audiences/${encodeURIComponent(a.id)}`, { method: "DELETE" });
      announce(AUDIENCE_TEXT.deleted(a.name));
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const sourceKind = SOURCE_OF[active];
  const sourceOptions = sourceKind ? (sources[sourceKind] ?? []) : [];
  const eventKind = active === "website" || sourceKind ? (active as "engagement_instagram" | "engagement_page" | "engagement_lead_form" | "website") : null;
  const bounds = eventKind ? retentionFor(eventKind) : null;
  const events = eventKind && eventKind !== "website" ? AUDIENCE_EVENTS.filter((e) => e.kind === eventKind) : [];

  return (
    <div className="min-w-0 space-y-6" data-testid={AUDIENCE_MANAGER_TEST_ID}>
      <PageHeader title={AUDIENCE_TEXT.heading} description={AUDIENCE_TEXT.intro} breadcrumbs={[{ label: "Ad campaigns", href: "/app/ads" }, { label: AUDIENCE_TEXT.heading }]} />

      <section aria-labelledby={listId} className="min-w-0 space-y-3">
        <h2 id={listId} className="text-base font-semibold tracking-tight">
          {AUDIENCE_TEXT.heading}
        </h2>
        {loading && !data ? (
          <div aria-busy="true" className="space-y-2">
            <span className="sr-only" role="status">
              Loading audiences
            </span>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : error && !data ? (
          <ErrorState title={AUDIENCE_TEXT.loadFailed} action={<Button variant="secondary" onClick={retry}>Try again</Button>} />
        ) : audiences.length === 0 ? (
          <EmptyState compact title={AUDIENCE_TEXT.empty} />
        ) : (
          <ul className="divide-y divide-border rounded-card border border-border bg-raised" data-testid="audience-list">
            {audiences.map((a) => {
              const chip = audienceChipView(a.chip);
              return (
                <li key={a.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3" data-testid={`audience-${a.id}`}>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="font-medium break-words">{a.name}</p>
                    <p className="text-xs text-muted">{AUDIENCE_KIND_TEXT[a.kind]?.title ?? a.kind}</p>
                    <p className="text-xs tabular-nums">{audienceSizeText(a)}</p>
                    {a.problem && <p className="text-xs text-bad-fg break-words">{a.problem}</p>}
                  </div>
                  <StatusPill status={a.chip} label={chip.label} tone={chip.tone} />
                  <div className="flex flex-wrap gap-2">
                    {a.kind !== "saved" && (
                      <Button size="sm" variant="secondary" loading={busy === `refresh:${a.id}`} disabled={busy !== null || !a.available} aria-label={`${AUDIENCE_TEXT.refresh} "${a.name}"`} onClick={() => void refresh(a)}>
                        {AUDIENCE_TEXT.refresh}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" className="text-bad-fg" loading={busy === `delete:${a.id}`} disabled={busy !== null} aria-label={`${AUDIENCE_TEXT.delete} "${a.name}"`} onClick={() => void remove(a)}>
                      {AUDIENCE_TEXT.delete}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div aria-live="polite" className="sr-only" data-testid="audience-status">
          {said}
        </div>
      </section>

      <Card title={AUDIENCE_TEXT.create} headingLevel="h2">
        <form
          id={formId}
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium">{AUDIENCE_TEXT.kindLabel}</legend>
            {kinds.map((k) => (
              <label key={k} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-card border border-border p-3 has-[:checked]:border-accent">
                <input
                  type="radio"
                  name={`${formId}-kind`}
                  value={k}
                  checked={active === k}
                  onChange={() => {
                    setKind(k);
                    setProblem(null);
                    setTerms(null);
                    // A source, event or day count of another kind never carries over.
                    setForm((f) => ({ ...f, sourceId: "", event: "", days: "" }));
                  }}
                  className="mt-1"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{AUDIENCE_KIND_TEXT[k].title}</span>
                  <span className="block text-xs text-muted">{AUDIENCE_KIND_TEXT[k].body}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <FormField label={AUDIENCE_TEXT.name} hint={AUDIENCE_TEXT.nameHint} optional>
            <Input value={form.name} maxLength={100} onChange={(e) => set("name", e.target.value)} autoComplete="off" />
          </FormField>

          {active === "saved" && (
            <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
              <FormField label={AUDIENCE_TEXT.country}>
                <Input value={form.country} maxLength={2} onChange={(e) => set("country", e.target.value)} autoComplete="off" />
              </FormField>
              <FormField label={AUDIENCE_TEXT.gender}>
                <Select value={form.gender} onChange={(e) => set("gender", e.target.value as AudienceForm["gender"])}>
                  <option value="">{AUDIENCE_TEXT.anyGender}</option>
                  <option value="female">{AUDIENCE_TEXT.women}</option>
                  <option value="male">{AUDIENCE_TEXT.men}</option>
                </Select>
              </FormField>
              <FormField label={AUDIENCE_TEXT.ageMin}>
                <Input inputMode="numeric" value={form.ageMin} onChange={(e) => set("ageMin", e.target.value)} />
              </FormField>
              <FormField label={AUDIENCE_TEXT.ageMax}>
                <Input inputMode="numeric" value={form.ageMax} onChange={(e) => set("ageMax", e.target.value)} />
              </FormField>
            </div>
          )}

          {active === "customer_list" && (
            <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
              <FormField label={AUDIENCE_TEXT.segment}>
                <Select value={form.segmentId} onChange={(e) => set("segmentId", e.target.value)}>
                  <option value="">{AUDIENCE_TEXT.allContacts}</option>
                  {segments.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label={AUDIENCE_TEXT.tag} hint={AUDIENCE_TEXT.tagHint} optional>
                <Input value={form.tag} maxLength={100} onChange={(e) => set("tag", e.target.value)} autoComplete="off" />
              </FormField>
              <p className="text-xs text-muted min-[400px]:col-span-2">{AUDIENCE_TEXT.lawfulBasis}</p>
            </div>
          )}

          {sourceKind && (
            <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
              {sourceOptions.length === 0 ? (
                <Alert tone="warn" className="min-[400px]:col-span-2">
                  {AUDIENCE_TEXT.noSources}
                </Alert>
              ) : (
                <FormField label={AUDIENCE_TEXT.source} required>
                  <Select value={form.sourceId} onChange={(e) => set("sourceId", e.target.value)}>
                    <option value="">Choose one</option>
                    {sourceOptions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </FormField>
              )}
              {events.length > 0 && (
                <FormField label={AUDIENCE_TEXT.event}>
                  <Select value={form.event || events[0].id} onChange={(e) => set("event", e.target.value)}>
                    {events.map((ev) => (
                      <option key={ev.id} value={ev.id}>
                        {AUDIENCE_EVENT_TEXT[ev.id] ?? ev.id}
                      </option>
                    ))}
                  </Select>
                </FormField>
              )}
            </div>
          )}

          {active === "website" && (
            <FormField label={AUDIENCE_TEXT.urlWord} hint={AUDIENCE_TEXT.urlWordHint} optional>
              <Input value={form.urlContains} maxLength={100} onChange={(e) => set("urlContains", e.target.value)} autoComplete="off" />
            </FormField>
          )}

          {bounds && (
            <FormField label={AUDIENCE_TEXT.days} hint={AUDIENCE_TEXT.daysHint(bounds.maxDays)}>
              <Input inputMode="numeric" value={form.days || String(bounds.defaultDays)} onChange={(e) => set("days", e.target.value)} />
            </FormField>
          )}

          {active === "lookalike" && (
            <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
              {seeds.length === 0 ? (
                <Alert tone="warn" className="min-[400px]:col-span-2">
                  {AUDIENCE_TEXT.noSeeds}
                </Alert>
              ) : (
                <FormField label={AUDIENCE_TEXT.seed} required>
                  <Select value={form.seedAudienceId} onChange={(e) => set("seedAudienceId", e.target.value)}>
                    <option value="">Choose one</option>
                    {seeds.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </FormField>
              )}
              <FormField label={AUDIENCE_TEXT.percent} hint={AUDIENCE_TEXT.percentHint(LOOKALIKE_RANGE.min, LOOKALIKE_RANGE.max)}>
                <Input type="number" min={LOOKALIKE_RANGE.min} max={LOOKALIKE_RANGE.max} step={1} value={form.percent} onChange={(e) => set("percent", e.target.value)} />
              </FormField>
            </div>
          )}

          <div aria-live="polite" className="space-y-2 empty:hidden">
            {problem && <Alert tone="bad">{problem}</Alert>}
            {terms && (
              <div className="space-y-2" data-testid="audience-terms">
                <p className="text-sm font-medium">{AUDIENCE_TEXT.termsMissing}</p>
                <OpensMetaButton href={terms.href} screen="custom_audience_tos" label={AUDIENCE_TEXT.termsMissing} data-testid="audience-terms-opens-meta" />
              </div>
            )}
          </div>

          <Button type="submit" loading={busy === "create" || busy === "count"} disabled={busy !== null} data-testid="audience-create">
            {active === "saved" ? AUDIENCE_TEXT.save : AUDIENCE_TEXT.make}
          </Button>
        </form>
      </Card>

      {share && (
        <ShareDialog
          share={share}
          busy={busy === "create" || (share.audience ? busy === `refresh:${share.audience.id}` : false)}
          onCancel={() => setShare(null)}
          onConfirm={() => {
            if (share.mode === "create" && share.body) void post(share.body);
            else if (share.audience) void runRefresh(share.audience);
          }}
        />
      )}
    </div>
  );
}

/** The customer-list confirm card (3.7): the count, the hashing sentence and the lawful basis; nothing to share under 100. */
function ShareDialog({ share, busy, onCancel, onConfirm }: { share: Share; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const view = customerListConfirm(share.count);
  return (
    <Dialog
      title={share.mode === "refresh" ? AUDIENCE_TEXT.refreshTitle : view.title}
      onClose={onCancel}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy} data-autofocus="">
            {AUDIENCE_TEXT.cancel}
          </Button>
          {view.canShare && (
            <Button onClick={onConfirm} loading={busy} data-testid="audience-share-confirm">
              {share.mode === "refresh" ? AUDIENCE_TEXT.refreshConfirm : view.confirmLabel}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-2 text-sm" data-testid="audience-share-card">
        {view.lines.map((line) => (
          <p key={line} className="break-words">
            {line}
          </p>
        ))}
      </div>
    </Dialog>
  );
}

export default AudienceManager;
