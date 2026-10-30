"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Card, EmptyState, ErrorState, FormField, Input, Select, Skeleton, Textarea, apiFetch, confirm, toast } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { canManage, useApi, useRole } from "@/components/contacts/hooks";
import { formatCopyDate } from "@/lib/spend/copy";
import { formatMinor as formatMoney } from "@/lib/spend/money";
import { dayKey } from "@/lib/spend/periods";
import { ceil175, NO_SPEND, remainingMonth } from "@/lib/spend/worstcase";
import { LinkButton } from "./LinkButton";
import { BudgetSummary, CategoryGuidance, Stepper, SummaryRow, TermsAckBox, checkboxClass, optionRowClass } from "./wizard-parts";
import {
  CATEGORY_LABELS,
  MAX_ADS,
  PLACEMENTS,
  adTextReady,
  buildAdList,
  activeBudgetElsewhere,
  budgetRoom,
  TEMPLATE_LABELS,
  categoryName,
  checkBudget,
  formatMinor,
  friendlyAdsError,
  isCategoryTermsMismatch,
  META_LOGIN_FIX,
  parseCountries,
  pictureCovered,
  pictureLinkError,
  pictureReady,
  parseInterests,
  toMinor,
  typedTotalMatches,
} from "./helpers";

type Asset = { id: string; externalId: string; name: string | null; currency: string | null; timezone?: string | null; planBlocked?: boolean };
type Options = {
  adAccounts: Asset[];
  pages: Asset[];
  instagram: Asset[];
  phoneNumbers: { id: string; displayPhone: string; verifiedName: string | null }[];
  creativeAssets: { id: string; kind: string; headline: string | null; body: string | null; status?: string; hasImage?: boolean; blocked?: boolean }[];
  suggestedSpecialAdCategory: string;
  caps: { maxDailyBudgetMinor: number | null; currency: string | null };
};
type Preview = { payload: unknown; totalDailyBudgetMinor: number; currency: string; errors: string[]; caps: Options["caps"] };

const STEPS = ["Goal", "Budget", "Audience", "Ad", "Review"];


const checkbox = checkboxClass;
const optionRow = optionRowClass;
type CampaignRow = { status: string; currency: string; totalDailyBudgetMinor: number };

const DEFAULT_ZONE = "Asia/Kolkata";

/**
 * The end date the wizard starts with: the last day of the current month, 23:59, as a datetime-local value
 * (docs/SPEND-CONTROLS-SPEC.md 8.2). People can move it, or choose "No end date".
 */
export function monthEndInput(now: Date): string {
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${last.getFullYear()}-${pad(last.getMonth() + 1)}-${pad(last.getDate())}T23:59`;
}

export type WorstCaseInput = { budgetMinor: number; currency: string; startsAt: Date | null; endsAt: Date | null; now: Date; timeZone?: string | null };

/**
 * What Meta could spend for this budget (docs/SPEND-CONTROLS-SPEC.md 4.5, 8.2): up to 1.75x the daily budget on a busy day, and
 * by the end date (or the end of the month) the same amount the Spend Book sets aside when the campaign is turned on. Counted
 * in the ad account's time zone, from the start date when that is later than now.
 */
export function wizardWorstCase(input: WorstCaseInput): { busyDayMinor: bigint; monthMinor: bigint; endsThisMonth: boolean } {
  const zone = input.timeZone || DEFAULT_ZONE;
  const from = input.startsAt && input.startsAt.getTime() > input.now.getTime() ? input.startsAt : input.now;
  const d = BigInt(Math.max(0, Math.floor(input.budgetMinor)));
  const monthMinor = remainingMonth({ dailyBudgetMinor: d, lifetimeBudgetMinor: null, peakToday: d, weekPeak: d, endsAt: input.endsAt }, from, zone, NO_SPEND);
  const endsThisMonth = !!input.endsAt && dayKey(input.endsAt, zone).slice(0, 7) === dayKey(from, zone).slice(0, 7);
  return { busyDayMinor: ceil175(d), monthMinor, endsThisMonth };
}

/** The plain lines of the budget step: "Meta may spend up to ₹1,750 on a busy day." and what that means by the end date. */
export function worstCaseLines(input: WorstCaseInput): string[] {
  const zone = input.timeZone || DEFAULT_ZONE;
  const w = wizardWorstCase(input);
  const money = (minor: bigint) => formatMoney(minor, input.currency);
  const busy = `Meta may spend up to ${money(w.busyDayMinor)} on a busy day.`;
  if (!input.endsAt) return [busy, `Without an end date we set money aside until the end of each month: up to ${money(w.monthMinor)} this month.`];
  const date = formatCopyDate(input.endsAt, zone) ?? "your end date";
  return [
    busy,
    w.endsThisMonth
      ? `With an end date of ${date} this campaign could use up to ${money(w.monthMinor)} of your monthly limit.`
      : `With an end date of ${date} this campaign could use up to ${money(w.monthMinor)} of this month's limit. We set the rest aside at the start of each month until then.`,
  ];
}

/** The worst-case lines as a polite status region, so a screen reader hears them change with the budget and the dates. */
export function WorstCaseNote(props: WorstCaseInput) {
  const lines = worstCaseLines(props);
  return (
    <Alert tone="info" title="What Meta could spend">
      <div data-testid="worst-case" className="space-y-1 [overflow-wrap:anywhere]">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    </Alert>
  );
}

function StepForm({ ready, onNext, children }: { ready: boolean; onNext: () => void; children: ReactNode }) {
  return (
    <form
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (ready) onNext();
      }}
    >
      {children}
    </form>
  );
}

function StepNav({ onBack, next, ready, missing, loading }: { onBack?: () => void; next: string; ready: boolean; missing?: string; loading?: boolean }) {
  return (
    <div className="mt-6 border-t border-border pt-4">
      {!ready && missing && (
        <p className="mb-3 text-sm text-muted" role="status">
          {missing}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {onBack ? (
          <Button type="button" variant="secondary" onClick={onBack} disabled={loading}>
            Back
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" disabled={!ready} loading={loading}>
          {next}
        </Button>
      </div>
    </div>
  );
}

export function CampaignWizard() {
  const router = useRouter();
  const role = useRole();
  const options = useApi<Options>("/api/ads/options");
  const existing = useApi<{ campaigns: CampaignRow[] }>("/api/ads/campaigns");
  const [step, setStep] = useState(1);
  const [template, setTemplate] = useState("");
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState("");
  const [budgetText, setBudgetText] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState(() => monthEndInput(new Date()));
  const [noEnd, setNoEnd] = useState(false);
  const [category, setCategory] = useState("");
  const [noneConfirmed, setNoneConfirmed] = useState(false);
  const [termsAck, setTermsAck] = useState(false);
  const [termsMismatch, setTermsMismatch] = useState(false);
  const [countries, setCountries] = useState("IN");
  const [ageMin, setAgeMin] = useState("18");
  const [ageMax, setAgeMax] = useState("65");
  const [gender, setGender] = useState("all");
  const [interests, setInterests] = useState("");
  const [placements, setPlacements] = useState<string[]>([]);
  const [pageId, setPageId] = useState("");
  const [instagramId, setInstagramId] = useState("");
  const [creativeIds, setCreativeIds] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [headline, setHeadline] = useState("");
  const [link, setLink] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [leadFormId, setLeadFormId] = useState("");
  const [whatsappNumberId, setWhatsappNumberId] = useState("");
  const [welcomeMessage, setWelcomeMessage] = useState("");
  const [postId, setPostId] = useState("");
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [adjustments, setAdjustments] = useState<string[]>([]);
  const [typedTotal, setTypedTotal] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);
  const leaving = useRef(false);
  const hasDraft = useRef(false);
  const dirty = !!(template || name.trim() || budgetText.trim() || message.trim() || postId.trim() || campaignId);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      if (leaving.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    const onLinkClick = (e: MouseEvent) => {
      if (leaving.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      e.preventDefault();
      e.stopPropagation();
      void confirm({
        title: "Leave this campaign?",
        body: hasDraft.current ? "Your answers up to the review step are kept as a draft on the Ad campaigns page." : "Your answers have not been saved. If you leave now, you will need to start again.",
        confirmLabel: "Leave",
        tone: "danger",
      }).then((ok) => {
        if (!ok) return;
        leaving.current = true;
        router.push(`${url.pathname}${url.search}${url.hash}`);
      });
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", onLinkClick, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", onLinkClick, true);
    };
  }, [dirty, router]);

  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    heading.current?.focus();
    window.scrollTo({ top: 0 });
  }, [step]);

  const opts = options.data;
  const preselected = useRef(false);

  // The creative workspace links here with ?creatives=id1,id2 to start an A/B test from the chosen items.
  useEffect(() => {
    if (!opts || preselected.current) return;
    preselected.current = true;
    try {
      const wanted = (new URLSearchParams(window.location.search).get("creatives") ?? "").split(",").filter(Boolean);
      const ids = opts.creativeAssets.filter((a) => !a.blocked && wanted.includes(a.id)).map((a) => a.id).slice(0, MAX_ADS);
      if (ids.length) setCreativeIds(ids);
    } catch {
      /* the link is optional */
    }
  }, [opts]);

  const account = opts?.adAccounts.find((a) => a.id === accountId);
  const capCurrency = opts?.caps.currency ?? null;
  const currency = account?.currency ?? capCurrency ?? "INR";
  const capMinor = opts?.caps.maxDailyBudgetMinor ?? null;
  const capApplies = capMinor !== null && (capCurrency === null || capCurrency === currency);
  const currencyMismatch = capMinor !== null && capCurrency !== null && capCurrency !== currency;
  const budgetMinor = toMinor(budgetText, currency);
  const budgetCheck = checkBudget(budgetText, currency, capApplies ? capMinor : null);
  const usedMinor = existing.data && capApplies ? activeBudgetElsewhere(existing.data.campaigns, currency) : null;
  const room = budgetRoom(budgetMinor, capApplies ? capMinor : null, usedMinor);
  const restricted = category !== "" && category !== "none";
  const suggested = opts?.suggestedSpecialAdCategory ?? "none";
  const categoryReady = category !== "" && (category !== "none" || suggested === "none" || noneConfirmed);
  const endsAtDate = !noEnd && endsAt ? new Date(endsAt) : null;
  const datesError = startsAt && endsAtDate && endsAtDate <= new Date(startsAt) ? "Choose an end that is after the start." : null;
  const parsedCountries = parseCountries(countries);
  const min = Number(ageMin);
  const max = Number(ageMax);
  const ageError = restricted ? null : ageMin === "" || ageMax === "" || !Number.isInteger(min) || !Number.isInteger(max) ? "Enter whole numbers for both ages." : min < 13 || max > 65 ? "Ages must be between 13 and 65." : min > max ? "The minimum age cannot be higher than the maximum." : null;
  const countriesError = parsedCountries.invalid.length ? `These are not country codes: ${parsedCountries.invalid.join(", ")}. Use two letters, like IN.` : parsedCountries.codes.length === 0 ? "Add at least one country, like IN." : null;

  if (role !== null && !canManage(role)) {
    return (
      <div>
        <PageHeader title="New campaign" breadcrumbs={[{ label: "Ad campaigns", href: "/app/ads" }, { label: "New campaign" }]} />
        <EmptyState title="Only owners and admins can create campaigns" body="Ask an owner or admin of your workspace to create it, or to give you access." />
      </div>
    );
  }
  if (options.loading && !opts) {
    return (
      <div aria-busy="true">
        <span className="sr-only" role="status">Loading</span>
        <Skeleton className="mb-2 h-8 w-48" />
        <Skeleton className="mb-6 h-4 w-80 max-w-full" />
        <Card className="max-w-2xl space-y-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </Card>
      </div>
    );
  }
  if (options.error || !opts) {
    return (
      <div>
        <PageHeader title="New campaign" breadcrumbs={[{ label: "Ad campaigns", href: "/app/ads" }, { label: "New campaign" }]} />
        <ErrorState title="We could not start the campaign setup" message="Check your connection and try again." action={<Button variant="secondary" onClick={options.retry}>Try again</Button>} />
      </div>
    );
  }
  if (opts.adAccounts.length === 0) {
    return (
      <div>
        <PageHeader title="New campaign" breadcrumbs={[{ label: "Ad campaigns", href: "/app/ads" }, { label: "New campaign" }]} />
        <EmptyState
          title="Connect your ad account first"
          body="Campaigns run in your Meta ad account. Connect it once, then come back here to create your first campaign."
          action={<LinkButton href="/app/settings/connections">Connect ad account</LinkButton>}
        />
      </div>
    );
  }

  const pickedAssets = opts.creativeAssets.filter((a) => creativeIds.includes(a.id));
  const abTest = pickedAssets.length > 1;

  const step1Ready = !!template && !!name.trim() && !!accountId;
  const step2Ready = budgetCheck.state === "ok" && budgetMinor !== null && categoryReady && !datesError;
  const step3Ready = !countriesError && !ageError;
  const step4Ready = !!pageId && (template === "boost_post" ? !!postId.trim() : adTextReady(message, pickedAssets) && pictureReady(imageUrl, pickedAssets)) && (template !== "lead_generation" || !!leadFormId.trim()) && (template !== "click_to_whatsapp" || !!whatsappNumberId) && (template !== "traffic" || !!link.trim());
  const reviewUsed = preview && existing.data ? activeBudgetElsewhere(existing.data.campaigns, preview.currency) : null;
  const reviewCapApplies = !!preview && preview.caps.maxDailyBudgetMinor !== null && (!preview.caps.currency || preview.caps.currency === preview.currency);
  const reviewRoom = preview && reviewCapApplies ? budgetRoom(preview.totalDailyBudgetMinor, preview.caps.maxDailyBudgetMinor, reviewUsed) : null;
  const typedOk = preview ? typedTotalMatches(typedTotal, preview.totalDailyBudgetMinor, preview.currency) : false;

  const adList = () =>
    buildAdList({
      campaignName: name.trim(),
      picked: pickedAssets,
      shared: { pageId, instagramId, link, imageUrl: imageUrl.trim(), leadFormId, whatsappNumberId, welcomeMessage, postId },
      message,
      headline,
    });

  function toggleCreative(id: string) {
    const next = creativeIds.includes(id) ? creativeIds.filter((x) => x !== id) : creativeIds.length < MAX_ADS ? [...creativeIds, id] : creativeIds;
    setCreativeIds(next);
    const only = next.length === 1 ? opts?.creativeAssets.find((a) => a.id === next[0]) : undefined;
    if (only?.body) setMessage(only.body);
    if (only?.headline) setHeadline(only.headline);
  }

  function body() {
    return {
      name: name.trim(),
      template,
      adAccountAssetId: accountId,
      dailyBudgetMinor: budgetMinor,
      startsAt: startsAt ? new Date(startsAt).toISOString() : null,
      endsAt: endsAtDate ? endsAtDate.toISOString() : null,
      specialAdCategory: category,
      confirmNoSpecialCategory: category === "none" && noneConfirmed,
      acknowledgeSpecialCategoryTerms: category === "none" && termsAck,
      targeting: {
        geo: { countries: parsedCountries.codes, cities: [] },
        ageMin: restricted ? 18 : min,
        ageMax: restricted ? 65 : max,
        genders: gender === "all" ? [] : [gender],
        interests: parseInterests(interests),
        placements,
      },
      ads: adList(),
    };
  }

  async function toReview() {
    setBusy(true);
    setProblem("");
    setTermsMismatch(false);
    try {
      const draft = await apiFetch<{ campaignId: string; adjustments: string[] }>("/api/ads/campaigns", { method: "POST", body: body() });
      if (campaignId && campaignId !== draft.campaignId) void apiFetch(`/api/ads/campaigns/${campaignId}/archive`, { method: "POST" }).catch(() => undefined);
      hasDraft.current = true;
      setCampaignId(draft.campaignId);
      setAdjustments(draft.adjustments);
      setPreview(await apiFetch<Preview>(`/api/ads/campaigns/${draft.campaignId}/preview`));
      setTypedTotal("");
      setStep(5);
    } catch (e) {
      const raw = (e as Error).message;
      if (isCategoryTermsMismatch(raw)) setTermsMismatch(true);
      setProblem(friendlyAdsError(raw));
    } finally {
      setBusy(false);
    }
  }

  async function launch() {
    if (!campaignId) return;
    setBusy(true);
    setProblem("");
    try {
      await apiFetch(`/api/ads/campaigns/${campaignId}/launch`, { method: "POST", body: category === "none" && termsAck ? { acknowledgeSpecialCategoryTerms: true } : undefined });
      leaving.current = true;
      toast.success("Campaign created on Meta and paused. Nothing is spent yet.");
      router.push(`/app/ads/${campaignId}`);
    } catch (e) {
      const raw = (e as Error).message;
      if (isCategoryTermsMismatch(raw)) setTermsMismatch(true);
      setProblem(friendlyAdsError(raw));
      setBusy(false);
    }
  }

  const togglePlacement = (key: string) => setPlacements((cur) => (cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key]));
  const go = (n: number) => () => {
    setProblem("");
    setTermsMismatch(false);
    setTermsAck(false);
    setTypedTotal("");
    setStep(n);
  };
  const leaveToDraft = () => {
    leaving.current = true;
    router.push(campaignId ? `/app/ads/${campaignId}` : "/app/ads");
  };

  const accountLabel = account ? `${account.name ?? "Ad account"}${account.currency ? ` (${account.currency})` : ""}` : "";
  const stepTitle: Record<number, string> = {
    1: "What should this campaign do?",
    2: "Set your budget",
    3: "Who should see it?",
    4: "Write your ad",
    5: "Check everything",
  };

  return (
    <div>
      <PageHeader
        title="New campaign"
        breadcrumbs={[{ label: "Ad campaigns", href: "/app/ads" }, { label: "New campaign" }]}
        description="Answer a few questions. The campaign is created paused, and nothing is spent until you activate it yourself."
      />
      <Stepper steps={STEPS} current={step} />

      <Card className="max-w-3xl">
        <h2 ref={heading} tabIndex={-1} className="mb-4 text-lg font-semibold tracking-tight outline-none">
          {stepTitle[step]}
        </h2>

        {step === 1 && (
          <StepForm ready={!!step1Ready} onNext={go(2)}>
            <div className="space-y-5">
              <fieldset>
                <legend className="mb-2 text-sm font-medium">
                  Pick a goal<span aria-hidden className="ml-0.5 text-bad-fg">*</span>
                </legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {Object.entries(TEMPLATE_LABELS).map(([key, t]) => (
                    <label key={key} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-card border border-border-strong bg-raised p-3 text-sm hover:bg-surface-2 has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring">
                      <input type="radio" name="template" className={checkbox} checked={template === key} onChange={() => setTemplate(key)} required />
                      <span>
                        <span className="block font-semibold">{t.title}</span>
                        <span className="mt-0.5 block text-muted">{t.body}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <FormField label="Campaign name" required hint="Only you see this. Something like Diwali offer or New clinic.">
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="off" />
              </FormField>
              <FormField label="Ad account" required hint={opts.adAccounts.some((a) => a.planBlocked) ? "Where Meta charges the cost of your ads. Your plan covers a limited number of ad accounts: the ones marked cannot start new campaigns until you upgrade." : "Where Meta charges the cost of your ads."}>
                <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  <option value="">Choose an ad account</option>
                  {opts.adAccounts.map((a) => (
                    <option key={a.id} value={a.id} disabled={a.planBlocked}>
                      {a.name ?? "Ad account"} {a.currency ? `(${a.currency})` : ""}
                      {a.planBlocked ? " - not in your plan" : ""}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>
            <StepNav next="Continue to budget" ready={!!step1Ready} missing="Pick a goal, name your campaign and choose an ad account to continue." />
          </StepForm>
        )}

        {step === 2 && (
          <StepForm ready={step2Ready} onNext={go(3)}>
            <div className="space-y-5">
              <BudgetSummary budgetMinor={budgetMinor} capMinor={capApplies ? capMinor : null} currency={currency} usedMinor={usedMinor} />
              {budgetMinor !== null && (
                <WorstCaseNote budgetMinor={budgetMinor} currency={currency} startsAt={startsAt ? new Date(startsAt) : null} endsAt={datesError ? null : endsAtDate} now={new Date()} timeZone={account?.timezone} />
              )}
              {capMinor === null && (
                <Alert tone="warn" title="No daily spending limit is set">
                  You can set up this campaign, but it cannot be created on Meta until an owner sets a limit on the Ad campaigns page.
                </Alert>
              )}
              {currencyMismatch && (
                <Alert tone="warn" title="Your limit is in a different currency">
                  Your daily limit is set in {capCurrency}, but this ad account uses {currency}. Ask an owner to set the limit in {currency} before you create the campaign.
                </Alert>
              )}
              {room && !room.fits && budgetCheck.state === "ok" && (
                <Alert tone="warn" title="This may not fit your daily limit">
                  Your other active campaigns already use {formatMinor(usedMinor!, currency)} of your {formatMinor(capMinor!, currency)} limit, so {formatMinor(room.leftMinor, currency)} is left. You can still create this campaign, but it cannot be activated until you lower the budget, pause another campaign, or an owner raises the limit.
                </Alert>
              )}
              <FormField
                label={`Daily budget (${currency})`}
                required
                hint={capApplies ? `The most this campaign spends each day. Your limit of ${formatMinor(capMinor!, currency)} is shared by all your active campaigns.` : "The most this campaign spends each day."}
                error={budgetCheck.message}
              >
                <Input inputMode="decimal" value={budgetText} onChange={(e) => setBudgetText(e.target.value)} autoComplete="off" placeholder="For example 500" />
              </FormField>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Start" optional hint="Leave empty to start when you activate it.">
                  <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
                </FormField>
                <FormField label="End" optional hint="Set to the end of this month. Change it, or choose No end date below." error={datesError}>
                  <Input type="datetime-local" value={noEnd ? "" : endsAt} disabled={noEnd} onChange={(e) => setEndsAt(e.target.value)} />
                </FormField>
              </div>
              <label className={optionRow}>
                <input
                  type="checkbox"
                  className={checkbox}
                  checked={noEnd}
                  onChange={(e) => {
                    setNoEnd(e.target.checked);
                    if (!e.target.checked && !endsAt) setEndsAt(monthEndInput(new Date()));
                  }}
                />
                <span>No end date. It keeps running until you pause it, and we set money aside for it at the start of each month.</span>
              </label>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">
                  Is your ad about any of these?<span aria-hidden className="ml-0.5 text-bad-fg">*</span>
                </legend>
                <CategoryGuidance category={category} suggested={suggested} />
                <div className="-mx-2">
                  {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                    <label key={key} className={optionRow}>
                      <input type="radio" name="category" className={checkbox} checked={category === key} onChange={() => {
                          setCategory(key);
                          setTermsAck(false);
                          setTermsMismatch(false);
                        }}
                      />
                      {label}
                    </label>
                  ))}
                </div>
                {category === "none" && suggested !== "none" && (
                  <label className={optionRow}>
                    <input type="checkbox" className={checkbox} checked={noneConfirmed} onChange={(e) => setNoneConfirmed(e.target.checked)} />
                    <span>I confirm my ad is not about {categoryName(suggested).toLowerCase()}, even though my business profile points to it.</span>
                  </label>
                )}
              </fieldset>
            </div>
            <StepNav onBack={go(1)} next="Continue to audience" ready={step2Ready} missing={budgetCheck.state === "ok" ? "Choose whether your ad is about any special category to continue." : "Enter a daily budget within your limit, and choose a special category, to continue."} />
          </StepForm>
        )}

        {step === 3 && (
          <StepForm ready={step3Ready} onNext={go(4)}>
            <div className="space-y-5">
              {restricted && (
                <Alert tone="info" title="Some choices are fixed for this category">
                  Age, gender and interests are not available for {categoryName(category).toLowerCase()} ads. Meta sets them for you.
                </Alert>
              )}
              <FormField label="Countries" required hint="Use two-letter country codes separated by commas, like IN for India or AE for the United Arab Emirates." error={countriesError}>
                <Input value={countries} onChange={(e) => setCountries(e.target.value)} autoComplete="off" />
              </FormField>
              <div className="grid gap-4 sm:grid-cols-3">
                <FormField label="Youngest age" error={ageError}>
                  <Input type="number" inputMode="numeric" min={13} max={65} value={ageMin} disabled={restricted} onChange={(e) => setAgeMin(e.target.value)} />
                </FormField>
                <FormField label="Oldest age">
                  <Input type="number" inputMode="numeric" min={13} max={65} value={ageMax} disabled={restricted} onChange={(e) => setAgeMax(e.target.value)} />
                </FormField>
                <FormField label="Gender">
                  <Select value={gender} disabled={restricted} onChange={(e) => setGender(e.target.value)}>
                    <option value="all">Everyone</option>
                    <option value="female">Women</option>
                    <option value="male">Men</option>
                  </Select>
                </FormField>
              </div>
              <details className="rounded-card border border-border p-3">
                <summary className="cursor-pointer text-sm font-medium">More targeting options (optional)</summary>
                <div className="mt-4 space-y-5">
                  <fieldset>
                    <legend className="text-sm font-medium">Where your ad appears</legend>
                    <p className="mb-1 text-xs text-muted">Leave everything unticked and Meta picks the best places for you.</p>
                    <div className="-mx-2 grid sm:grid-cols-2">
                      {PLACEMENTS.map((p) => (
                        <label key={p.key} className={optionRow}>
                          <input type="checkbox" className={checkbox} checked={placements.includes(p.key)} onChange={() => togglePlacement(p.key)} />
                          {p.label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <FormField label="Interests" optional hint="Advanced. One per line: the interest ID from Meta, a comma, then a name. Leave empty to let Meta find the right people.">
                    <Textarea rows={3} value={interests} disabled={restricted} onChange={(e) => setInterests(e.target.value)} />
                  </FormField>
                </div>
              </details>
            </div>
            <StepNav onBack={go(2)} next="Continue to your ad" ready={step3Ready} missing="Fix the highlighted fields to continue." />
          </StepForm>
        )}

        {step === 4 && (
          <StepForm ready={!!step4Ready && !busy} onNext={() => void toReview()}>
            <div className="space-y-5">
              {opts.pages.length === 0 ? (
                <Alert tone="warn" title="No Facebook Page connected" action={<LinkButton href="/app/settings/connections" variant="secondary" size="sm">Connect a Page</LinkButton>}>
                  Ads are shown from a Facebook Page. Connect one to continue.
                </Alert>
              ) : (
                <FormField label="Facebook Page" required hint="Your ad is shown as coming from this Page.">
                  <Select value={pageId} onChange={(e) => setPageId(e.target.value)}>
                    <option value="">Choose a Page</option>
                    {opts.pages.map((p) => (
                      <option key={p.id} value={p.externalId}>
                        {p.name ?? "Facebook Page"}
                      </option>
                    ))}
                  </Select>
                </FormField>
              )}
              {opts.instagram.length > 0 && (
                <FormField label="Instagram account" optional hint="Also show the ad on Instagram from this account.">
                  <Select value={instagramId} onChange={(e) => setInstagramId(e.target.value)}>
                    <option value="">Do not use Instagram</option>
                    {opts.instagram.map((p) => (
                      <option key={p.id} value={p.externalId}>
                        {p.name ?? "Instagram account"}
                      </option>
                    ))}
                  </Select>
                </FormField>
              )}
              {template === "boost_post" ? (
                <FormField label="Post to boost" required hint="Paste the ID of the post on your Facebook Page. It looks like 1234567890_9876543210.">
                  <Input value={postId} onChange={(e) => setPostId(e.target.value)} autoComplete="off" />
                </FormField>
              ) : (
                <>
                  {opts.creativeAssets.length > 0 && (
                    <fieldset className="rounded-control border border-border p-3">
                      <legend className="px-1 text-sm font-medium">Start from saved creatives <span className="font-normal text-muted">(optional)</span></legend>
                      <p className="mb-2 text-sm text-muted" id="creative-pick-hint">
                        Tick one to fill in its text. Tick two or more to test them against each other: each becomes its own ad in this campaign and the budget is shared.
                      </p>
                      <ul className="max-h-64 space-y-1 overflow-auto">
                        {[...opts.creativeAssets].sort((x, y) => Number(y.status === "approved") - Number(x.status === "approved")).map((a) => (
                          <li key={a.id}>
                            <label className={optionRow}>
                              <input type="checkbox" className={checkbox} aria-describedby="creative-pick-hint" checked={creativeIds.includes(a.id)} disabled={a.blocked || (!creativeIds.includes(a.id) && creativeIds.length >= MAX_ADS)} onChange={() => toggleCreative(a.id)} />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm">{(a.headline ?? a.body ?? "Saved creative").slice(0, 60)}</span>
                                <span className="block text-xs text-muted">
                                  {a.kind === "image" ? (a.hasImage ? "Picture" : "Picture preview (add a picture link below)") : "Text"}
                                  {a.status === "approved" ? ", approved" : ""}
                                  {a.blocked ? ", must be fixed first" : ""}
                                </span>
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                      {abTest && (
                        <p className="mt-2 text-sm" role="status">
                          {pickedAssets.length} ads will be created to compare. The main text and headline below are only used for creatives that have none of their own.
                        </p>
                      )}
                    </fieldset>
                  )}
                  <FormField label="Main text" required hint="What people read above the picture. Say what you offer and what to do next.">
                    <Textarea rows={4} maxLength={2200} value={message} onChange={(e) => setMessage(e.target.value)} />
                  </FormField>
                  <FormField label="Headline" optional hint="A short line under the picture.">
                    <Input maxLength={100} value={headline} onChange={(e) => setHeadline(e.target.value)} />
                  </FormField>
                  <FormField label="Picture link" required={!pictureCovered(pickedAssets)} optional={pictureCovered(pickedAssets)} error={pictureLinkError(imageUrl)} hint="A public web address that starts with https and points to your image. Meta must be able to open it.">
                    <Input type="url" inputMode="url" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} autoComplete="off" />
                  </FormField>
                </>
              )}
              {template === "traffic" && (
                <FormField label="Website address" required hint="Where people go when they tap your ad.">
                  <Input type="url" inputMode="url" value={link} onChange={(e) => setLink(e.target.value)} autoComplete="off" placeholder="https://" />
                </FormField>
              )}
              {template === "lead_generation" && (
                <FormField label="Lead form ID" required hint="The ID of a lead form you made on your Facebook Page.">
                  <Input value={leadFormId} onChange={(e) => setLeadFormId(e.target.value)} autoComplete="off" />
                </FormField>
              )}
              {template === "click_to_whatsapp" && (
                <>
                  {opts.phoneNumbers.length === 0 ? (
                    <Alert tone="warn" title="No WhatsApp number connected" action={<LinkButton href="/app/settings/connections" variant="secondary" size="sm">Connect a number</LinkButton>}>
                      Connect a WhatsApp number so people can message you from the ad.
                    </Alert>
                  ) : (
                    <FormField label="WhatsApp number" required hint="The chat opens with this number.">
                      <Select value={whatsappNumberId} onChange={(e) => setWhatsappNumberId(e.target.value)}>
                        <option value="">Choose a number</option>
                        {opts.phoneNumbers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.displayPhone}
                            {p.verifiedName ? ` (${p.verifiedName})` : ""}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                  )}
                  <FormField label="Welcome message" optional hint="The text that is ready to send when the chat opens, like Hi, I saw your ad.">
                    <Input maxLength={300} value={welcomeMessage} onChange={(e) => setWelcomeMessage(e.target.value)} />
                  </FormField>
                </>
              )}
              {termsMismatch && (
                <Alert tone="warn" title="Check the special category">
                  <p>{problem}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="secondary" onClick={go(2)}>
                      Change the category
                    </Button>
                  </div>
                  <TermsAckBox className="-mx-2 mt-2" checked={termsAck} onChange={setTermsAck} />
                </Alert>
              )}
              {problem && !termsMismatch && <Alert tone="bad" title="We could not prepare your review">{problem}</Alert>}
            </div>
            <StepNav onBack={go(3)} next="Review campaign" ready={!!step4Ready && !busy} loading={busy} missing="Fill in the required fields above to continue." />
          </StepForm>
        )}

        {step === 5 && preview && (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (typedOk && preview.errors.length === 0 && !busy && (!termsMismatch || termsAck)) void launch();
            }}
            className="space-y-5"
          >
            <section className="rounded-card border border-border bg-surface p-4" aria-label="Total daily budget">
              <p className="text-sm text-muted">Total daily budget</p>
              <p className="text-3xl font-semibold tabular-nums tracking-tight" data-testid="total-budget">
                {formatMinor(preview.totalDailyBudgetMinor, preview.currency)}
              </p>
              <p className="mt-1 text-sm text-muted">
                {preview.caps.maxDailyBudgetMinor !== null && (!preview.caps.currency || preview.caps.currency === preview.currency)
                  ? `Your daily limit across all campaigns is ${formatMinor(preview.caps.maxDailyBudgetMinor, preview.currency)}. `
                  : "No daily limit is set for this currency yet. "}
                The campaign is created paused, so nothing is spent until you activate it.
              </p>
              <ul className="mt-2 space-y-1 text-sm [overflow-wrap:anywhere]" data-testid="review-worst-case">
                {worstCaseLines({ budgetMinor: preview.totalDailyBudgetMinor, currency: preview.currency, startsAt: startsAt ? new Date(startsAt) : null, endsAt: endsAtDate, now: new Date(), timeZone: account?.timezone }).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>

            {reviewRoom && !reviewRoom.fits && (
              <Alert tone="warn" title="This may not fit your daily limit">
                Your other active campaigns already use {formatMinor(reviewUsed!, preview.currency)}, so {formatMinor(reviewRoom.leftMinor, preview.currency)} is left of your limit. The campaign can be created paused, but it cannot be activated until you lower the budget, pause another campaign, or an owner raises the limit.
              </Alert>
            )}

            {preview.errors.length > 0 && (
              <Alert tone="bad" title="Fix these before creating the campaign">
                <ul className="list-disc pl-5">
                  {preview.errors.map((m) => (
                    <li key={m}>{friendlyAdsError(m)}</li>
                  ))}
                </ul>
              </Alert>
            )}
            {adjustments.length > 0 && (
              <Alert tone="info" title="We adjusted your audience for the special category">
                <ul className="list-disc pl-5">
                  {adjustments.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </Alert>
            )}

            <dl className="divide-y divide-border rounded-card border border-border px-4">
              <SummaryRow label="Goal">{TEMPLATE_LABELS[template]?.title}</SummaryRow>
              <SummaryRow label="Name">{name.trim()}</SummaryRow>
              {abTest && <SummaryRow label="Ads">{pickedAssets.length} ads to compare, in one ad set</SummaryRow>}
              <SummaryRow label="Ad account">{accountLabel}</SummaryRow>
              <SummaryRow label="Special category">{category === "none" ? "None" : categoryName(category)}</SummaryRow>
              <SummaryRow label="Audience">
                {parsedCountries.codes.join(", ")}
                {restricted ? "" : `, ages ${min} to ${max}${gender === "all" ? "" : gender === "female" ? ", women" : ", men"}`}
              </SummaryRow>
              <SummaryRow label="Schedule">
                {startsAt ? new Date(startsAt).toLocaleString() : "Starts when you activate it"}
                {endsAtDate ? ` until ${endsAtDate.toLocaleString()}` : ", runs until you pause it"}
              </SummaryRow>
            </dl>

            <details className="text-sm">
              <summary className="cursor-pointer font-medium">Details for support: what will be sent to Meta</summary>
              <pre className="mt-2 max-h-96 overflow-auto rounded-control bg-surface p-3 text-xs">{JSON.stringify(preview.payload, null, 2)}</pre>
            </details>

            <FormField
              label={`Type the daily total to confirm: ${formatMinor(preview.totalDailyBudgetMinor, preview.currency)}`}
              hint="Type the amount shown above to show you have checked it. This does not start any spending."
              error={typedTotal.trim() !== "" && !typedOk ? "That does not match the total daily budget above." : null}
              required
            >
              <Input inputMode="decimal" autoComplete="off" value={typedTotal} onChange={(e) => setTypedTotal(e.target.value)} />
            </FormField>

            {problem && (
              <Alert tone={termsMismatch ? "warn" : "bad"} title={termsMismatch ? "Check the special category" : "We could not create the campaign"}>
                <p>{problem}</p>
                {problem === META_LOGIN_FIX && (
                  <div className="mt-2">
                    <LinkButton href="/app/settings/connections" size="sm">
                      Open Meta connections
                    </LinkButton>
                  </div>
                )}
                {termsMismatch && <TermsAckBox className="-mx-2 mt-2" checked={termsAck} onChange={setTermsAck} />}
              </Alert>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" disabled={busy} onClick={go(4)}>
                  Back to edit
                </Button>
                <Button type="button" variant="ghost" disabled={busy} onClick={leaveToDraft}>
                  Save draft and leave
                </Button>
              </div>
              <Button type="submit" disabled={!typedOk || preview.errors.length > 0 || (termsMismatch && !termsAck)} loading={busy}>
                Create on Meta (paused)
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
