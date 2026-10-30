"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Card, DataTable, Dialog, EmptyState, ErrorState, FormField, Input, Select, apiFetch, confirm, toast, type Column } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { canManage, useApi, useRole } from "@/components/contacts/hooks";
import { AutomationSettings, type SettingsResponse } from "./AutomationSettings";
import { RULE_FORM_ID, RuleForm } from "./RuleForm";
import { Toggle } from "./Toggle";
import { TYPE_LABEL, describeRule, humanError, type RuleDraft } from "./helpers";
import { linkButton } from "./linkButton";
import { EMPTY_OPTIONS, OUTCOME_LABEL, STARTERS, namesFrom, relativeTime, ruleSentence, type Options, type RuleRow } from "./rulesV2";

type Match = { rule: { id: string; name: string; type: string; replyText: string } | null; matches: { id: string; name: string; does: string[] }[] };

const isV2 = (r: RuleRow) => r.version === 2;

function StarterGallery({ editable }: { editable: boolean }) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {STARTERS.map((s) => (
        <li key={s.id} className="flex">
          <Card title={s.title} description={s.description} className="flex w-full flex-col" footer={editable ? <Link href={`/app/automation/rules/new?starter=${s.id}`} className={linkButton("secondary", "md", "w-full")}>Use this rule</Link> : undefined} />
        </li>
      ))}
    </ul>
  );
}

export function AutomationView() {
  const role = useRole();
  const editable = canManage(role);
  const { data, error, loading, reload } = useApi<{ rules: RuleRow[] }>("/api/automation");
  const options = useApi<Options>("/api/automation/options");
  const settings = useApi<SettingsResponse>("/api/automation/settings");
  const [classic, setClassic] = useState<{ rule: RuleRow; draft: RuleDraft } | null>(null);
  const [busy, setBusy] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [sample, setSample] = useState("");
  const [first, setFirst] = useState(false);
  const [messageType, setMessageType] = useState("text");
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [match, setMatch] = useState<Match | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rules = useMemo(() => data?.rules ?? [], [data]);
  const names = useMemo(() => namesFrom(options.data ?? EMPTY_OPTIONS), [options.data]);
  const v2Ids = useMemo(() => rules.filter(isV2).map((r) => r.id), [rules]);
  const holidayOn = settings.data?.settings.holiday.enabled;

  async function saveClassic(draft: RuleDraft) {
    if (!classic) return;
    setBusy(true);
    setFormError(null);
    try {
      await apiFetch(`/api/automation/${classic.rule.id}`, { method: "PATCH", body: { ...draft, schedule: draft.type === "away" ? draft.schedule : null } });
      toast.success(`"${draft.name}" was updated.`);
      setClassic(null);
      reload();
    } catch (e) {
      setFormError(humanError(e, "save this reply"));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(rule: RuleRow, enabled: boolean) {
    setTogglingId(rule.id);
    try {
      await apiFetch(`/api/automation/${rule.id}`, { method: "PATCH", body: { enabled } });
      toast.success(enabled ? `"${rule.name}" is on.` : `"${rule.name}" is off. It will not run.`);
      reload();
    } catch (e) {
      toast.error(humanError(e, `turn "${rule.name}" ${enabled ? "on" : "off"}`));
    } finally {
      setTogglingId(null);
    }
  }

  async function move(rule: RuleRow, direction: "up" | "down") {
    setMovingId(rule.id);
    try {
      await apiFetch(`/api/automation/${rule.id}/move`, { method: "POST", body: { direction } });
      reload();
    } catch (e) {
      toast.error(humanError(e, `move "${rule.name}"`));
    } finally {
      setMovingId(null);
    }
  }

  async function convert(rule: RuleRow) {
    const ok = await confirm({
      title: `Convert "${rule.name}" to the new format?`,
      body: "It keeps the same conditions, reply and waiting time, and still replies while a teammate is handling the chat. Two things change: each run now counts toward your monthly rule runs, and it goes to the end of your new-format rules, so move it if you want it earlier. Afterwards you can add conditions and steps, such as tags or assigning the chat. You cannot switch it back.",
      confirmLabel: "Convert rule",
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/automation/${rule.id}/convert`, { method: "POST" });
      toast.success(`"${rule.name}" was converted. You can now edit it with conditions and steps.`);
      reload();
    } catch (e) {
      toast.error(humanError(e, `convert "${rule.name}"`));
    }
  }

  async function remove(rule: RuleRow) {
    const ok = await confirm({
      title: `Delete "${rule.name}"?`,
      body: "Customers will no longer get this automatic reply. If you only want a break, switch it off instead.",
      confirmLabel: "Delete rule",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/automation/${rule.id}`, { method: "DELETE" });
      toast.success(`"${rule.name}" was deleted.`);
      reload();
      // The row that held the keyboard focus is about to disappear. Park the focus on the list instead of the top of the page.
      listRef.current?.focus();
    } catch (e) {
      toast.error(humanError(e, "delete this rule"));
    }
  }

  async function runTest(e: React.FormEvent) {
    e.preventDefault();
    setTesting(true);
    setTestError(null);
    try {
      setMatch(await apiFetch<Match>("/api/automation/test", { method: "POST", body: { text: sample, firstMessage: first, messageType } }));
    } catch (err) {
      setMatch(null);
      setTestError(humanError(err, "run the test"));
    } finally {
      setTesting(false);
    }
  }

  const columns: Column<RuleRow>[] = [
    {
      key: "name",
      header: "Rule",
      primary: true,
      sortable: false,
      cell: (r) => {
        const sentence = isV2(r) ? ruleSentence(r, names) : describeRule(r);
        return (
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 font-semibold">
              {r.name}
              {!isV2(r) && <Badge>Classic {TYPE_LABEL[r.type].toLowerCase()}</Badge>}
            </p>
            {sentence && <p className="mt-0.5 line-clamp-3 max-w-xl text-sm text-muted">{sentence}</p>}
          </div>
        );
      },
    },
    {
      key: "order",
      header: "Order",
      cell: (r) => {
        if (!isV2(r)) return <span className="text-muted">After the rules above</span>;
        const index = v2Ids.indexOf(r.id);
        return (
          <div className="flex items-center gap-1.5">
            <span className="w-6 tabular-nums text-muted">{index + 1}</span>
            {editable && (
              <>
                <Button size="sm" variant="ghost" className="max-sm:min-h-10" aria-label={`Up: Run "${r.name}" earlier`} disabled={index === 0 || movingId === r.id} onClick={() => void move(r, "up")}>
                  Up
                </Button>
                <Button size="sm" variant="ghost" className="max-sm:min-h-10" aria-label={`Down: Run "${r.name}" later`} disabled={index === v2Ids.length - 1 || movingId === r.id} onClick={() => void move(r, "down")}>
                  Down
                </Button>
              </>
            )}
          </div>
        );
      },
    },
    {
      key: "last",
      header: "Last run",
      cell: (r) => {
        if (!r.lastRun) return <span className="text-muted">Has not run yet</span>;
        const outcome = OUTCOME_LABEL[r.lastRun.outcome] ?? OUTCOME_LABEL.ok;
        return (
          <div className="space-y-0.5 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <span>{relativeTime(r.lastRun.at)}</span>
              <Badge tone={outcome.tone}>{outcome.label}</Badge>
            </p>
            <p className="text-xs text-muted">{r.runs30d} {r.runs30d === 1 ? "run" : "runs"} in 30 days</p>
          </div>
        );
      },
    },
    {
      key: "on",
      header: "Status",
      cell: (r) =>
        editable ? (
          <Toggle checked={r.enabled} disabled={togglingId === r.id} label={r.name} onChange={(v) => void toggle(r, v)} />
        ) : (
          <Badge tone={r.enabled ? "good" : "neutral"} dot>
            {r.enabled ? "On" : "Off"}
          </Badge>
        ),
    },
    {
      key: "actions",
      header: "Actions",
      srOnlyHeader: true,
      cell: (r) => (
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          {editable &&
            (isV2(r) ? (
              <Link href={`/app/automation/rules/${r.id}`} className={linkButton("secondary", "sm", "max-sm:min-h-10")} aria-label={`Edit ${r.name}`}>
                Edit
              </Link>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  className="max-sm:min-h-10"
                  aria-label={`Edit ${r.name}`}
                  onClick={() => {
                    setFormError(null);
                    setClassic({ rule: r, draft: { ...r } });
                  }}
                >
                  Edit
                </Button>
                <Button size="sm" variant="secondary" className="max-sm:min-h-10" aria-label={`Convert ${r.name} to the new format`} onClick={() => void convert(r)}>
                  Convert
                </Button>
              </>
            ))}
          {isV2(r) && (
            <Link href={`/app/automation/rules/log?rule=${r.id}`} className={linkButton("ghost", "sm", "max-sm:min-h-10")} aria-label={`History of ${r.name}`}>
              History
            </Link>
          )}
          {editable && (
            <Button size="sm" variant="ghost" className="max-sm:min-h-10 text-bad-fg" aria-label={`Delete ${r.name}`} onClick={() => void remove(r)}>
              Delete
            </Button>
          )}
        </div>
      ),
    },
  ];

  const isEmpty = Boolean(data) && rules.length === 0;

  return (
    <div>
      <PageHeader
        title="Automation"
        description="Rules answer and organise chats for you. Pick when a rule starts, what must be true, and what it does. Automatic messages follow WhatsApp's rules: free-form messages only within 24 hours of the customer's last message, and never to people who opted out."
        actions={
          <>
            <Link href="/app/automation/rules/log" className={linkButton("secondary", "md")}>
              Rule history
            </Link>
            <Link href="/app/automation/materials" className={linkButton("secondary", "md")}>
              Reply materials
            </Link>
            <Link href="/app/automation/chatbots" className={linkButton("secondary", "md")}>
              Chatbots
            </Link>
            {editable && (
              <Link href="/app/automation/rules/new" className={linkButton("primary", "md")}>
                New rule
              </Link>
            )}
          </>
        }
      />
      {role && !editable && (
        <Alert tone="info" className="mb-4">
          You can look at your rules. Only admins and owners can change them.
        </Alert>
      )}
      {holidayOn && (
        <Alert tone="warn" title="Holiday mode is on" className="mb-4">
          Every new message gets your holiday reply, and other automatic replies are paused. Switch it off below when you are back.
        </Alert>
      )}

      <div ref={listRef} tabIndex={-1} role="region" aria-label="Your rules">
        {error && !data ? (
          <ErrorState title="We could not load your rules" message="Check your connection and try again." action={<Button onClick={reload}>Try again</Button>} />
        ) : isEmpty ? (
          <div className="space-y-6">
            <EmptyState
              title="No rules yet"
              body="Rules answer customers the moment they write, even when nobody is at the desk, and can tag, assign or follow up for you. Start with one of these."
              action={editable ? <Link href="/app/automation/rules/new" className={linkButton("primary", "md")}>New rule</Link> : undefined}
            />
            <StarterGallery editable={editable} />
          </div>
        ) : (
          <DataTable caption="Your rules" columns={columns} rows={rules} rowKey={(r) => r.id} loading={loading && !data} skeletonRows={3} />
        )}
      </div>

      <section className="mt-8" aria-label="Settings">
        <AutomationSettings data={settings.data} loading={settings.loading} editable={editable} reload={settings.reload} />
      </section>

      <Card className="mt-8" title="Try your rules" description="Type a message a customer might send to see which rules would answer it. Nothing is sent.">
        <form onSubmit={runTest} className="space-y-4">
          <FormField label="Sample message">
            <Input value={sample} maxLength={1000} onChange={(e) => setSample(e.target.value)} placeholder="What are your opening hours?" />
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Kind of message">
              <Select value={messageType} onChange={(e) => setMessageType(e.target.value)}>
                <option value="text">Text</option>
                <option value="image">Photo</option>
                <option value="audio">Voice note</option>
                <option value="document">Document</option>
                <option value="location">Location</option>
              </Select>
            </FormField>
            <label className="flex min-h-10 items-center gap-2.5 self-end text-sm">
              <input type="checkbox" className="h-5 w-5 accent-accent" checked={first} onChange={(e) => setFirst(e.target.checked)} />
              This is the customer&apos;s first message
            </label>
          </div>
          <Button type="submit" variant="secondary" loading={testing}>
            Test message
          </Button>
        </form>
        <div aria-live="polite" className="mt-4">
          {testError && <Alert tone="bad">{testError}</Alert>}
          {match && (
            <div className="space-y-3 rounded-card bg-surface p-3 text-sm">
              {match.matches.length === 0 && !match.rule && <p>No rule would answer this message. Check that the one you expect is switched on and that its conditions fit.</p>}
              {match.matches.length > 0 && (
                <div>
                  <p className="font-semibold">These rules would run, in this order:</p>
                  <ol className="mt-1 list-decimal space-y-1 pl-5">
                    {match.matches.map((m) => (
                      <li key={m.id}>
                        <span className="font-medium">{m.name}</span>: {m.does.join(", ")}
                      </li>
                    ))}
                  </ol>
                  <p className="mt-2 text-xs text-muted">Pauses such as a person already handling the chat, waiting times and your monthly limit can still stop a rule.</p>
                </div>
              )}
              {match.rule && (
                <div>
                  <p>
                    <span className="font-semibold">{match.rule.name}</span> ({match.rule.type} classic reply) would reply:
                  </p>
                  <p className="mt-2 max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-accent px-3.5 py-2 text-on-accent">{match.rule.replyText}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {!isEmpty && editable && (
        <details className="mt-8 rounded-card border border-border p-4">
          <summary className="min-h-10 cursor-pointer text-sm font-semibold leading-10">Recommended rules</summary>
          <div className="mt-3">
            <StarterGallery editable={editable} />
          </div>
        </details>
      )}

      {classic && (
        <Dialog
          title="Edit classic auto-reply"
          description="This rule uses the classic format. Convert it to add conditions and steps."
          onClose={() => setClassic(null)}
          dismissible={!busy}
          wide
          footer={
            <>
              <Button variant="secondary" onClick={() => setClassic(null)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" form={RULE_FORM_ID} loading={busy}>
                Save changes
              </Button>
            </>
          }
        >
          <RuleForm initial={classic.draft} busy={busy} error={formError} onSubmit={(d) => void saveClassic(d)} />
        </Dialog>
      )}
    </div>
  );
}
