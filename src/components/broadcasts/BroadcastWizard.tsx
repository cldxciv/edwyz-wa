"use client";

import { broadcastSupportReason } from "@/lib/broadcasts/components";
import { displayName } from "@/lib/contacts/identity";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, EmptyState, ErrorState, FormField, Input, Select, Skeleton, apiFetch, cn, confirm, toast } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { canManage, useApi, useRole } from "@/components/contacts/hooks";
import { parseTagInput } from "@/components/contacts/helpers";
import { FilterBuilder } from "@/components/segments/FilterBuilder";
import { type Draft, draftProblems, draftToFilter, emptyDraft, summarizeFilter } from "@/components/segments/helpers";
import { usePreview } from "@/components/segments/usePreview";
import { SegmentPicker } from "./AudienceExtras";
import { calendarHrefFor, monthOfDateParam } from "./CampaignCalendar";
import { LinkButton } from "./LinkButton";
import { VariableMapping } from "./VariableMapping";
import { useKeyedApi } from "./useKeyedApi";
import { ChoiceCard, Stepper, SummaryRow, TemplateBubble, WIZARD_STEPS } from "./WizardParts";
import { type MissingValuePolicy, type VariableMap, cleanMap, defaultMap, firstMappingProblem, policyNote, templateSlots } from "./mappingForm";
import {
  type AudienceMode,
  audienceLabel,
  audienceLine,
  categoryLabel,
  costSummary,
  defaultBroadcastName,
  formatMinor,
  formatWhen,
  friendlyError,
  humanizeName,
  languageName,
  placeholderNote,
  presetSchedule,
  qualityWarning,
  retrySummary,
  scheduleBounds,
  scheduleSummary,
  templatePreview,
  tierSummary,
  unsupportedTemplateReason,
  validateSchedule,
  wizardHint,
} from "./helpers";

/** Why a template cannot be broadcast (named placeholders and coupon codes can; login codes, forms and carousels cannot), or null. */
const templateBlocker = (components: unknown): string | null => broadcastSupportReason(components) ?? unsupportedTemplateReason(components);

type Named = { id: string; name: string; description?: string };
type Options = {
  phoneNumbers: { id: string; displayPhone: string; verifiedName: string | null; qualityRating: string | null; messagingLimitTier: string | null; portfolioTier?: string | null }[];
  tags: string[];
  eligibleCount: number;
  segments: Named[];
  presets: Named[];
  attributeKeys: string[];
};
type Template = { id: string; name: string; language: string; category: string; status: string; components?: unknown };
type CostInfo = {
  configured: boolean;
  totalPaise?: number;
  totalMinor?: number;
  currency?: string;
  unpricedCount?: number;
  lines?: { country: string | null; count: number; perMessageMinor: number | null; totalMinor: number | null }[];
};
type Estimate = {
  count: number;
  cost: CostInfo;
  label?: string;
  coverage?: { contactsMissing: number; checked: number; total: number; policy: MissingValuePolicy; bySlot: { label: string; count: number }[] };
  sending?: { limit: number | null; used: number; days: number; hint: string | null } | null;
  /** Set when the broadcast won't fit the workspace's WhatsApp limit (spend controls 4.9): the refusal or the scheduling warning. */
  limitWarning?: string | null;
};

const BACK_TO_LIST = [{ label: "Broadcasts", href: "/app/broadcasts" }, { label: "New broadcast" }];
const navButton = "w-full min-h-11 sm:w-auto sm:min-h-10";
const HINT_ID = "wizard-hint";

function PageSkeleton() {
  return (
    <div aria-busy="true">
      <PageHeader title="New broadcast" breadcrumbs={BACK_TO_LIST} />
      <span className="sr-only" role="status">
        Loading
      </span>
      <Skeleton className="mb-6 h-8 w-full max-w-md" />
      <Skeleton className="h-72 w-full max-w-2xl" />
    </div>
  );
}

export function BroadcastWizard() {
  const router = useRouter();
  const role = useRole();
  const [step, setStep] = useState(1);
  const [phoneId, setPhoneId] = useState("");
  const [audienceMode, setAudienceMode] = useState<AudienceMode>("all");
  const [segmentId, setSegmentId] = useState("");
  const [rules, setRules] = useState<Draft>(emptyDraft());
  const [variableMap, setVariableMap] = useState<VariableMap>({});
  const [policy, setPolicy] = useState<MissingValuePolicy>("skip");
  const [mapTouched, setMapTouched] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [tagText, setTagText] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [name, setName] = useState("");
  const [whenMode, setWhenMode] = useState<"now" | "later">("now");
  const [scheduledAt, setScheduledAt] = useState("");
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [backHref, setBackHref] = useState("/app/broadcasts");
  const [fromCalendar, setFromCalendar] = useState(false);
  const [retryDays, setRetryDays] = useState(0);
  const [draft, setDraft] = useState<{ id: string; key: string } | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [busy, setBusy] = useState<"prepare" | "send" | "draft" | "leave" | null>(null);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  const tagInput = useRef<HTMLInputElement>(null);
  const tagList = useRef<HTMLUListElement>(null);
  const refocus = useRef<string | null>(null);
  const draftId = draft?.id ?? null;

  const effectiveTags = useMemo(() => (audienceMode === "tags" ? tags : []), [audienceMode, tags]);
  const filterStack = useMemo(() => draftToFilter(rules), [rules]);
  const rulesReady = draftProblems(rules).length === 0 && !!(filterStack.all?.length || filterStack.any?.length);
  const audience = useMemo(
    () => (audienceMode === "segment" ? (segmentId ? { segmentId } : null) : audienceMode === "filters" ? (rulesReady ? { filter: filterStack } : null) : null),
    [audienceMode, segmentId, rulesReady, filterStack],
  );
  const audienceLive = audienceMode === "segment" || audienceMode === "filters";
  const audiencePreview = usePreview("/api/broadcasts/audience", audienceLive && audience ? { ...audience } : null);
  const options = useKeyedApi<Options>(`/api/broadcasts/options?tags=${encodeURIComponent(effectiveTags.join(","))}`);
  const templates = useApi<{ templates: Template[] }>("/api/templates?status=approved");
  const approved = useMemo(() => templates.data?.templates.filter((t) => t.status === "approved") ?? [], [templates.data]);
  const phone = options.data?.phoneNumbers.find((p) => p.id === phoneId);
  const template = approved.find((t) => t.id === templateId);
  const preview = useMemo(() => (template ? templatePreview(template.components) : null), [template]);
  const placeholders = template ? placeholderNote(template.components) : null;
  const slots = useMemo(() => (template ? templateSlots(template.components) : []), [template]);
  const mappingProblem = slots.length ? firstMappingProblem(slots, variableMap, policy, { phoneNumberId: phoneId }) : null;
  const blocked = useMemo(() => approved.map((t) => ({ t, reason: templateBlocker(t.components) })).filter((x): x is { t: Template; reason: string } => !!x.reason), [approved]);
  const effectiveName = name.trim() || defaultBroadcastName(template?.name);
  const bounds = useMemo(() => scheduleBounds(), []);

  useEffect(() => {
    const date = new URLSearchParams(window.location.search).get("date");
    // A day picked on the calendar starts as a time that can really be scheduled (not 9:00 on a day already past 9:00).
    const at = date ? presetSchedule(date) : null;
    if (at) {
      setWhenMode("later");
      setScheduledAt(at);
    }
    // Cancel goes back to the calendar on that day's month (CampaignCalendar reads ?date=); scheduling goes back too (send).
    if (date && monthOfDateParam(date)) {
      setBackHref(`/app/broadcasts?date=${date}`);
      setFromCalendar(true);
    }
    const segment = new URLSearchParams(window.location.search).get("segment");
    if (segment && segment.length <= 100) {
      setAudienceMode("segment");
      setSegmentId(segment);
    }
  }, []);

  useEffect(() => {
    const t = approved.find((x) => x.id === templateId);
    setVariableMap(t ? defaultMap(templateSlots(t.components)) : {});
    setPolicy("skip");
    setMapTouched(false);
  }, [templateId, approved]);

  useEffect(() => {
    if (!phoneId && options.data?.phoneNumbers.length === 1) setPhoneId(options.data.phoneNumbers[0].id);
  }, [options.data, phoneId]);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);

  useEffect(() => {
    const target = refocus.current;
    if (target === null) return;
    refocus.current = null;
    if (target === "") tagInput.current?.focus();
    else (Array.from(tagList.current?.querySelectorAll<HTMLButtonElement>("button[data-tag]") ?? []).find((b) => b.dataset.tag === target) ?? tagInput.current)?.focus();
  }, [tags]);

  /** The draft made for the review step is deleted, so going back and changing a step leaves no canceled broadcast in the list. */
  async function discardDraft() {
    if (!draft) return;
    const id = draft.id;
    setDraft(null);
    setEstimate(null);
    const deleted = await apiFetch(`/api/broadcasts/${id}`, { method: "DELETE" }).then(
      () => true,
      () => false,
    );
    if (!deleted) await apiFetch(`/api/broadcasts/${id}/cancel`, { method: "POST" }).catch(() => undefined);
  }

  function goTo(target: number) {
    if (target >= step || busy) return;
    setConfirmed(false);
    setError("");
    setStep(target);
  }

  async function leave() {
    if (!draft) {
      router.push(backHref);
      return;
    }
    setBusy("leave");
    await discardDraft();
    router.push(backHref);
  }

  async function prepareReview() {
    const problem = whenMode === "later" ? validateSchedule(scheduledAt) : null;
    setScheduleError(problem);
    if (problem) return;
    setBusy("prepare");
    setError("");
    const sentMap = slots.length ? cleanMap(slots, variableMap) : undefined;
    const key = JSON.stringify([phoneId, templateId, effectiveTags, effectiveName, audience, sentMap, policy]);
    const scheduled = whenMode === "later" ? new Date(scheduledAt).toISOString() : null;
    try {
      let id = draft && draft.key === key ? draft.id : null;
      if (draft && !id) await discardDraft();
      if (id) {
        await apiFetch(`/api/broadcasts/${id}`, { method: "PATCH", body: { scheduledAt: scheduled, retryDays } });
      } else {
        const { broadcast } = await apiFetch<{ broadcast: { id: string } }>("/api/broadcasts", {
          method: "POST",
          body: { name: effectiveName, phoneNumberId: phoneId, templateId, segmentTags: effectiveTags, scheduledAt: scheduled, retryDays, audience, variableMap: sentMap, missingValuePolicy: policy },
        });
        id = broadcast.id;
        setDraft({ id, key });
      }
      setEstimate(await apiFetch<Estimate>(`/api/broadcasts/${id}/estimate`).catch(() => null));
      setConfirmed(false);
      setStep(4);
    } catch (e) {
      setError(friendlyError((e as Error).message, "We could not prepare your broadcast. Check your connection and try again."));
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    if (!draftId) return;
    const people = (estimate?.count ?? options.data?.eligibleCount ?? 0).toLocaleString();
    if (whenMode === "now") {
      const ok = await confirm({
        title: `Send to ${people} people now?`,
        body: "Messages that are sent cannot be taken back. You can pause or cancel a broadcast while it is still sending.",
        confirmLabel: "Send broadcast",
      });
      if (!ok) return;
    }
    setBusy("send");
    setError("");
    try {
      await apiFetch(`/api/broadcasts/${draftId}/start`, { method: "POST" });
      const detail = `/app/broadcasts/${draftId}`;
      // Planned from a calendar day: back to the calendar on the day it goes out, so it is in view at once (even in another
      // month). The toast opens the broadcast.
      const calendar = whenMode === "later" && fromCalendar ? calendarHrefFor(scheduledAt) : null;
      if (calendar) {
        toast.success("Broadcast scheduled", { description: `It goes out on ${formatWhen(scheduledAt)}.`, action: { label: "Open broadcast", onAction: () => router.push(detail) } });
        router.push(calendar);
        return;
      }
      toast.success(whenMode === "later" ? "Broadcast scheduled" : "Broadcast started");
      router.push(detail);
    } catch (e) {
      setError(friendlyError((e as Error).message, "We could not start your broadcast. Check your connection and try again."));
      setBusy(null);
    }
  }

  function saveDraft() {
    if (!draftId) return;
    setBusy("draft");
    toast.success("Saved as a draft", { description: "You can send it later from the broadcast page." });
    router.push(`/app/broadcasts/${draftId}`);
  }

  function addTags(values: string[]) {
    if (values.length === 0) return;
    refocus.current = "";
    setTags((prev) => [...new Set([...prev, ...values])]);
    setTagText("");
    tagInput.current?.focus();
  }

  function removeTag(tag: string) {
    const i = tags.indexOf(tag);
    refocus.current = tags[i + 1] ?? tags[i - 1] ?? "";
    setTags(tags.filter((x) => x !== tag));
  }

  if (role && !canManage(role)) {
    return (
      <div>
        <PageHeader title="New broadcast" breadcrumbs={BACK_TO_LIST} />
        <EmptyState title="Only owners and admins can create broadcasts" body="Ask an owner or admin of your workspace to set one up. You can still see how every broadcast is doing." action={<LinkButton href="/app/broadcasts">Back to broadcasts</LinkButton>} />
      </div>
    );
  }
  if ((!options.data && !options.error) || (templates.loading && !templates.data)) return <PageSkeleton />;
  if (!options.data || !templates.data) {
    return (
      <div>
        <PageHeader title="New broadcast" breadcrumbs={BACK_TO_LIST} />
        <ErrorState
          title="We could not open the broadcast form"
          message={`${friendlyError(options.error ?? templates.error, "Something went wrong on our side.")} Check your connection and try again.`}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                options.retry();
                templates.reload();
              }}
            >
              Try again
            </Button>
          }
        />
      </div>
    );
  }
  if (options.data.phoneNumbers.length === 0) {
    return (
      <div>
        <PageHeader title="New broadcast" breadcrumbs={BACK_TO_LIST} />
        <EmptyState title="Connect a WhatsApp number first" body="Broadcasts are sent from a WhatsApp number linked to your workspace. Once it is connected you can come back here." action={<LinkButton href="/app">Go to setup</LinkButton>} />
      </div>
    );
  }
  if (approved.length === 0) {
    return (
      <div>
        <PageHeader title="New broadcast" breadcrumbs={BACK_TO_LIST} />
        <EmptyState
          title="You need an approved template first"
          body="WhatsApp only lets you message many people with a template that Meta has approved. Create one, submit it, and come back once it is approved."
          action={<LinkButton href="/app/templates">Go to templates</LinkButton>}
        />
      </div>
    );
  }

  const tagsMissing = audienceMode === "tags" && tags.length === 0;
  const pendingText = audienceMode === "tags" ? tagText : "";
  const segmentChosen = audienceMode !== "segment" || !!segmentId;
  const counting = audienceLive ? !!audience && audiencePreview.pending : options.stale;
  const countFailed = audienceLive ? !!audience && !!audiencePreview.error : !!options.error;
  const eligible = audienceLive ? (audience ? (audiencePreview.preview?.count ?? 0) : 0) : tagsMissing ? 0 : options.data.eligibleCount;
  const chosenSegmentName = [...options.data.segments, ...options.data.presets].find((x) => x.id === segmentId)?.name;
  const audienceText = audienceMode === "segment" ? `Segment: ${chosenSegmentName ?? "chosen segment"}` : audienceMode === "filters" ? summarizeFilter(filterStack) : null;
  const quality = qualityWarning(phone?.qualityRating);
  const audienceReady = !!phoneId && !tagsMissing && segmentChosen && (audienceMode !== "filters" || rulesReady) && !counting && !countFailed && !pendingText.trim() && eligible > 0;
  const unsupported = template ? templateBlocker(template.components) : null;
  const messageReady = !!template && !unsupported && !mappingProblem;
  const cost = costSummary(estimate?.cost);
  const costLines = (estimate?.cost.lines ?? []).slice(0, 12);
  const missingCount = estimate?.coverage?.contactsMissing ?? 0;
  const sending = estimate?.sending;
  const sendingText = sending
    ? `${sending.limit === null ? "Your WhatsApp account has no daily limit on how many different people it can message." : `Your WhatsApp account can message up to ${sending.limit.toLocaleString()} different people in any 24 hours, shared by all your numbers.`} ${sending.used.toLocaleString()} already messaged in the last 24 hours.${sending.days > 1 ? ` At this pace everyone is reached in about ${sending.days} days; sending carries on by itself.` : ""}`
    : `${tierSummary(phone?.portfolioTier ?? phone?.messagingLimitTier)} If your audience is bigger, sending carries on automatically over several days.`;
  const reviewCount = (estimate?.count ?? eligible).toLocaleString();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const whenText = whenMode === "later" ? scheduleSummary(scheduledAt) : scheduleSummary("");
  const stepTitle = WIZARD_STEPS[step - 1];
  const line = audienceLine({ phoneChosen: !!phoneId, mode: audienceMode, tagCount: tags.length, pendingText, counting, eligible, segmentChosen, rulesReady });
  const hint =
    countFailed && step === 1
      ? "We could not count the people. Try again to continue."
      : wizardHint({ step, phoneChosen: !!phoneId, mode: audienceMode, tagCount: tags.length, pendingText, counting, eligible, hasTemplate: !!template, templateUnsupported: !!unsupported, confirmed, segmentChosen, rulesReady, mappingProblem });

  return (
    <div>
      <PageHeader title="New broadcast" description="Four short steps. Nothing is sent until you press Send on the last one." breadcrumbs={BACK_TO_LIST} />
      <Stepper current={step} onGo={goTo} disabled={busy !== null} />

      <Card className="max-w-2xl">
        <h2 ref={heading} tabIndex={-1} className="mb-4 text-lg font-semibold tracking-tight outline-none">
          {step}. {stepTitle}
        </h2>

        {step === 1 && (
          <div className="space-y-5">
            {options.data.phoneNumbers.length > 1 ? (
              <FormField label="Send from" hint="The WhatsApp number your contacts will see." required>
                <Select value={phoneId} onChange={(e) => setPhoneId(e.target.value)}>
                  <option value="">Choose a number</option>
                  {options.data.phoneNumbers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayPhone}
                      {p.verifiedName ? ` (${p.verifiedName})` : ""}
                    </option>
                  ))}
                </Select>
              </FormField>
            ) : (
              <p className="text-sm">
                <span className="text-muted">Sending from </span>
                <span className="font-medium">{options.data.phoneNumbers[0].displayPhone}</span>
                {options.data.phoneNumbers[0].verifiedName && <span className="text-muted"> ({options.data.phoneNumbers[0].verifiedName})</span>}
              </p>
            )}

            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">Who should get this message?</legend>
              <ChoiceCard name="audience" value="all" checked={audienceMode === "all"} onChange={() => setAudienceMode("all")} title="Everyone who opted in" description="All contacts who agreed to receive messages from you." />
              <ChoiceCard name="audience" value="tags" checked={audienceMode === "tags"} onChange={() => setAudienceMode("tags")} title="Only contacts with certain tags" description="For example customers, vip or pune.">
                <div className="flex items-start gap-2">
                  <FormField label="Add a tag" hint="Contacts with any of the tags you add will get the message." className="min-w-0 flex-1">
                    <Input
                      ref={tagInput}
                      value={tagText}
                      onChange={(e) => setTagText(e.target.value)}
                      list="known-tags"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addTags(parseTagInput(tagText));
                        }
                      }}
                    />
                  </FormField>
                  <datalist id="known-tags">
                    {options.data.tags.map((t) => (
                      <option key={t} value={t} />
                    ))}
                  </datalist>
                  <Button type="button" variant="secondary" className="mt-[1.625rem]" disabled={!tagText.trim()} onClick={() => addTags(parseTagInput(tagText))}>
                    Add
                  </Button>
                </div>
                {options.data.tags.filter((t) => !tags.includes(t)).length > 0 && (
                  <div className="mt-3">
                    <p className="mb-1 text-xs text-muted">Your tags</p>
                    <ul className="flex flex-wrap gap-2" aria-label="Suggested tags">
                      {options.data.tags
                        .filter((t) => !tags.includes(t))
                        .slice(0, 12)
                        .map((t) => (
                          <li key={t}>
                            <button type="button" onClick={() => addTags([t])} className="min-h-8 rounded-full border border-border-strong bg-raised px-3 text-xs hover:bg-surface-2" aria-label={`Add tag ${t}`}>
                              + {t}
                            </button>
                          </li>
                        ))}
                    </ul>
                  </div>
                )}
                <div className="mt-3">
                  <ul ref={tagList} className="flex flex-wrap gap-2" aria-label="Chosen tags">
                    {tags.map((t) => (
                      <li key={t}>
                        <button type="button" data-tag={t} className="min-h-8 rounded-full border border-accent bg-accent-soft px-3 text-xs text-accent-ink hover:bg-surface-2" onClick={() => removeTag(t)} aria-label={`Remove tag ${t}`}>
                          {t} <span aria-hidden>&times;</span>
                        </button>
                      </li>
                    ))}
                    {tags.length === 0 && <li className="text-sm text-muted">No tags chosen yet.</li>}
                  </ul>
                </div>
              </ChoiceCard>
              <ChoiceCard name="audience" value="segment" checked={audienceMode === "segment"} onChange={() => setAudienceMode("segment")} title="A saved segment" description="A group you saved, like Delhi customers, or a ready-made one like Recently active.">
                <SegmentPicker value={segmentId} onChange={setSegmentId} segments={options.data.segments} presets={options.data.presets} />
              </ChoiceCard>
              <ChoiceCard name="audience" value="filters" checked={audienceMode === "filters"} onChange={() => setAudienceMode("filters")} title="Contacts that match rules" description="Combine details like city, tags and when they last wrote to you.">
                <FilterBuilder value={rules} onChange={setRules} attributeKeys={options.data.attributeKeys} tags={options.data.tags} idPrefix="wizard-rules" />
              </ChoiceCard>
            </fieldset>

            <div role="status" aria-live="polite">
              {countFailed ? (
                <Alert
                  tone="warn"
                  title="We could not count the people"
                  action={
                    <Button size="sm" variant="secondary" onClick={audienceLive ? audiencePreview.retry : options.retry}>
                      Try again
                    </Button>
                  }
                >
                  Check your connection and try again.
                </Alert>
              ) : line.kind === "none" ? (
                <Alert
                  tone="warn"
                  title="No one matches yet"
                  action={
                    <LinkButton href="/app/contacts" variant="secondary" size="sm">
                      Add contacts
                    </LinkButton>
                  }
                >
                  Marketing messages go only to contacts who opted in. {audienceMode === "tags" ? "Try different tags, or " : "Add contacts and record that they opted in, then "}come back here.
                </Alert>
              ) : (
                <div className={cn("rounded-control bg-surface p-3 text-sm", line.kind !== "count" && "text-muted")}>
                  <p>{line.text}</p>
                  {audienceLive && audiencePreview.preview && audiencePreview.preview.sample.length > 0 && line.kind === "count" && (
                    <p className="mt-1 text-xs text-muted">For example: {audiencePreview.preview.sample.map((x) => displayName(x)).join(", ")}</p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <FormField label="Template" required hint="Only templates that Meta approved are listed. Need a new one? Create it under Templates.">
              <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">Choose a template</option>
                {approved.map((t) => {
                  const off = blocked.some((x) => x.t.id === t.id);
                  return (
                    <option key={t.id} value={t.id} disabled={off}>
                      {humanizeName(t.name)} ({languageName(t.language)}, {categoryLabel(t.category)})
                      {off ? " - not available for broadcasts" : ""}
                    </option>
                  );
                })}
              </Select>
            </FormField>
            {blocked.length > 0 && (
              <details className="rounded-control border border-border p-3 text-sm">
                <summary className="min-h-8 cursor-pointer font-medium">
                  Why {blocked.length === 1 ? "1 template is" : `${blocked.length} templates are`} not available
                </summary>
                <ul className="mt-2 space-y-1">
                  {blocked.map(({ t, reason }) => (
                    <li key={t.id}>
                      <span className="font-medium">{humanizeName(t.name)}</span> ({languageName(t.language)}): <span className="text-muted">{reason}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {preview && <TemplateBubble preview={preview} />}
            {slots.length === 0 && placeholders && <Alert tone="info">{placeholders}</Alert>}
            {slots.length > 0 && (
              <VariableMapping
                slots={slots}
                map={variableMap}
                onChange={(next) => (setMapTouched(true), setVariableMap(next))}
                policy={policy}
                onPolicyChange={(next) => (setMapTouched(true), setPolicy(next))}
                attributeKeys={options.data.attributeKeys}
                phoneNumberId={phoneId}
                showProblems={mapTouched}
              />
            )}
            {template?.category === "MARKETING" && <Alert tone="info">This is a marketing template, so it goes only to contacts who opted in to receive marketing messages.</Alert>}
            {unsupported && <Alert tone="warn">{unsupported}</Alert>}
            <FormField label="Broadcast name" optional hint={`Only you see this. Leave it empty to use "${effectiveName}".`}>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder={effectiveName} />
            </FormField>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">When should it go out?</legend>
              <ChoiceCard name="when" value="now" checked={whenMode === "now"} onChange={() => (setWhenMode("now"), setScheduleError(null))} title="As soon as I press Send" description="Sending starts right away on the last step." />
              <ChoiceCard name="when" value="later" checked={whenMode === "later"} onChange={() => setWhenMode("later")} title="At a date and time I choose" description="We send it for you, even if you are not signed in.">
                <FormField label="Date and time" required error={scheduleError} hint={`Up to 90 days ahead. Your time zone is ${timeZone}.`}>
                  <Input type="datetime-local" value={scheduledAt} min={bounds.min} max={bounds.max} onChange={(e) => (setScheduledAt(e.target.value), setScheduleError(null))} />
                </FormField>
              </ChoiceCard>
            </fieldset>

            <details className="rounded-control border border-border p-3">
              <summary className="min-h-8 cursor-pointer text-sm font-medium">More options</summary>
              <div className="mt-3">
                <FormField label="Try again for people WhatsApp held back" hint="WhatsApp sometimes holds back marketing messages to people who already received many. We can try those again once a day. Other failures are never retried.">
                  <Select value={String(retryDays)} onChange={(e) => setRetryDays(Number(e.target.value))}>
                    <option value="0">Do not try again</option>
                    {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                      <option key={d} value={d}>
                        For up to {d} day{d === 1 ? "" : "s"}
                      </option>
                    ))}
                  </Select>
                </FormField>
              </div>
            </details>

            {error && <Alert tone="bad">{error}</Alert>}
          </div>
        )}

        {step === 4 && (
          <div className="space-y-5">
            <p className="text-base" aria-live="polite">
              <strong>{reviewCount}</strong> {reviewCount === "1" ? "person" : "people"} will get <strong>{template ? humanizeName(template.name) : "your template"}</strong>{" "}
              {whenMode === "later" ? `on ${formatWhen(scheduledAt)}` : "right after you press Send"}.
            </p>

            <dl className="divide-y divide-border rounded-control border border-border px-4">
              <SummaryRow label="Who" onChange={() => goTo(1)} changeLabel="Change who gets it">
                {audienceLabel(effectiveTags, audienceText)}: {reviewCount} {reviewCount === "1" ? "person" : "people"}
              </SummaryRow>
              <SummaryRow label="From">
                {phone?.displayPhone}
                {phone?.verifiedName ? ` (${phone.verifiedName})` : ""}
              </SummaryRow>
              <SummaryRow label="Message" onChange={() => goTo(2)} changeLabel="Change the message">
                {template ? `${humanizeName(template.name)} (${languageName(template.language)})` : ""}
                {preview && (
                  <details className="mt-1 text-sm">
                    <summary className="min-h-8 cursor-pointer text-accent-ink">See the message</summary>
                    <div className="mt-2">
                      <TemplateBubble preview={preview} />
                    </div>
                  </details>
                )}
              </SummaryRow>
              <SummaryRow label="Name" onChange={() => goTo(2)} changeLabel="Change the broadcast name">
                {effectiveName}
              </SummaryRow>
              <SummaryRow label="When" onChange={() => goTo(3)} changeLabel="Change when it goes out">
                {whenText}
              </SummaryRow>
              <SummaryRow label="Retries">{retrySummary(retryDays)}</SummaryRow>
              <SummaryRow label="Estimated cost">
                <span data-testid="cost-estimate" className="font-medium">
                  {cost.headline}
                </span>
                <span className="mt-1 block text-xs text-muted">{cost.note}</span>
                {costLines.length > 0 && (
                  <details className="mt-1 text-sm">
                    <summary className="min-h-8 cursor-pointer text-accent-ink">Cost by country</summary>
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {costLines.map((l) => (
                        <li key={l.country ?? "other"}>
                          {l.country ?? "Other"}: {l.count.toLocaleString()} {l.count === 1 ? "person" : "people"}, {l.totalMinor === null ? "no price set" : formatMinor(l.totalMinor, estimate?.cost.currency)}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </SummaryRow>
            </dl>

            {missingCount > 0 && (
              <Alert tone={policy === "fail" ? "bad" : "warn"} title="Some contacts are missing a value">
                <p>{policyNote(policy, missingCount)}</p>
                {estimate?.coverage && estimate.coverage.total > estimate.coverage.checked && <p className="mt-1 text-xs">Checked the first {estimate.coverage.checked.toLocaleString()} of {estimate.coverage.total.toLocaleString()} people.</p>}
              </Alert>
            )}

            {estimate?.limitWarning && (
              <Alert tone="warn" title="WhatsApp spending limit">
                <p data-testid="limit-warning">{estimate.limitWarning}</p>
              </Alert>
            )}

            <Alert tone={quality ? "warn" : "info"} title="Sending limits">
              <p>{sendingText}</p>
              {estimate?.sending?.hint && <p className="mt-1">{estimate.sending.hint}</p>}
              {quality && <p className="mt-1 font-medium">{quality}</p>}
            </Alert>

            <label className="flex min-h-10 cursor-pointer items-start gap-3 text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-accent" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>I confirm that everyone in this audience agreed to receive these messages on WhatsApp.</span>
            </label>

            {error && <Alert tone="bad">{error}</Alert>}
          </div>
        )}

        <p id={HINT_ID} role="status" className="mt-4 min-h-4 text-xs text-muted">
          {hint}
        </p>
        <div className="mt-2 flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          {step > 1 ? (
            <Button variant="secondary" className={navButton} disabled={busy !== null} onClick={() => goTo(step - 1)}>
              Back
            </Button>
          ) : (
            <LinkButton
              href={backHref}
              variant="ghost"
              className={navButton}
              onClick={(e) => {
                if (!draft) return;
                e.preventDefault();
                void leave();
              }}
            >
              Cancel
            </LinkButton>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            {step === 4 && (
              <Button variant="secondary" className={navButton} loading={busy === "draft"} disabled={busy !== null} onClick={saveDraft}>
                Save as draft
              </Button>
            )}
            {step < 3 && (
              <Button className={navButton} disabled={step === 1 ? !audienceReady : !messageReady} aria-describedby={HINT_ID} onClick={() => setStep(step + 1)}>
                Next: {WIZARD_STEPS[step]}
              </Button>
            )}
            {step === 3 && (
              <Button className={navButton} loading={busy === "prepare"} disabled={busy !== null} onClick={() => void prepareReview()}>
                Next: Review
              </Button>
            )}
            {step === 4 && (
              <Button className={navButton} loading={busy === "send"} disabled={!confirmed || busy !== null} aria-describedby={HINT_ID} onClick={() => void send()}>
                {whenMode === "later" ? "Schedule broadcast" : "Send broadcast"}
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
