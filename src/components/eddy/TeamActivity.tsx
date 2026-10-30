"use client";

/**
 * Menu > Team activity (docs/EDDY-SPEC.md 6.9): the front desk for what runs automatically.
 *
 * One card per automation (AI agent, chatbots, rules, lead follow-ups, cart reminders): its on/off state, the last 24 hours,
 * what is waiting for the team, and a Settings link. Turning something off is instant (lowering): one tap, POST
 * /api/notices { op: "automation_off" }, for admins and the owner. Turning something on is a card: the member asks Eddy, by
 * kind and id only, and Eddy shows the enable_automation preview (what it will do, before anything starts). In v2 the
 * Phase 0 assistants join this list. Names are the workspace's own text, rendered as plain text. Tokens only; wraps at
 * 360 px; the result of a tap is announced politely.
 */
import { useCallback, useEffect, useId, useState } from "react";
import { Alert, Badge, Button, Card, Spinner } from "@/components/ui";
import { safeAppPath, type EddyLang } from "@/lib/eddy/contract";
import { tn } from "@/lib/eddy/copy/notices";
import { htmlLang, t } from "@/lib/eddy/i18n";

export const AUTOMATION_KINDS = ["ai_agent", "chatbot", "rule", "lead_sequence", "cart_reminders"] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

export type ActivityItemDTO = { kind: AutomationKind; id: string; name: string; enabled: boolean; last24h: number | null; waiting: number; settingsPath: string };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The activity response, checked item by item; anything unexpected is dropped. */
export function parseActivity(json: unknown): { items: ActivityItemDTO[]; canManage: boolean } | null {
  if (!isObj(json) || !Array.isArray(json.activity)) return null;
  const items: ActivityItemDTO[] = [];
  for (const v of json.activity) {
    if (!isObj(v) || !(AUTOMATION_KINDS as readonly string[]).includes(v.kind as string) || typeof v.id !== "string" || !ID.test(v.id)) continue;
    const path = safeAppPath(v.settingsPath);
    items.push({
      kind: v.kind as AutomationKind,
      id: v.id,
      name: typeof v.name === "string" ? v.name.slice(0, 80) : "",
      enabled: v.enabled === true,
      last24h: typeof v.last24h === "number" && Number.isFinite(v.last24h) ? Math.max(0, Math.floor(v.last24h)) : null,
      waiting: typeof v.waiting === "number" && Number.isFinite(v.waiting) ? Math.max(0, Math.floor(v.waiting)) : 0,
      settingsPath: path ?? "/app/automation",
    });
  }
  return { items, canManage: json.canManage === true };
}

/** What the member asks Eddy to turn something on: kind and id only, never the automation's own text. */
export function turnOnQuery(lang: EddyLang, item: Pick<ActivityItemDTO, "kind" | "id">): string {
  return tn(lang, "notices.activity.turn_on_query", { kind: item.kind, id: item.id });
}

export type TeamActivityViewProps = {
  lang: EddyLang;
  state: "loading" | "error" | "ready";
  items: readonly ActivityItemDTO[];
  canManage: boolean;
  /** Eddy can take a request now (ready, not answering): Turn on goes through Eddy's card. */
  eddyReady: boolean;
  busyId?: string | null;
  message?: string;
  onTurnOff: (item: ActivityItemDTO) => void;
  onTurnOn: (item: ActivityItemDTO) => void;
  onNavigate: (path: string) => void;
  onRetry: () => void;
  onClose?: () => void;
};

export function TeamActivityView({ lang, state, items, canManage, eddyReady, busyId, message, onTurnOff, onTurnOn, onNavigate, onRetry, onClose }: TeamActivityViewProps) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} lang={htmlLang(lang)} className="flex min-w-0 flex-col gap-3 p-1" data-eddy-team-activity>
      <h3 id={headingId} className="px-1 text-sm font-semibold tracking-tight">
        {tn(lang, "notices.activity.title")}
      </h3>
      {state === "loading" && <Spinner label={tn(lang, "notices.activity.loading")} />}
      {state === "error" && (
        <Alert
          tone="bad"
          action={
            <Button type="button" size="sm" variant="secondary" className="pointer-coarse:min-h-11" onClick={onRetry}>
              {t(lang, "btn.retry")}
            </Button>
          }
        >
          {tn(lang, "notices.activity.failed")}
        </Alert>
      )}
      {state === "ready" && items.length === 0 && <p className="px-1 text-sm text-muted">{tn(lang, "notices.activity.empty")}</p>}
      {state === "ready" && items.length > 0 && !canManage && <p className="px-1 text-xs text-muted">{tn(lang, "notices.activity.admin_only")}</p>}
      {state === "ready" && items.length > 0 && (
        <ul className="flex min-w-0 flex-col gap-2">
          {items.map((item) => (
            <li key={`${item.kind}:${item.id}`} className="min-w-0">
              <Card padded={false} className="flex min-w-0 flex-col gap-2 p-3" data-activity-kind={item.kind}>
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-semibold">{item.name || tn(lang, `notices.activity.kind.${item.kind}`)}</p>
                    <p className="text-xs text-muted">{tn(lang, `notices.activity.kind.${item.kind}`)}</p>
                  </div>
                  <Badge tone={item.enabled ? "good" : "neutral"} dot>
                    {tn(lang, item.enabled ? "notices.activity.on" : "notices.activity.off")}
                  </Badge>
                </div>
                <p className="text-sm text-muted">{item.last24h ? tn(lang, "notices.activity.last24h", { count: item.last24h }) : tn(lang, "notices.activity.last24h_none")}</p>
                {item.waiting > 0 && <p className="text-sm font-medium text-warn-fg">{tn(lang, "notices.activity.waiting", { count: item.waiting })}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  {canManage && item.enabled && (
                    <Button type="button" size="sm" variant="secondary" className="pointer-coarse:min-h-11" loading={busyId === `${item.kind}:${item.id}`} aria-label={tn(lang, "notices.activity.turn_off.a11y", { name: item.name })} onClick={() => onTurnOff(item)}>
                      {tn(lang, "notices.activity.turn_off")}
                    </Button>
                  )}
                  {canManage && !item.enabled && eddyReady && (
                    <Button type="button" size="sm" variant="secondary" className="pointer-coarse:min-h-11" aria-label={tn(lang, "notices.activity.turn_on.a11y", { name: item.name })} onClick={() => onTurnOn(item)}>
                      {tn(lang, "notices.activity.turn_on")}
                    </Button>
                  )}
                  <Button type="button" size="sm" variant="ghost" className="pointer-coarse:min-h-11" aria-label={tn(lang, "notices.activity.settings.a11y", { name: item.name })} onClick={() => onNavigate(item.settingsPath)}>
                    {tn(lang, "notices.activity.settings")}
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <p role="status" aria-live="polite" className={message ? "px-1 text-xs text-muted" : "sr-only"}>
        {message ?? ""}
      </p>
      {onClose && (
        <Button type="button" variant="ghost" size="sm" className="self-start pointer-coarse:min-h-11" onClick={onClose}>
          {t(lang, "btn.close")}
        </Button>
      )}
    </section>
  );
}

/** POST /api/notices { op: "automation_off" }: true when it is off now. */
export async function turnOff(item: Pick<ActivityItemDTO, "kind" | "id">): Promise<boolean> {
  try {
    const res = await fetch("/api/notices", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "automation_off", kind: item.kind, id: item.id }) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Team activity with its data (GET /api/notices?view=activity on open). */
export function TeamActivity({ lang, eddyReady, onNavigate, onAsk, onClose }: { lang: EddyLang; eddyReady: boolean; onNavigate: (path: string) => void; onAsk: (query: string) => void; onClose?: () => void }) {
  const [state, setState] = useState<"loading" | "error" | "ready">("loading");
  const [items, setItems] = useState<ActivityItemDTO[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const res = await fetch("/api/notices?view=activity", { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } });
      const parsed = res.ok ? parseActivity(await res.json().catch(() => null)) : null;
      if (!parsed) return setState("error");
      setItems(parsed.items);
      setCanManage(parsed.canManage);
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const off = async (item: ActivityItemDTO) => {
    setBusyId(`${item.kind}:${item.id}`);
    const ok = await turnOff(item);
    setBusyId(null);
    if (ok) setItems((list) => list.map((i) => (i.kind === item.kind && i.id === item.id ? { ...i, enabled: false } : i)));
    setMessage(ok ? tn(lang, "notices.activity.turned_off", { name: item.name }) : tn(lang, "notices.activity.turn_off_failed"));
  };

  return (
    <TeamActivityView
      lang={lang}
      state={state}
      items={items}
      canManage={canManage}
      eddyReady={eddyReady}
      busyId={busyId}
      message={message}
      onTurnOff={(item) => void off(item)}
      onTurnOn={(item) => onAsk(turnOnQuery(lang, item))}
      onNavigate={onNavigate}
      onRetry={() => void load()}
      onClose={onClose}
    />
  );
}
