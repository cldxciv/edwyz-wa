"use client";

/**
 * Step 3 of the guided setup: the first broadcast (docs/EDDY-SPEC.md 6.8 step 3, D5, EDDY-17 acceptance 4).
 *
 * Audience chips (everyone who opted in, a tag, or a saved segment), then [Plan it with Eddy] sends the member's own message
 * and Eddy goes through preview_audience (the reach; marketing counts opted-in contacts only and the rest are flagged),
 * create_broadcast_draft (with Undo) and estimate_broadcast ("1,240 contacts · About ₹1,430 · needs 2 days at your messaging
 * limit"). The ending is v1's: [Review and start] opens the existing broadcast page, where a person starts it with the
 * existing confirmation and Phase 0 gates it there. Eddy never starts a broadcast in v1.
 *
 * The draft Eddy made is known from wa:eddy-did {entity: "broadcast"}, so [Review and start] opens that broadcast. When Eddy
 * can't chat, the card links to the broadcasts page instead, so it never strands.
 */
import { useEffect, useId, useState } from "react";
import { Button, cn, Input } from "@/components/ui";
import { audienceLabel, audienceName, AUDIENCES, broadcastQuery, reviewPath, tg, type Audience, type GuideCard } from "@/lib/eddy/guides";
import { htmlLang, type EddyLang } from "@/lib/eddy/i18n";
import { EDDY_EVENTS, onEddyEvent } from "../events";
import { ProgressSteps, type ProgressStep } from "../ProgressSteps";
import { GuideLink } from "./SetupGuide";
import { ChipGroup } from "./TemplateStep";

export type BroadcastAnswers = { audience: Audience | null; name: string; sent: boolean; draftId: string | null };

export function broadcastProgress(lang: EddyLang, a: BroadcastAnswers): ProgressStep[] {
  const s = (done: boolean, current: boolean): ProgressStep["state"] => (done ? "done" : current ? "current" : "todo");
  return [
    { id: "audience", label: tg(lang, "guides.broadcast.progress.audience"), state: s(a.sent, !a.sent) },
    { id: "reach", label: tg(lang, "guides.broadcast.progress.reach"), state: s(!!a.draftId, a.sent && !a.draftId) },
    { id: "draft", label: tg(lang, "guides.broadcast.progress.draft"), state: s(!!a.draftId, false) },
    { id: "cost", label: tg(lang, "guides.broadcast.progress.cost"), state: s(false, !!a.draftId) },
    { id: "start", label: tg(lang, "guides.broadcast.progress.start"), state: s(false, false) },
  ];
}

export type BroadcastStepProps = {
  lang: EddyLang;
  card: GuideCard;
  canChat: boolean;
  onAsk: (query: string) => void;
  onNavigate?: (path: string) => void;
  initial?: Partial<BroadcastAnswers>;
};

export function BroadcastStep({ lang, card, canChat, onAsk, onNavigate, initial }: BroadcastStepProps) {
  const [a, setA] = useState<BroadcastAnswers>({ audience: initial?.audience ?? null, name: initial?.name ?? "", sent: initial?.sent ?? false, draftId: initial?.draftId ?? null });
  const [problem, setProblem] = useState<string | null>(null);
  const inputId = useId();
  const body = lang === "hi" ? "text-base leading-[1.6]" : "text-sm";

  // Eddy's create_broadcast_draft tells the pages what changed (6.4): that id is the draft to review.
  useEffect(() => {
    if (!a.sent) return;
    return onEddyEvent(EDDY_EVENTS.did, (d) => {
      if (d.entity === "broadcast" && d.ids[0]) setA((x) => ({ ...x, draftId: d.ids[0] }));
    });
  }, [a.sent]);

  if (!canChat) {
    return (
      <div className="flex flex-col gap-2" data-guide-broadcast="off" lang={htmlLang(lang)}>
        <p className={cn("text-muted", body)}>{tg(lang, "guides.broadcast.ai_off")}</p>
        <p className={cn("text-muted", body)}>{tg(lang, "guides.broadcast.opt_in_note")}</p>
        <div className="flex flex-wrap gap-2">
          <GuideLink path={card.primary?.path ?? "/app/broadcasts/new"} label={card.primary?.label ?? tg(lang, "guides.broadcast.self")} primary onNavigate={onNavigate} part="primary" />
        </div>
      </div>
    );
  }

  const needsName = a.audience === "tag" || a.audience === "segment";
  const send = () => {
    if (!a.audience) return;
    const q = broadcastQuery(lang, a.audience, a.name);
    if (!q) {
      setProblem(tg(lang, "guides.broadcast.name_needed"));
      return;
    }
    setProblem(null);
    onAsk(q);
    setA((x) => ({ ...x, sent: true, name: needsName ? audienceName(x.name) ?? "" : "" }));
  };

  return (
    <div className="flex flex-col gap-3" data-guide-broadcast={a.sent ? (a.draftId ? "draft" : "sent") : a.audience ? "ready" : "audience"} lang={htmlLang(lang)}>
      <ProgressSteps steps={broadcastProgress(lang, a)} lang={lang} />
      {!a.sent && (
        <>
          <ChipGroup lang={lang} label={tg(lang, "guides.broadcast.q_audience")} value={a.audience} options={AUDIENCES.map((x) => ({ value: x, label: audienceLabel(lang, x) }))} onPick={(audience) => setA((x) => ({ ...x, audience }))} />
          {needsName && (
            <div className="flex flex-col gap-1">
              <label htmlFor={inputId} className="text-sm font-semibold text-foreground">
                {tg(lang, a.audience === "tag" ? "guides.broadcast.tag_label" : "guides.broadcast.segment_label")}
              </label>
              <Input id={inputId} value={a.name} maxLength={60} className="text-base" aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${inputId}-problem` : undefined} onChange={(e) => setA((x) => ({ ...x, name: e.target.value }))} />
              {problem && (
                <p id={`${inputId}-problem`} className="text-xs text-bad-fg">
                  {problem}
                </p>
              )}
            </div>
          )}
          <p className={cn("text-muted", body)}>{tg(lang, "guides.broadcast.opt_in_note")}</p>
          <p className={cn("text-muted", body)}>{tg(lang, "guides.broadcast.after")}</p>
          <div className="flex flex-wrap gap-2">
            {a.audience ? (
              <Button type="button" size="sm" className="pointer-coarse:min-h-11" onClick={send} data-guide-part="primary">
                {tg(lang, "guides.broadcast.plan")}
              </Button>
            ) : null}
            <GuideLink path={card.primary?.path ?? "/app/broadcasts/new"} label={tg(lang, "guides.broadcast.self")} onNavigate={onNavigate} part={a.audience ? "self" : "primary"} />
          </div>
        </>
      )}
      <p role="status" aria-live="polite" className={a.sent ? cn("text-muted", body) : "sr-only"}>
        {a.sent ? tg(lang, "guides.broadcast.sent") : ""}
      </p>
      {a.sent && (
        <div className="flex flex-wrap gap-2">
          {/* v1: the member starts the broadcast on its page, with the existing confirmation (6.8, D5). */}
          <GuideLink path={reviewPath(a.draftId)} label={tg(lang, "guides.broadcast.review")} primary onNavigate={onNavigate} part="review" />
          <Button type="button" variant="ghost" size="sm" className="pointer-coarse:min-h-11" onClick={() => setA({ audience: null, name: "", sent: false, draftId: null })}>
            {tg(lang, "guides.template.change")}
          </Button>
        </div>
      )}
    </div>
  );
}
