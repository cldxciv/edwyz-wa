import type { TenantSpendingView } from "@/lib/admin/spending";
import { Alert, Badge, Card } from "@/components/ui";
import { ActionForm, type ActionField } from "./ActionForm";
import { metaLimitTone, moneyText, OFFBOARD_CHOICE_OPTIONS, POT_NAMES, when } from "./helpers";

const POT_OPTIONS = [
  { value: "ads", label: "Ads" },
  { value: "messaging", label: "WhatsApp" },
  { value: "ai", label: "AI credits" },
];

const SOURCE_WORDS: Record<string, string> = {
  owner: "the owner's limit",
  tenant: "the override for this workspace",
  platform: "the platform ceiling",
  plan: "the plan",
  probation: "the new-workspace limits",
};

/** Which limit is the tightest, in words. */
export function bindingText(binding: string): string {
  return `Set by ${SOURCE_WORDS[binding] ?? "the owner's limit"}`;
}

const PHASE_WORDS: Record<string, string> = {
  requested: "Asked",
  applied: "Done",
  failed: "Failed",
  unconfirmed: "Not confirmed yet",
  refused: "Refused",
  shadow: "Suggestion only",
  reconciled: "Checked with Meta",
  info: "Note",
};

function Period({ label, cell }: { label: string; cell: { spent: { formatted: string }; setAside: { formatted: string }; limit: { formatted: string } | null } }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="tabular-nums">
        {cell.spent.formatted} spent, {cell.setAside.formatted} set aside, limit {moneyText(cell.limit)}
      </dd>
    </div>
  );
}

export const ceilingFields = (defaults: { pot?: string } = {}): ActionField[] => [
  { name: "pot", label: "What it limits", type: "select", options: POT_OPTIONS, defaultValue: defaults.pot ?? "ads" },
  { name: "currency", label: "Currency", defaultValue: "INR", hint: "Three letters, like INR or USD. AI credits ignore this." },
  { name: "daily", label: "Most per day", optional: true, hint: "In the currency's main unit, for example 2000 for ₹2,000, or credits for AI. Leave empty for no daily ceiling." },
  { name: "monthly", label: "Most per month", optional: true, hint: "For AI, this is also how support adds credits beyond the plan. Leave empty for no monthly ceiling." },
  { name: "endDate", label: "Ends after", optional: true, hint: "YYYY-MM-DD. The override stops at the end of that day (UTC). Leave empty to keep it until you remove it." },
];

/** Lowering the owner's limits: either number may stay as it is. */
export const lowerLimitFields = (): ActionField[] => [
  { name: "pot", label: "What it limits", type: "select", options: POT_OPTIONS, defaultValue: "ads" },
  { name: "daily", label: "New daily limit", optional: true, hint: "Lower than today's. Leave empty to keep it." },
  { name: "monthly", label: "New monthly limit", optional: true, hint: "Lower than today's. Leave empty to keep it." },
];

/** Lowering an assistant: the level and both ceilings may each stay as they are. */
export const lowerAssistantFields = (assistants: readonly { assistantKey: string; label: string }[]): ActionField[] => [
  { name: "assistantKey", label: "Assistant", type: "select", options: assistants.map((a) => ({ value: a.assistantKey, label: a.label })) },
  {
    name: "level",
    label: "Lower to level",
    type: "select",
    optional: true,
    options: [
      { value: "", label: "Keep the level" },
      { value: "0", label: "0: suggestions only" },
      { value: "1", label: "1: guarded" },
    ],
    defaultValue: "0",
  },
  { name: "maxDaily", label: "Most it may spend a day", optional: true, hint: "Only lower than today. Leave empty to keep it." },
  { name: "maxMonthly", label: "Most it may spend a month", optional: true, hint: "Only lower than today. Leave empty to keep it." },
];

/**
 * The tenant page's "Spending" card (docs/SPEND-CONTROLS-SPEC.md 8.3): live figures per pot, overrides, open safety stops,
 * Meta's limit, assistants, ad accounts, the last 20 activity rows, and the platform admin's actions (each with a reason).
 */
export function TenantSpendCard({ view, endpoint }: { view: TenantSpendingView; endpoint: string }) {
  const learning = view.assistants.filter((a) => a.mandate?.shadowUntil && new Date(a.mandate.shadowUntil).getTime() > new Date(view.generatedAt).getTime());
  const stopped = view.freeze?.effective && view.freeze.effective !== "none";
  return (
    <section aria-labelledby="spending-heading" className="mt-8">
      <h2 id="spending-heading" className="mb-3 text-lg font-semibold">
        Spending
      </h2>
      <Card description="Live figures, computed now. Every action asks for a reason, is saved in the audit log and in the workspace's spending activity, and applies from the next spending check.">
        <div className="mb-4 flex flex-wrap gap-2">
          {view.demo && <Badge tone="info">Demo: sample data</Badge>}
          {view.freeze && (
            <Badge tone={view.freeze.effective === "all" ? "bad" : view.freeze.effective === "assistants" ? "warn" : "good"} dot>
              {view.freeze.effective === "all" ? "Spending stopped" : view.freeze.effective === "assistants" ? "Assistants stopped" : "Spending on"}
            </Badge>
          )}
          <Badge tone={view.probation?.on ? "info" : "neutral"}>
            New-workspace limits: {view.probationSetting === "forced" ? "forced on" : view.probationSetting === "lifted" ? "lifted" : view.probation?.on ? "on" : "off"}
          </Badge>
          {view.verifiedAt && <Badge tone="good">Verified {when(view.verifiedAt)}</Badge>}
          {view.approvalsWaiting > 0 && <Badge tone="warn">{view.approvalsWaiting} waiting for approval</Badge>}
        </div>
        {view.liveError && (
          <Alert tone="warn" className="mb-4">
            {view.liveError}
          </Alert>
        )}
        {stopped && view.freeze?.text && (
          <Alert tone="warn" className="mb-4">
            {view.freeze.text}
          </Alert>
        )}
        {view.probation?.why && <p className="mb-4 text-sm text-muted">{view.probation.why}</p>}

        {view.pots && (
          <div className="grid gap-4 md:grid-cols-3">
            {view.pots.map((p) => (
              <div key={p.pot} className="min-w-0 rounded-control border border-border p-3">
                <h3 className="text-sm font-semibold">{p.title}</h3>
                <p className="text-xs text-muted">In {p.currency === "CRD" ? "credits" : p.currency}</p>
                <dl className="mt-2 space-y-2 text-sm">
                  <Period label="Today" cell={p.today} />
                  <Period label="This month" cell={p.month} />
                  <div>
                    <dt className="text-xs font-medium text-muted">Owner&apos;s limits</dt>
                    <dd>
                      {moneyText(p.ownerDaily)} a day, {moneyText(p.ownerMonthly)} a month
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium text-muted">Ceiling</dt>
                    <dd>
                      {p.ceilingUnknown ? "Not known in this currency (no row and no fresh exchange rate)" : `${moneyText(p.ceilingDaily, "none")} a day, ${moneyText(p.ceilingMonthly, "none")} a month`}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium text-muted">Applies</dt>
                    <dd>{bindingText(p.binding)}</dd>
                  </div>
                </dl>
                {p.notes.length > 0 && (
                  <ul className="mt-2 space-y-1 text-xs text-muted">
                    {p.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <div className="min-w-0 space-y-3">
            <h3 className="text-sm font-semibold">Overrides for this workspace</h3>
            {view.overrides.length === 0 ? (
              <p className="text-sm text-muted">None. The plan, platform and new-workspace limits apply.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {view.overrides.map((o) => (
                  <li key={o.id} className="space-y-2">
                    <p>
                      <span className="font-medium">{POT_NAMES[o.pot] ?? o.pot}</span>: {moneyText(o.daily, "no ceiling")} a day, {moneyText(o.monthly, "no ceiling")} a month
                      {o.expiresAt ? `, until ${when(o.expiresAt)}` : ""}.{o.reason ? <span className="text-muted"> Why: {o.reason}</span> : null}
                    </p>
                    <ActionForm endpoint={endpoint} label="Remove override" body={{ action: "clear_spend_ceiling", pot: o.pot, currency: o.currency }} description={`The usual ${(POT_NAMES[o.pot] ?? o.pot).toLowerCase()} ceilings apply again.`} />
                  </li>
                ))}
              </ul>
            )}
            <ActionForm
              endpoint={endpoint}
              label="Override ceiling"
              body={{ action: "set_spend_ceiling" }}
              fields={ceilingFields()}
              description="Replaces the plan, platform and new-workspace ceilings for one part of spending. It can raise above the plan or the new-workspace limits, or cut below the owner's limit. For AI it is how you add credits."
            />
            <ActionForm
              endpoint={endpoint}
              label="Lower the owner's limits"
              body={{ action: "lower_spend_limits" }}
              fields={lowerLimitFields()}
              description="For example on abuse. The owner can raise them again later: to make the cut stick, also set an override ceiling."
            />
          </div>

          <div className="min-w-0 space-y-3">
            <h3 className="text-sm font-semibold">Stops and new-workspace limits</h3>
            {stopped ? (
              <ActionForm endpoint={endpoint} label="Turn spending back on" body={{ action: "unfreeze_spending" }} description="Allows spending again within the limits. Nothing restarts by itself: paused ads stay paused until the owner resumes them." />
            ) : (
              <ActionForm
                endpoint={endpoint}
                label="Stop spending"
                danger
                body={{ action: "freeze_spending" }}
                fields={[
                  {
                    name: "level",
                    label: "What to stop",
                    type: "select",
                    options: [
                      { value: "all", label: "All spending: pause every ad, hold automatic messages" },
                      { value: "assistants", label: "Assistants only" },
                    ],
                    defaultValue: "all",
                  },
                ]}
                description="Pauses running ads now (the rest within a minute). Lowering always stays possible."
              />
            )}
            {view.probationSetting !== "lifted" && <ActionForm endpoint={endpoint} label="Lift new-workspace limits" body={{ action: "lift_probation" }} description="The new-workspace ceilings stop applying. The plan and platform ceilings still apply." />}
            <ActionForm
              endpoint={endpoint}
              label="Set new-workspace limits"
              body={{ action: "set_probation" }}
              fields={[
                {
                  name: "setting",
                  label: "Setting",
                  type: "select",
                  options: [
                    { value: "forced", label: "Forced on until lifted" },
                    { value: "auto", label: "Automatic: lift after 2 paid invoices or verification" },
                  ],
                  defaultValue: view.probationSetting === "forced" ? "auto" : "forced",
                },
              ]}
            />
            <ActionForm
              endpoint={endpoint}
              label={view.verifiedAt ? "Remove verification" : "Mark workspace verified"}
              body={{ action: "verify_workspace", verified: !view.verifiedAt }}
              description={view.verifiedAt ? "Automatic new-workspace limits apply again until 2 invoices are paid." : "Lifts automatic new-workspace limits. Use after checking the business."}
            />
          </div>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <div className="min-w-0 space-y-3">
            <h3 className="text-sm font-semibold">Safety stops open</h3>
            {view.breakers.length === 0 ? (
              <p className="text-sm text-muted">None.</p>
            ) : (
              <ul className="space-y-2">
                {view.breakers.map((b) => (
                  <li key={b.id} className="space-y-2 text-sm">
                    <p>
                      <span className="font-medium">{b.label}</span>
                      {b.scopeName ? ` on ${b.scopeName}` : ""}. <span className="text-muted">{b.reason}</span> <span className="text-muted">Since {when(b.trippedAt)}.</span>
                    </p>
                    <ActionForm endpoint={endpoint} label="Clear safety stop" body={{ action: "clear_breaker", breakerId: b.id }} description="Clears the stop only. Anything it paused stays paused for the owner to resume." />
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="min-w-0 space-y-3">
            <h3 className="text-sm font-semibold">Spending limit on Meta</h3>
            {view.metaLimit ? (
              <>
                <p className="text-sm">
                  <Badge tone={metaLimitTone(view.metaLimit.state)}>{view.metaLimit.accountName ?? view.metaLimit.accountExternalId}</Badge> <span className="ml-1">{view.metaLimit.text}</span>
                </p>
                <ActionForm endpoint={endpoint} label="Read Meta's limit again" body={{ action: "resync_meta_limit", adAccountAssetId: view.metaLimit.adAccountAssetId }} description="Reads the limit on Meta now and re-plans it. A change uses Meta's normal daily change budget." />
              </>
            ) : (
              <p className="text-sm text-muted">No spending ad account, so Meta's limit is not used.</p>
            )}
            {view.offboard.length > 0 && (
              <ActionForm
                endpoint={endpoint}
                label="Apply a choice for Meta's limit"
                body={{ action: "meta_limit_offboard" }}
                fields={[
                  {
                    name: "adAccountAssetId",
                    label: "Ad account",
                    type: "select",
                    options: [{ value: "all", label: "Every ad account Edwyz manages" }, ...view.offboard.map((o) => ({ value: o.adAccountAssetId, label: `${o.accountName ?? o.accountExternalId}${o.currentCap ? ` (now ${o.currentCap.formatted})` : ""}` }))],
                    defaultValue: "all",
                  },
                  { name: "choice", label: "What to do", type: "select", options: OFFBOARD_CHOICE_OPTIONS, defaultValue: view.offboard[0]?.selected ?? "keep" },
                ]}
                description="For a workspace that is being suspended or deleted. Edwyz stops managing the limit; the choice is applied while the Meta connection still works."
              />
            )}
          </div>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <div className="min-w-0 space-y-3">
            <h3 className="text-sm font-semibold">Assistants</h3>
            {!view.assistantSpendEnabled && <p className="text-sm text-muted">Assistants only make suggestions for now, on every workspace.</p>}
            <ul className="space-y-1 text-sm">
              {view.assistants.map((a) => (
                <li key={a.assistantKey}>
                  <span className="font-medium">{a.label}</span>: {a.mandate ? `level ${a.mandate.level}${a.mandate.effectiveLevel !== a.mandate.level ? ` (works at ${a.mandate.effectiveLevel} for now)` : ""}${a.mandate.enabled ? "" : ", off"}` : "suggestions only"}
                  {a.shadow.text ? <span className="block text-xs text-muted">{a.shadow.text}</span> : null}
                </li>
              ))}
            </ul>
            <ActionForm
              endpoint={endpoint}
              label="Lower an assistant"
              body={{ action: "lower_assistant_level" }}
              fields={lowerAssistantFields(view.assistants)}
              description="Lowers only, never raises, for example while a problem is checked. Only the owner can raise it again."
            />
            {view.assistantSpendEnabled && learning.length > 0 && (
              <ActionForm
                endpoint={endpoint}
                label="End learning early"
                body={{ action: "end_learning" }}
                fields={[{ name: "assistantKey", label: "Assistant", type: "select", options: learning.map((a) => ({ value: a.assistantKey, label: a.label })) }]}
                description="Only for a test ad account or a verified workspace. The assistant then works at the level the owner chose."
              />
            )}
          </div>

          <div className="min-w-0 space-y-3">
            <h3 className="text-sm font-semibold">Ad accounts</h3>
            {view.adAccounts.length === 0 ? (
              <p className="text-sm text-muted">No ad account connected.</p>
            ) : (
              <ul className="space-y-2">
                {view.adAccounts.map((a) => (
                  <li key={a.assetId} className="space-y-2 text-sm">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{a.name ?? a.externalId}</span>
                      {a.spending && <Badge tone="info">Spending account</Badge>}
                      {a.sandbox && <Badge>Test ad account</Badge>}
                      {a.demo && <Badge>Demo</Badge>}
                    </p>
                    {!a.demo && (
                      <ActionForm
                        endpoint={endpoint}
                        label={a.sandbox ? "Make it a normal ad account" : "Mark as test ad account"}
                        body={{ action: "mark_test_ad_account", adAccountAssetId: a.assetId, sandbox: !a.sandbox }}
                        description={a.sandbox ? "Its figures count in real totals again and Meta's limit can be used." : "For a Meta sandbox account only: Meta's limit is not used and its figures are left out of real totals. Refused while ads are running."}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="mt-6">
          <h3 className="mb-2 text-sm font-semibold">Recent spending activity</h3>
          {view.ledger.length === 0 ? (
            <p className="text-sm text-muted">Nothing yet.</p>
          ) : (
            <ol className="divide-y divide-border rounded-control border border-border text-sm">
              {view.ledger.map((r) => (
                <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 p-2">
                  <span className="min-w-0 flex-1 basis-64">
                    <span className="font-medium">{r.summary}</span> <span className="text-muted">by {r.actor.label}</span>
                    {r.reason ? <span className="block text-xs text-muted">Why: {r.reason}</span> : null}
                  </span>
                  <span className="whitespace-nowrap text-xs text-muted">
                    {PHASE_WORDS[r.phase] ?? r.phase}
                    {r.observe ? " (watched only)" : ""}, {when(r.createdAt)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </Card>
    </section>
  );
}
