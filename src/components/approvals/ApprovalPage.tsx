import { Alert, Badge, Button, Card, Field } from "@/components/ui";
import { MAX_COMMENT_LENGTH } from "@/lib/approvals/constants";
import type { SubjectSummary } from "@/lib/approvals/summary";
import { CommentField } from "./CommentField";
import { decidedCopy, noticeCopy, plainKind, plainRows, plainTitle, reviewIntro } from "./present";

/*
 * The public page a client sees on a phone. Server components, plus one tiny client field for the comment box: the page works
 * on any browser without scripts, and the decision is an ordinary form post. Every value is rendered as a React text node, so hostile strings are escaped.
 */

export function InvalidLink() {
  return (
    <Card>
      <h1 className="text-xl font-semibold">This link no longer works</h1>
      <p className="mt-2 text-base text-muted">It may have expired, or the sender may have replaced it with a new one. Please ask the person who sent it for a new link.</p>
    </Card>
  );
}

export function Intro({ kindLabel }: { kindLabel: string }) {
  const intro = reviewIntro(kindLabel);
  return (
    <header className="mb-4">
      <h1 className="text-2xl font-semibold tracking-tight text-balance">{intro.title}</h1>
      <p className="mt-1.5 text-base text-muted">{intro.hint}</p>
    </header>
  );
}

/** No IDs or tokens are shown. */
export function SummaryCard({ summary }: { summary: SubjectSummary }) {
  const rows = plainRows(summary.rows);
  return (
    <Card>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{plainKind(summary.kindLabel)}</p>
      <h2 className="mt-1 text-xl font-semibold break-words">{plainTitle(summary.kindLabel, summary.title)}</h2>
      {summary.imageUrl ? (
        <div className="mt-4 flex max-h-[45vh] items-center justify-center overflow-hidden rounded-card border border-border bg-surface">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={summary.imageUrl} alt={`Preview of ${plainTitle(summary.kindLabel, summary.title)}`} referrerPolicy="no-referrer" className="max-h-[45vh] w-auto max-w-full object-contain" />
        </div>
      ) : null}
      {summary.text ? <p className="mt-4 whitespace-pre-wrap break-words text-base">{summary.text}</p> : null}
      {rows.length ? (
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {rows.map((r) => (
            <div key={r.label} className="contents">
              <dt className="text-muted">{r.label}</dt>
              <dd className="break-words font-medium">{r.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </Card>
  );
}

const BIG = "min-h-14 w-full text-lg";

/**
 * notice comes from the page address when the decide route sent the client back (?notice=expired|busy|comment).
 * It sits right above the buttons so it is the first thing seen after the page reloads.
 */
export function DecisionForm({ token, nonce, notice }: { token: string; nonce: string; notice?: string | null }) {
  const action = `/api/approvals/${encodeURIComponent(token)}/decide`;
  const message = noticeCopy(notice);
  return (
    <div className="mt-4 space-y-3">
      {message ? (
        <Alert tone="bad" title={message.title}>
          {message.text}
        </Alert>
      ) : null}
      <form method="post" action={action} aria-label="Approve">
        <input type="hidden" name="nonce" value={nonce} />
        <Button type="submit" name="decision" value="approved" size="lg" className={BIG}>
          Approve
        </Button>
        <p className="mt-2 text-center text-sm text-muted">Tells the team it is good to go.</p>
      </form>

      <details open={notice === "comment" || undefined} className="group rounded-card border border-border-strong bg-raised shadow-raised">
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-center rounded-card px-5 text-lg font-semibold [&::-webkit-details-marker]:hidden">
          Request changes
          <span aria-hidden className="ml-2 text-base transition-transform duration-(--dur-fast) group-open:rotate-180">
            ▾
          </span>
        </summary>
        <form method="post" action={action} aria-label="Request changes" className="space-y-4 border-t border-border p-4">
          <input type="hidden" name="nonce" value={nonce} />
          <Field label="What should change?" htmlFor="comment" required hint="Write it in your own words. For example: change the price, or use a different photo.">
            <CommentField id="comment" name="comment" maxLength={MAX_COMMENT_LENGTH} />
          </Field>
          <Button type="submit" name="decision" value="changes_requested" size="lg" className={BIG}>
            Send my changes
          </Button>
          <details className="group/decline border-t border-border pt-3">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-center rounded-control px-3 text-base font-medium text-muted underline underline-offset-4 [&::-webkit-details-marker]:hidden">
              Not right at all? Decline this
            </summary>
            <div className="mt-2 space-y-3 rounded-control border border-border bg-surface p-3">
              <p className="text-base">Declining ends this review. The team is told you do not want it as it is. You cannot undo this.</p>
              <Button type="submit" name="decision" value="rejected" variant="secondary" size="lg" formNoValidate className="w-full">
                Yes, decline this
              </Button>
            </div>
          </details>
        </form>
      </details>
      <p className="text-center text-sm text-muted">If nothing happens when you tap, reload this page and tap again.</p>
    </div>
  );
}

export function DecidedNotice({ decision }: { decision: string }) {
  const d = decidedCopy(decision);
  return (
    <Card role="status">
      <Badge tone={d.tone} dot>
        {d.label}
      </Badge>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-balance">{d.title}</h1>
      <p className="mt-1.5 text-base text-muted">{d.text}</p>
    </Card>
  );
}
