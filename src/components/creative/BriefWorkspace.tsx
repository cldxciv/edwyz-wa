"use client";

import { memo, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { PageHeader } from "@/components/app/PageHeader";
import { LinkButton } from "@/components/ads/LinkButton";
import { isNotFoundError } from "@/components/ads/helpers";
import { Alert, Badge, Button, Card, CopyButton, Dialog, EmptyState, ErrorState, FormField, Input, Skeleton, StatusPill, Textarea, apiFetch, confirm, toast } from "@/components/ui";
import { COPY_LIMITS, PLACEMENTS } from "@/lib/creative/constants";
import { ChoiceCard } from "./ChoiceCard";
import { friendlyMessage } from "./messages";
import { Stepper } from "./Stepper";
import { CATEGORY_LABEL, PolicyBadge, PolicyReport, type Angle, type Asset, type Brand } from "./shared";
import { AI_OFF_MESSAGE } from "@/lib/ai-configured";
import { PLACEMENT_INFO, assetStatus, briefStatus, canEnterStep, clientFeedback, goalLabel, kindLabel, placementLabel, startStep, stepIndex, type StepId } from "./wizard";

type Research = { offer?: string; audience?: string; tone?: string; proofPoints?: string[]; competitorNotes?: string; sources?: string[]; researchedAt?: string } | null;
type Brief = { id: string; goal: string; offer: string; status: string; researchSummary: Research; brand: Brand; angles: Angle[]; assets: Asset[] };

const BUSY_TEXT: Record<string, string> = {
  research: "Reading your website. This can take up to a minute.",
  angles: "Thinking of ideas. This can take up to a minute.",
  copy: "Writing your ad text. This can take up to a minute.",
  image: "Creating your pictures.",
  approval: "Creating the approval link.",
  delete: "Deleting.",
};
/** Meta allows many ads per ad set; the launcher accepts up to 10. */
const MAX_AB_ADS = 10;
const busyText = (key: string) => BUSY_TEXT[key.split(":")[0]] ?? "Working on it.";

type AssetCardProps = { asset: Asset; disabled: boolean; sending: boolean; picked: boolean; onPick: (id: string) => void; onEdit: (a: Asset) => void; onSend: (a: Asset) => void; onDelete: (a: Asset) => void };

const AssetCard = memo(function AssetCard({ asset: a, disabled, sending, picked, onPick, onEdit, onSend, onDelete }: AssetCardProps) {
  const blocked = a.policyCheck?.result === "block";
  const status = assetStatus(a.status);
  const feedback = clientFeedback(a);
  const label = a.headline || kindLabel(a.kind);
  const usable = !blocked && (a.status === "ready" || a.status === "approved");
  return (
    <Card className="flex h-full flex-col">
      {a.kind === "image" && a.storageKey && (
        <div className="mb-3 flex h-56 items-center justify-center rounded-control border border-border bg-surface">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/creative/assets/${a.id}/file`} alt={`${placementLabel(a.placement)} picture for "${label}"`} loading="lazy" className="max-h-full max-w-full object-contain" />
        </div>
      )}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <Badge>
          {kindLabel(a.kind)}
          {a.placement !== "none" ? `, ${placementLabel(a.placement).toLowerCase()}` : ""}
        </Badge>
        {a.aiGenerated && <Badge>Made with AI</Badge>}
        {a.status !== "ready" && <StatusPill status={a.status} label={status.label} tone={status.tone} />}
        {feedback && <StatusPill status={`client_${a.clientFeedback?.status ?? ""}`} label={feedback.label} tone={feedback.tone} />}
        <PolicyBadge check={a.policyCheck} />
      </div>
      {a.status === "failed" && (
        <Alert tone="bad" className="mb-2">
          This picture could not be created. You were not charged. Delete it and try again.
        </Alert>
      )}
      {feedback && (feedback.comment || feedback.next) && (
        <Alert tone={feedback.tone} className="mb-2" title={feedback.comment ? "Your client asked for changes" : undefined}>
          {feedback.comment && <q className="block whitespace-pre-wrap">{feedback.comment}</q>}
          {feedback.next && <p className={feedback.comment ? "mt-1" : undefined}>{feedback.next}</p>}
        </Alert>
      )}
      <p className="font-semibold">{a.headline}</p>
      {a.body && <p className="mt-1 whitespace-pre-wrap text-sm">{a.body}</p>}
      {a.policyCheck?.description && <p className="mt-1 text-sm text-muted">{a.policyCheck.description}</p>}
      <PolicyReport check={a.policyCheck} expanded={blocked} />
      <div className="mt-auto flex flex-wrap gap-2 pt-4">
        <Button variant="secondary" disabled={disabled} onClick={() => onEdit(a)} aria-label={`Edit wording, ${label}`}>
          Edit wording
        </Button>
        <Button
          disabled={disabled || blocked || a.status !== "ready"}
          loading={sending}
          onClick={() => onSend(a)}
          aria-label={`Send for approval, ${label}`}
          title={blocked ? "Fix the problems marked Must fix first" : undefined}
        >
          Send for approval
        </Button>
        <Button variant="ghost" disabled={disabled} onClick={() => onDelete(a)} aria-label={`Delete, ${label}`}>
          Delete
        </Button>
      </div>
      {blocked && <p className="mt-2 text-xs text-muted">Fix the items marked Must fix, then save, before you can send this.</p>}
      {usable && (
        <label className="mt-3 flex min-h-10 items-center gap-3 border-t border-border pt-3 text-sm">
          <input type="checkbox" checked={picked} onChange={() => onPick(a.id)} disabled={disabled} className="h-5 w-5 accent-(--accent)" />
          <span>Use in an ad{a.headline ? <span className="sr-only">: {a.headline}</span> : null}</span>
        </label>
      )}
    </Card>
  );
});

export function BriefWorkspace({ briefId }: { briefId: string }) {
  const [brief, setBrief] = useState<Brief | null>(null);
  // True once the server says AI is off: the AI buttons are then disabled and a notice explains, instead of a failing click.
  const [aiOff, setAiOff] = useState(false);
  const [loadError, setLoadError] = useState("");
  // The server answered 404: the brief was deleted, is in another workspace, or the link is wrong. Try again cannot help.
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState("");
  const [step, setStep] = useState<StepId | null>(null);
  const [placements, setPlacements] = useState<string[]>(["feed"]);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [approval, setApproval] = useState<{ url: string; label: string } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const heading = useRef<HTMLHeadingElement>(null);
  const approvalCard = useRef<HTMLDivElement>(null);
  const moved = useRef(false);

  const load = useCallback(
    async (silent = false) => {
      try {
        const res = await apiFetch<{ item: Brief; aiConfigured?: boolean }>(`/api/creative/briefs/${briefId}`);
        const item = res.item;
        setBrief(item);
        setAiOff(res.aiConfigured === false);
        setStep((cur) => cur ?? startStep(item));
        setLoadError("");
        setMissing(false);
      } catch (e) {
        if (silent) toast.error("We could not refresh this page. Reload it to see the latest.");
        else {
          setMissing(isNotFoundError(e instanceof Error ? e.message : null));
          setLoadError(friendlyMessage(e, "Check your connection and try again."));
        }
      }
    },
    [briefId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (step === null) return;
    if (moved.current) heading.current?.focus();
    moved.current = true;
  }, [step]);

  // The link is shown once and a phone may have many ads, so bring the card into view and move focus to it.
  useEffect(() => {
    if (!approval) return;
    approvalCard.current?.scrollIntoView({ block: "center" });
    approvalCard.current?.focus({ preventScroll: true });
  }, [approval]);

  async function perform<T>(key: string, fn: () => Promise<T>, msg: { success?: string; error: string }): Promise<T | null> {
    setBusy(key);
    try {
      const res = await fn();
      await load(true);
      if (msg.success) toast.success(msg.success);
      return res;
    } catch (e) {
      toast.error(friendlyMessage(e, msg.error));
      await load(true);
      return null;
    } finally {
      setBusy("");
    }
  }

  const base = `/api/creative/briefs/${briefId}`;
  const post = (path: string, body?: unknown) => apiFetch<Record<string, unknown>>(`${base}${path}`, { method: "POST", body });

  const runResearch = () => perform("research", () => post("/research"), { success: "Research is ready. Please check it for mistakes.", error: "We could not read your website. Check the address in your brand kit and try again." });
  const runAngles = () => perform("angles", () => post("/angles"), { success: "Ideas are ready. Choose the ones you like.", error: "We could not suggest ideas this time. Try again." });
  const writeCopy = (a: Angle) => perform(`copy:${a.id}`, () => post("/copy", { angleId: a.id, placements }), { success: "Ad text is ready. Review it in the next step.", error: "We could not write the ad text. Try again." });
  const makePictures = (a: Angle) =>
    perform(
      `image:${a.id}`,
      async () => {
        for (const placement of placements) await post("/media", { kind: "image", angleId: a.id, placement });
      },
      { success: placements.length === 1 ? "Picture is ready. Review it in the next step." : "Pictures are ready. Review them in the next step.", error: "We could not create all the pictures. Check which ones were made and try again." },
    );

  async function toggleAngle(id: string, selected: boolean) {
    setBrief((b) => (b ? { ...b, angles: b.angles.map((a) => (a.id === id ? { ...a, selected } : a)) } : b));
    try {
      await apiFetch(`/api/creative/angles/${id}`, { method: "PATCH", body: { selected } });
    } catch (e) {
      toast.error(friendlyMessage(e, "We could not save that choice. Try again."));
      await load(true);
    }
  }

  async function send(asset?: Asset) {
    const res = await perform(asset ? `approval:${asset.id}` : "approval", () => post("/approval", asset ? { assetId: asset.id } : {}), { error: "We could not create the approval link. Try again." });
    const url = (res?.approval as { url?: string } | undefined)?.url;
    if (url) {
      setApproval({ url, label: asset ? `"${asset.headline || kindLabel(asset.kind)}"` : "your goal and offer" });
      toast.success("Approval link created. It is shown below. Copy it before you leave this page.");
    }
  }

  const sendOne = useCallback((a: Asset) => void send(a), [briefId]); // eslint-disable-line react-hooks/exhaustive-deps
  const openEditor = useCallback((a: Asset) => setEditing(a), []);

  const removeAsset = useCallback(
    async (a: Asset) => {
      const ok = await confirm({ title: "Delete this ad?", body: "It is removed from this brief. Anything already sent to your client stays with them.", confirmLabel: "Delete ad", tone: "danger" });
      if (!ok) return;
      setBusy("delete");
      try {
        await apiFetch(`/api/creative/assets/${a.id}`, { method: "DELETE" });
        await load(true);
        toast.success("Ad deleted");
        // The Delete button that had focus is gone now, so keep keyboard and screen reader users in this step.
        requestAnimationFrame(() => heading.current?.focus());
      } catch (e) {
        toast.error(friendlyMessage(e, "We could not delete this ad. Try again."));
      } finally {
        setBusy("");
      }
    },
    [load],
  );

  const deleteOne = useCallback((a: Asset) => void removeAsset(a), [removeAsset]);

  if (!brief) {
    if (missing) {
      return (
        <div>
          <PageHeader title="Brief not found" breadcrumbs={[{ label: "Creative Studio", href: "/app/creative" }, { label: "Not found" }]} />
          <EmptyState title="This brief does not exist" body="It may have been deleted, or the link is wrong." action={<LinkButton href="/app/creative">Back to Creative Studio</LinkButton>} />
        </div>
      );
    }
    if (loadError) {
      return (
        <div>
          <PageHeader title="Creative brief" breadcrumbs={[{ label: "Creative Studio", href: "/app/creative" }, { label: "Not available" }]} />
          <ErrorState title="We could not load this brief" message={loadError} action={<Button variant="secondary" onClick={() => void load()}>Try again</Button>} />
        </div>
      );
    }
    return (
      <div aria-busy="true">
        <p role="status" className="sr-only">
          Loading your brief
        </p>
        <div aria-hidden className="space-y-3">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-96 max-w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }

  const current = step ?? startStep(brief);
  const idx = stepIndex(current);
  const selected = brief.angles.filter((a) => a.selected);
  const r = brief.researchSummary;
  const hasResearch = !!r?.offer;
  const status = briefStatus(brief.status);
  const anyBusy = !!busy;
  const creativesGate = canEnterStep("creatives", brief);
  const reviewGate = canEnterStep("review", brief);
  const readyAssets = brief.assets.filter((a) => a.status === "ready");
  const blockedReady = readyAssets.filter((a) => a.policyCheck?.result === "block").length;
  const togglePlacement = (p: string) => setPlacements((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
  const locked: StepId[] = [...(creativesGate.ok ? [] : (["creatives"] as StepId[])), ...(reviewGate.ok ? [] : (["review"] as StepId[]))];
  const category = brief.brand.specialAdCategory;

  const go = (id: StepId) => setStep(id);
  const pick = (id: string) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length < MAX_AB_ADS ? [...cur, id] : cur));
  const usableIds = new Set(brief.assets.filter((a) => a.policyCheck?.result !== "block" && (a.status === "ready" || a.status === "approved")).map((a) => a.id));
  const pickedIds = picked.filter((id) => usableIds.has(id));

  return (
    <div>
      <PageHeader
        title={`Ads for ${brief.brand.name}`}
        description={brief.offer}
        breadcrumbs={[{ label: "Creative Studio", href: "/app/creative" }, { label: brief.brand.name }]}
        actions={<StatusPill status={brief.status} label={status.label} tone={status.tone} />}
      >
        <p className="text-sm text-muted">Goal: {goalLabel(brief.goal)}</p>
      </PageHeader>

      <Stepper current={idx} onSelect={go} locked={locked} fixed={["brand", "offer"]} />

      {category !== "none" && (
        <Alert tone="warn" className="mb-4" title={`${CATEGORY_LABEL[category] ?? "Special"} ads have extra rules`}>
          Meta limits how these ads can be targeted, and you declare the category when you create the campaign.
        </Alert>
      )}

      <p role="status" className={busy ? "mb-4 text-sm text-muted" : "sr-only"}>
        {busy ? busyText(busy) : ""}
      </p>

      {aiOff && (current === "angles" || current === "creatives") && (
        <Alert tone="warn" className="mb-4" title="AI is not switched on for this workspace yet">
          We cannot read your website, suggest ideas or write ad text until an admin sets up AI. Ask an admin, then come back to this brief. You can still edit the wording of any ad yourself.
        </Alert>
      )}

      {current === "angles" && (
        <section aria-labelledby="step-angles" className="space-y-4">
          <div>
            <h2 id="step-angles" ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">
              Choose your angles
            </h2>
            <p className="mt-1 text-sm text-muted">An angle is the idea behind an ad. First we read your website to understand your business. Then we suggest ideas and you pick the ones to use.</p>
          </div>

          <Card
            title="What we understood about your business"
            description={brief.brand.websiteUrl ? undefined : "No website is set in your brand kit, so we will use your offer and notes only."}
            actions={
              <Button variant={hasResearch ? "secondary" : "primary"} loading={busy === "research"} disabled={anyBusy || aiOff} title={aiOff ? AI_OFF_MESSAGE : undefined} onClick={() => void runResearch()}>
                {hasResearch ? "Read again (uses 1 credit)" : "Read my website (uses 1 credit)"}
              </Button>
            }
          >
            {hasResearch ? (
              <>
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="font-medium">What you offer</dt>
                    <dd className="text-muted">{r?.offer}</dd>
                  </div>
                  <div>
                    <dt className="font-medium">Who it is for</dt>
                    <dd className="text-muted">{r?.audience}</dd>
                  </div>
                  <div>
                    <dt className="font-medium">How you sound</dt>
                    <dd className="text-muted">{r?.tone}</dd>
                  </div>
                  <div>
                    <dt className="font-medium">Proof we found</dt>
                    <dd className="text-muted">{r?.proofPoints?.length ? r.proofPoints.join("; ") : "Nothing specific"}</dd>
                  </div>
                </dl>
                <p className="mt-3 text-xs text-muted">
                  Written by AI from {r?.sources?.length ? `${r.sources.length} ${r.sources.length === 1 ? "page" : "pages"} of your website` : "the details you gave us"}. It can make mistakes, so please check it.
                </p>
              </>
            ) : (
              <p className="text-sm text-muted">We only read public pages, and only when you ask. This takes up to a minute.</p>
            )}
          </Card>

          <Card
            title="Ideas to choose from"
            description={brief.angles.length ? "Tick the ones you want ads for. Pick one to three." : undefined}
            actions={
              <Button variant={brief.angles.length ? "secondary" : "primary"} loading={busy === "angles"} disabled={!hasResearch || anyBusy || aiOff} title={aiOff ? AI_OFF_MESSAGE : undefined} onClick={() => void runAngles()}>
                {brief.angles.length ? "Suggest new ideas (uses 1 credit)" : "Suggest ideas (uses 1 credit)"}
              </Button>
            }
          >
            {brief.angles.length === 0 ? (
              <EmptyState compact title="No ideas yet" body={aiOff ? "Ideas are written by AI, which is not switched on for this workspace yet. Ask an admin to set up AI." : hasResearch ? "Ask for ideas and we suggest three to five angles for you to choose from." : "Read your website first. Then we can suggest ideas."} />
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {brief.angles.map((a) => (
                  <li key={a.id}>
                    <ChoiceCard type="checkbox" checked={a.selected} onChange={(v) => void toggleAngle(a.id, v)} title={a.hook} help={`For: ${a.audience}`} className="h-full">
                      <span className="mt-0.5 block text-sm text-muted">Button says: {a.cta}</span>
                      {a.rationale && <span className="mt-1 block text-xs text-muted">Why it could work: {a.rationale}</span>}
                    </ChoiceCard>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <div className="flex flex-wrap items-center justify-end gap-3">
            {!creativesGate.ok && <p className="text-sm text-muted">{creativesGate.reason}</p>}
            <Button disabled={!creativesGate.ok} onClick={() => go("creatives")}>
              Continue to creatives
            </Button>
          </div>
        </section>
      )}

      {current === "creatives" && (
        <section aria-labelledby="step-creatives" className="space-y-4">
          <div>
            <h2 id="step-creatives" ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">
              Create your ads
            </h2>
            <p className="mt-1 text-sm text-muted">Choose where the ads will appear. Then write the text and make the pictures for each angle.</p>
          </div>

          <Card title="Where will the ads appear?" description="Pick one or more. Each format gets its own picture size and text length.">
            <fieldset>
              <legend className="sr-only">Formats</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {PLACEMENTS.map((p) => (
                  <ChoiceCard key={p} type="checkbox" checked={placements.includes(p)} onChange={() => togglePlacement(p)} title={PLACEMENT_INFO[p].label} help={PLACEMENT_INFO[p].help} />
                ))}
              </div>
            </fieldset>
          </Card>

          <Card title="Your angles" description={placements.length === 0 ? "Choose at least one format above." : undefined}>
            {selected.length === 0 ? (
              <EmptyState compact title="No angles chosen" body="Go back and tick the ideas you want ads for." action={<Button variant="secondary" onClick={() => go("angles")}>Back to angles</Button>} />
            ) : (
              <ul className="space-y-4">
                {selected.map((a) => (
                  <li key={a.id} className="rounded-control border border-border p-3">
                    <p className="font-semibold">{a.hook}</p>
                    <p className="mt-0.5 text-sm text-muted">For: {a.audience}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button loading={busy === `copy:${a.id}`} disabled={anyBusy || placements.length === 0 || aiOff} title={aiOff ? AI_OFF_MESSAGE : undefined} onClick={() => void writeCopy(a)}>
                        Write ad text (uses 1 credit)
                      </Button>
                      <Button variant="secondary" loading={busy === `image:${a.id}`} disabled={anyBusy || placements.length === 0} onClick={() => void makePictures(a)}>
                        {placements.length > 1 ? `Create ${placements.length} pictures` : "Create picture"}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-4 text-xs text-muted">Pictures are simple placeholder cards for now. A picture service can be connected later. Video is not available yet.</p>
          </Card>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button variant="secondary" onClick={() => go("angles")}>
              Back
            </Button>
            <div className="flex flex-wrap items-center gap-3">
              {!reviewGate.ok && <p className="text-sm text-muted">{reviewGate.reason}</p>}
              <Button disabled={!reviewGate.ok} onClick={() => go("review")}>
                Continue to review
              </Button>
            </div>
          </div>
        </section>
      )}

      {current === "review" && (
        <section aria-labelledby="step-review" className="space-y-4">
          <div>
            <h2 id="step-review" ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">
              Review and send for approval
            </h2>
            <p className="mt-1 text-sm text-muted">Check each ad and its policy check. Use Send for approval on an ad to show your client that ad, with its text and picture, on one simple page. They can approve with one tap, no login needed.</p>
          </div>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold">
                  {readyAssets.length} {readyAssets.length === 1 ? "ad" : "ads"}{" "}ready to send
                </p>
                {blockedReady > 0 ? (
                  <p className="mt-0.5 text-sm text-bad-fg">
                    {blockedReady} {blockedReady === 1 ? "ad has" : "ads have"} problems marked Must fix. Fix {blockedReady === 1 ? "it" : "them"}{" "}before sending.
                  </p>
                ) : (
                  <p className="mt-0.5 text-sm text-muted">To approve your goal and offer in one go, send one link. To show an ad itself, use Send for approval on that ad.</p>
                )}
              </div>
              <Button loading={busy === "approval"} disabled={anyBusy || readyAssets.length === 0 || blockedReady > 0} onClick={() => void send()}>
                Send goal and offer for approval
              </Button>
            </div>
          </Card>

          {approval && (
            <div ref={approvalCard} tabIndex={-1} role="region" aria-label="Approval link" className="scroll-mt-4 rounded-card">
              <Card
                title="Approval link ready"
                description={`For ${approval.label}. Send it to your client by WhatsApp or email. It works without a login and expires after 7 days. We show it only once, so copy it now.`}
              >
                <FormField label="Link for your client">
                  <Input className="max-sm:text-base!" readOnly value={approval.url} onFocus={(e) => e.currentTarget.select()} />
                </FormField>
                <div className="mt-3 flex flex-wrap gap-2">
                  <CopyButton value={approval.url} label="Copy link" size="md" />
                  <Button variant="ghost" onClick={() => setApproval(null)}>
                    Hide link
                  </Button>
                </div>
              </Card>
            </div>
          )}

          {brief.assets.length === 0 ? (
            <EmptyState title="No ads yet" body="Create ad text or pictures first. They appear here for you to check." action={<Button onClick={() => go("creatives")}>Create ads</Button>} />
          ) : (
            <>
              <Card title="Run these as ads" description="Tick the ones you want to test. Each gets its own ad in the same campaign, so you can see which works best.">
                <div className="flex flex-wrap items-center gap-3">
                  <LinkButton href={`/app/ads/new?creatives=${encodeURIComponent(pickedIds.join(","))}`} aria-disabled={pickedIds.length === 0} tabIndex={pickedIds.length === 0 ? -1 : undefined} className={pickedIds.length === 0 ? "pointer-events-none opacity-50" : undefined}>
                    {pickedIds.length > 1 ? `Create ${pickedIds.length} ads to compare` : "Create an ad"}
                  </LinkButton>
                  <span className="text-sm text-muted" role="status">
                    {pickedIds.length === 0 ? "Tick Use in an ad on one or more items below." : `${pickedIds.length} selected (up to ${MAX_AB_ADS}).`}
                  </span>
                </div>
              </Card>
              <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {brief.assets.map((a) => (
                  <li key={a.id}>
                    <AssetCard asset={a} disabled={anyBusy} sending={busy === `approval:${a.id}`} picked={pickedIds.includes(a.id)} onPick={pick} onEdit={openEditor} onSend={sendOne} onDelete={deleteOne} />
                  </li>
                ))}
              </ul>
            </>
          )}

          <div>
            <Button variant="secondary" onClick={() => go("creatives")}>
              Back to creatives
            </Button>
          </div>
        </section>
      )}

      {editing && (
        <VariantEditor
          key={editing.id}
          asset={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load(true);
          }}
        />
      )}
    </div>
  );
}

const EDITOR_FORM = "variant-editor-form";

function countHint(length: number, max: number): string {
  return length > max ? `${length} characters. About ${max} show before it is cut off, so consider shortening it.` : `${length} of about ${max} characters shown before it is cut off.`;
}

function VariantEditor({ asset, onClose, onSaved }: { asset: Asset; onClose: () => void; onSaved: () => void }) {
  const limits = COPY_LIMITS[asset.placement as keyof typeof COPY_LIMITS] ?? COPY_LIMITS.feed;
  const [headline, setHeadline] = useState(asset.headline ?? "");
  const [body, setBody] = useState(asset.body ?? "");
  const [description, setDescription] = useState(asset.policyCheck?.description ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const dirty = headline !== (asset.headline ?? "") || (asset.kind === "copy" && (body !== (asset.body ?? "") || description !== (asset.policyCheck?.description ?? "")));

  // After a failed check, move to the first field with a problem so Save never looks like it did nothing.
  useEffect(() => {
    if (focusTick > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusTick]);

  async function requestClose() {
    if (busy) return;
    if (dirty && !(await confirm({ title: "Discard your changes?", body: "The wording you changed will be lost.", confirmLabel: "Discard changes", tone: "danger" }))) return;
    onClose();
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!headline.trim()) {
      setFocusTick((t) => t + 1);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/api/creative/assets/${asset.id}`, { method: "PATCH", body: asset.kind === "copy" ? { headline, body, description } : { headline } });
      toast.success("Saved. We checked the new wording.");
      onSaved();
    } catch (err) {
      setError(friendlyMessage(err, "We could not save your changes. Check your connection and try again."));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Edit ${asset.kind === "copy" ? "ad text" : "picture headline"}`}
      description={`${placementLabel(asset.placement)}. We check the policy again when you save.`}
      onClose={() => void requestClose()}
      dismissible={!busy}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={() => void requestClose()} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={EDITOR_FORM} loading={busy}>
            Save and check again
          </Button>
        </>
      }
    >
      <form id={EDITOR_FORM} ref={formRef} noValidate className="grid gap-4 max-sm:[&_input]:text-base! max-sm:[&_textarea]:text-base!" onSubmit={(e) => void save(e)}>
        {error && <Alert tone="bad">{error}</Alert>}
        <FormField label="Headline" required hint={countHint(headline.length, limits.headline)} error={touched && !headline.trim() ? "Enter a headline." : null}>
          <Input data-autofocus="" value={headline} onChange={(e) => setHeadline(e.target.value)} />
        </FormField>
        {asset.kind === "copy" && (
          <>
            <FormField label="Main text" hint={countHint(body.length, limits.primaryText)}>
              <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
            </FormField>
            <FormField label="Short description" optional hint={countHint(description.length, limits.description)}>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </FormField>
          </>
        )}
        {asset.kind === "image" && <p className="text-sm text-muted">To change the picture itself, create a new one in the previous step.</p>}
      </form>
    </Dialog>
  );
}
