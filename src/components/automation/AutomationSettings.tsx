"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, FormField, ProgressBar, Select, Skeleton, Textarea, Input, apiFetch, toast } from "@/components/ui";
import { LIMITS } from "@/lib/automation/v2/model";
import { PLACEHOLDER_HELP } from "@/lib/automation/v2/variables";
import { OPT_OUT_RULES } from "@/lib/contacts/opt-out";
import { browserTimezone, humanError, timezoneOptions } from "./helpers";
import { Toggle } from "./Toggle";

export type SettingsResponse = {
  settings: { mode: "first_match" | "all_matching"; holiday: { enabled: boolean; message: string; endsOn: string | null; timezone: string } };
  usage: { used: number; limit: number | null; percent: number | null; resetsOn: string };
  holidayRunning?: boolean;
};

const number = new Intl.NumberFormat("en");

export function UsageMeter({ usage }: { usage: SettingsResponse["usage"] }) {
  const resets = new Date(usage.resetsOn).toLocaleDateString(undefined, { day: "numeric", month: "long" });
  if (usage.limit === null) {
    return (
      <p className="text-sm text-muted">
        <span className="font-semibold text-foreground">{number.format(usage.used)}</span>{" "}rule runs this month. Your plan has no limit on rule runs.
      </p>
    );
  }
  const over = usage.limit > 0 && usage.used >= usage.limit;
  return (
    <div className="space-y-2">
      <ProgressBar label="Rule runs this month" showLabel showValue value={usage.used} max={Math.max(usage.limit, 1)} valueText={`${number.format(usage.used)} of ${number.format(usage.limit)}`} tone="auto" warnAt={80} dangerAt={100} />
      <p className="text-xs text-muted">The count starts over on {resets}.</p>
      {over ? (
        <Alert tone="bad" title="Your rules have paused for this month">
          You have used all the rule runs in your plan. Holiday mode pauses too. Classic auto-replies you have not converted keep working. Upgrade your plan to run rules again before {resets}.
        </Alert>
      ) : (
        (usage.percent ?? 0) >= 80 && <Alert tone="warn">You have used {usage.percent}% of this month&apos;s rule runs.</Alert>
      )}
    </div>
  );
}

type Props = { data: SettingsResponse | null; loading: boolean; editable: boolean; reload: () => void };

/** Run mode, holiday mode and monthly usage. Everything saves with its own button; nothing changes while typing. */
export function AutomationSettings({ data, loading, editable, reload }: Props) {
  const zones = useMemo(() => timezoneOptions(), []);
  const [message, setMessage] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const holiday = data?.settings.holiday;

  useEffect(() => {
    if (!holiday) return;
    setMessage(holiday.message);
    setEndsOn(holiday.endsOn ?? "");
    setTimezone(holiday.timezone === "UTC" && !holiday.message ? browserTimezone() : holiday.timezone);
  }, [holiday]);

  async function save(what: string, body: unknown, done: string) {
    setBusy(what);
    setError(null);
    try {
      await apiFetch("/api/automation/settings", { method: "PATCH", body });
      toast.success(done);
      reload();
    } catch (e) {
      setError(humanError(e, "save this setting"));
    } finally {
      setBusy(null);
    }
  }

  if (loading && !data) return <Skeleton className="h-40 w-full" />;
  if (!data) return null;
  const dirty = message.trim() !== holiday?.message || (endsOn || null) !== holiday?.endsOn || timezone !== holiday?.timezone;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Holiday mode" description="Answer new messages with one holiday reply while you are away. Your other automatic replies pause until it ends. Chats a teammate or chatbot is handling are left alone.">
        <div className="space-y-4">
          {data.settings.holiday.enabled && data.holidayRunning === false && (
            <Alert tone="warn" title="Holiday mode is on but not sending">
              {data.settings.holiday.message.trim() ? "Its last day has passed. Switch it off or pick a new last day." : "It has no holiday message yet."}
            </Alert>
          )}
          <Toggle
            checked={data.settings.holiday.enabled}
            label="Holiday mode"
            disabled={!editable || busy === "holiday"}
            onChange={(enabled) => void save("holiday", { holiday: { enabled, message: message.trim(), endsOn: endsOn || null, timezone } }, enabled ? "Holiday mode is on." : "Holiday mode is off.")}
          />
          <FormField label="Holiday message" hint={`${message.length}/${LIMITS.text}. Sent once per chat every 12 hours. You can use ${PLACEHOLDER_HELP[0].token}.`}>
            <Textarea rows={3} value={message} maxLength={LIMITS.text} disabled={!editable} onChange={(e) => setMessage(e.target.value)} placeholder="e.g. We are on holiday until Monday. We will reply as soon as we are back." />
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Last day" optional hint="Leave empty to keep it on until you switch it off.">
              <Input type="date" value={endsOn} disabled={!editable} onChange={(e) => setEndsOn(e.target.value)} />
            </FormField>
            <FormField label="Timezone">
              <Select value={timezone} disabled={!editable} onChange={(e) => setTimezone(e.target.value)}>
                {(zones.includes(timezone) ? zones : [timezone, ...zones]).map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
          {editable && (
            <Button variant="secondary" disabled={!dirty || !message.trim()} loading={busy === "holiday-save"} onClick={() => void save("holiday-save", { holiday: { message: message.trim(), endsOn: endsOn || null, timezone } }, "Holiday settings saved.")}>
              Save holiday settings
            </Button>
          )}
          {error && <Alert tone="bad">{error}</Alert>}
        </div>
      </Card>

      <Card title="How your rules run" description="Pick what happens when more than one rule fits the same message.">
        <div className="space-y-5">
          <FormField label="When several rules fit">
            <Select value={data.settings.mode} disabled={!editable || busy === "mode"} onChange={(e) => void save("mode", { mode: e.target.value }, "Saved.")}>
              <option value="first_match">Use only the first rule that replies</option>
              <option value="all_matching">Run every rule that fits</option>
            </Select>
          </FormField>
          <p className="text-sm text-muted">
            Rules run from top to bottom. Rules that only tag, assign or notify never block the ones below. A rule set to &quot;Stop here&quot; always ends the run. Customers never get automatic replies while a chatbot is talking with them. {OPT_OUT_RULES}
          </p>
          <UsageMeter usage={data.usage} />
        </div>
      </Card>
    </div>
  );
}
