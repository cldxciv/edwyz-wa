"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { PageHeader } from "@/components/app/PageHeader";
import { Alert, Button, Card, EmptyState, ErrorState, FormField, Skeleton, Textarea, apiFetch, toast } from "@/components/ui";
import { GOALS } from "@/lib/creative/constants";
import { ChoiceCard } from "./ChoiceCard";
import { friendlyMessage } from "./messages";
import { Stepper } from "./Stepper";
import { CATEGORY_LABEL, LinkButton, type Brand } from "./shared";
import { GOAL_INFO, safeColour } from "./wizard";

const OFFER_MAX = 1000;

function BrandChoice({ brand, checked, onChange }: { brand: Brand; checked: boolean; onChange: () => void }) {
  const colours = brand.colors.map(safeColour).filter((c): c is string => !!c);
  return (
    <ChoiceCard
      type="radio"
      name="brand"
      checked={checked}
      onChange={onChange}
      title={brand.name}
      help={brand.industry ?? "No business type set"}
    >
      {colours.length > 0 && (
        <span className="mt-2 flex gap-1.5" aria-hidden>
          {colours.map((c) => (
            <span key={c} className="h-4 w-4 rounded-full border border-border-strong" style={{ backgroundColor: c }} />
          ))}
        </span>
      )}
    </ChoiceCard>
  );
}

export function BriefWizard() {
  const router = useRouter();
  const [brands, setBrands] = useState<Brand[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [step, setStep] = useState<0 | 1>(0);
  const [brandId, setBrandId] = useState("");
  const [goal, setGoal] = useState<string>("leads");
  const [offer, setOffer] = useState("");
  const [notes, setNotes] = useState("");
  const [offerError, setOfferError] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [focusTick, setFocusTick] = useState(0);
  const moved = useRef(false);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const { items } = await apiFetch<{ items: Brand[] }>("/api/creative/brands");
      const wanted = new URLSearchParams(window.location.search).get("brand");
      setBrands(items);
      setBrandId(items.find((b) => b.id === wanted)?.id ?? items[0]?.id ?? "");
    } catch (e) {
      setLoadError(friendlyMessage(e, "Check your connection and try again."));
      setBrands([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (moved.current) heading.current?.focus();
    moved.current = true;
  }, [step]);

  // The error text is under the box, so move focus to the box itself once it is marked invalid.
  useEffect(() => {
    if (focusTick > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusTick]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!offer.trim()) {
      setOfferError("Describe what you want to promote, in a sentence or two.");
      setFocusTick((t) => t + 1);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { item } = await apiFetch<{ item: { id: string } }>("/api/creative/briefs", { method: "POST", body: { brandId, goal, offer, competitorNotes: notes.trim() || null } });
      toast.success("Brief created. Next, choose your angles.");
      router.push(`/app/creative/briefs/${item.id}`);
    } catch (err) {
      setError(friendlyMessage(err, "We could not create the brief. Check your connection and try again."));
      setBusy(false);
    }
  }

  const header = (
    <PageHeader
      title="New brief"
      description="Answer two quick questions. Then we suggest ideas, write the ads and check them for you."
      breadcrumbs={[{ label: "Creative Studio", href: "/app/creative" }, { label: "New brief" }]}
    />
  );

  if (brands === null) {
    return (
      <div className="max-w-2xl" aria-busy="true">
        {header}
        <p role="status" className="sr-only">
          Loading your brand kits
        </p>
        <div aria-hidden className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-2xl">
        {header}
        <ErrorState title="We could not load your brand kits" message={loadError} action={<Button variant="secondary" onClick={() => void load()}>Try again</Button>} />
      </div>
    );
  }

  if (brands.length === 0) {
    return (
      <div className="max-w-2xl">
        {header}
        <EmptyState
          title="Create a brand kit first"
          body="A brief uses your brand kit for colours, tone and words to avoid. It takes about a minute to set up."
          action={<LinkButton variant="primary" href="/app/creative/brands">Create brand kit</LinkButton>}
        />
      </div>
    );
  }

  const chosen = brands.find((b) => b.id === brandId);

  return (
    <div className="max-w-2xl">
      {header}
      <Stepper current={step} />
      <Card>
        {step === 0 ? (
          <div>
            <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">
              Which brand is this for?
            </h2>
            <p className="mt-1 text-sm text-muted">We use its colours, tone and banned words.</p>
            <fieldset className="mt-4">
              <legend className="sr-only">Brand kit</legend>
              <div className="grid gap-3">
                {brands.map((b) => (
                  <BrandChoice key={b.id} brand={b} checked={b.id === brandId} onChange={() => setBrandId(b.id)} />
                ))}
              </div>
            </fieldset>
            {chosen && chosen.specialAdCategory !== "none" && (
              <Alert tone="info" className="mt-4" title={`${CATEGORY_LABEL[chosen.specialAdCategory]} ads have extra rules`}>
                Meta limits how these ads can be targeted. We remind you again when you review the ads.
              </Alert>
            )}
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
              <LinkButton variant="ghost" href="/app/creative/brands">
                Manage brand kits
              </LinkButton>
              <Button disabled={!brandId} onClick={() => setStep(1)}>
                Continue to goal and offer
              </Button>
            </div>
          </div>
        ) : (
          <form ref={formRef} noValidate className="max-sm:[&_textarea]:text-base!" onSubmit={(e) => void submit(e)}>
            <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">
              What do you want to achieve?
            </h2>
            <p className="mt-1 text-sm text-muted">
              For {chosen?.name}. You can change your mind later by starting a new brief.
            </p>
            <fieldset className="mt-4">
              <legend className="sr-only">Goal</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {GOALS.map((g) => (
                  <ChoiceCard key={g} type="radio" name="goal" checked={goal === g} onChange={() => setGoal(g)} title={GOAL_INFO[g].label} help={GOAL_INFO[g].help} />
                ))}
              </div>
            </fieldset>
            <div className="mt-5 grid gap-4">
              <FormField
                label="What are you promoting?"
                required
                error={offerError}
                hint={`One or two sentences. Include only prices and claims that are true. ${offer.length} of ${OFFER_MAX} characters used.`}
              >
                <Textarea
                  rows={4}
                  maxLength={OFFER_MAX}
                  placeholder="Example: Free first yoga class for new members, valid until 30 November."
                  value={offer}
                  onChange={(e) => {
                    setOffer(e.target.value);
                    if (offerError) setOfferError(null);
                  }}
                />
              </FormField>
              <details className="rounded-control border border-border p-3" open={!!notes}>
                <summary className="cursor-pointer text-sm font-medium">Add notes about competitors (optional)</summary>
                <div className="mt-3">
                  <FormField label="Competitor notes" optional hint="Paste what you saw from other businesses, for example from the Meta Ad Library. We do not collect competitor ads for you.">
                    <Textarea rows={3} maxLength={3000} value={notes} onChange={(e) => setNotes(e.target.value)} />
                  </FormField>
                </div>
              </details>
            </div>
            {error && (
              <Alert tone="bad" className="mt-4">
                {error}
              </Alert>
            )}
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
              <Button type="button" variant="secondary" onClick={() => setStep(0)} disabled={busy}>
                Back
              </Button>
              <Button type="submit" loading={busy}>
                Create brief and continue
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
