"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { COMPANY } from "@/lib/config";
import type { MetaLimitDTO, MetaOffboardChoice } from "@/lib/spend/types";
import { Alert, apiFetch, Badge, Button, Card, Dialog, EmptyState, FormField, Input, PageHeader, Spinner } from "@/components/ui";

type Asset = { id: string; type: string; externalId: string; name: string | null; status: string; meta?: { leadgenSubscription?: { status?: string; reason?: string } } | null };
type Connection = {
  id: string;
  metaUserId: string;
  scopes: string[];
  status: string;
  tokenExpiresAt: string | null;
  lastCheckedAt: string | null;
  missingScopes: string[];
  unusedScopes?: string[];
  sharedWithOtherWorkspace?: boolean;
  assets: Asset[];
};
type Payload = { connections: Connection[]; scopes: { scope: string; purpose: string }[]; configured: boolean };

/** GET /api/spend/meta-limit (docs/SPEND-CONTROLS-SPEC.md 5.1, 5.8). */
export type ConsentScreen = { textVersion: string; title: string; body: string[]; checkbox: string; button: string; existingCap: string | null };
export type OffboardAccount = { adAccountAssetId: string; accountName: string | null; accountExternalId: string; choices: { choice: MetaOffboardChoice; label: string }[]; selected: MetaOffboardChoice };
export type MetaLimitPayload = { metaLimit: MetaLimitDTO | null; consent: ConsentScreen | null; offboard: OffboardAccount[] };

const TYPE_LABEL: Record<string, string> = { page: "Facebook Pages", instagram: "Instagram accounts", ad_account: "Ad accounts", dataset: "Datasets (pixels)", catalog: "Catalogs", threads: "Threads" };
const STATUS_LABEL: Record<string, string> = { active: "Connected", expiring: "Token expiring", expired: "Expired, reconnect", revoked: "Disconnected", error: "Error", inactive: "No longer available" };
const tone = (s: string) => (s === "active" ? "good" : s === "expiring" ? "warn" : s === "expired" || s === "error" ? "bad" : "neutral");
const RESULT: Record<string, string> = {
  connected: "Connected. Your assets are listed below.",
  cancelled: "The Meta login was cancelled. Nothing was changed.",
  failed: "The connection could not be completed. Please try again.",
};
const fmt = (d: string | null) => (d ? new Date(d).toLocaleString() : "Never");

/** The word the owner types to disconnect while some campaigns could not be paused (5.9). */
export const DISCONNECT_WORD = "DISCONNECT";
export const ADMIN_PENDING_TEXT = "Only the workspace owner can turn on Meta's spending limit. We've let them know.";

/**
 * The line above the connection list when this server cannot start a Meta login. With no connections the empty state
 * already explains it, so nothing is repeated; with connections the wording must not contradict the "Connected" cards below.
 */
export function notConfiguredNotice(configured: boolean, connections: number): string | null {
  if (configured || connections === 0) return null;
  return "Connecting another Facebook account is not switched on for this server yet. The accounts below were connected earlier and still work.";
}

/** The plain result line after a disconnect, naming Meta's limit when it stays (5.9). */
export function disconnectNotice(r: { revokedAtMeta?: boolean; skippedSharedUser?: boolean; pagesUnsubscribeFailed?: number; metaLimitText?: string | null }): string {
  const base = r.skippedSharedUser
    ? "Disconnected here. Access at Meta was not revoked because the same Facebook account is connected to another workspace."
    : r.revokedAtMeta
      ? "Disconnected, and access was revoked at Meta."
      : "Disconnected here. Meta did not confirm the revoke; you can remove Edwyz in your Facebook business integrations settings.";
  const failed = r.pagesUnsubscribeFailed ?? 0;
  const pages = failed > 0 ? ` Lead alerts could not be removed at Meta for ${failed} Page${failed === 1 ? "" : "s"}; Edwyz ignores them, and you can remove the app from those Pages in Facebook.` : "";
  return `${base}${pages}${r.metaLimitText ? ` ${r.metaLimitText}` : ""}`;
}

/** The blocked state of a disconnect (409 meta_connect.pause_failed), or null for any other error. */
export function blockedDisconnect(error: unknown): { text: string; campaigns: { id: string; name: string }[]; canForce: boolean } | null {
  const body = (error as { body?: { code?: unknown; error?: unknown; campaigns?: unknown; canForce?: unknown } } | null)?.body;
  if (!body || body.code !== "meta_connect.pause_failed") return null;
  const campaigns = Array.isArray(body.campaigns) ? (body.campaigns as { id: string; name: string }[]).filter((c) => c && typeof c.id === "string") : [];
  return { text: typeof body.error === "string" ? body.error : "We couldn't pause some campaigns on Meta yet.", campaigns, canForce: body.canForce === true };
}

export function ConnectionsPanel() {
  const [data, setData] = useState<Payload | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [meta, setMeta] = useState<MetaLimitPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<Connection | null>(null);

  const load = useCallback(async () => {
    try {
      const [payload, me] = await Promise.all([apiFetch<Payload>("/api/meta-connect/connections"), apiFetch<{ role: string }>("/api/auth/me")]);
      setData(payload);
      setRole(me.role);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load connections.");
    }
    // Meta's limit is a separate card: when it cannot be read the connections still show.
    setMeta(await apiFetch<MetaLimitPayload>("/api/spend/meta-limit").catch(() => null));
  }, []);

  useEffect(() => {
    const status = new URLSearchParams(window.location.search).get("status");
    if (status && RESULT[status]) setNotice(RESULT[status]);
    void load();
  }, [load]);

  async function act(key: string, run: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await run();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  const connect = () =>
    act("connect", async () => {
      const { url } = await apiFetch<{ url: string }>("/api/meta-connect/start", { method: "POST", body: {} });
      window.location.assign(url);
    });
  const refresh = async (id: string) => {
    setRefreshFailed(null);
    setBusy(`r:${id}`);
    setError(null);
    try {
      await apiFetch("/api/meta-connect/refresh", { method: "POST", body: { connectionId: id } });
      await load();
    } catch (e) {
      // Meta usually refuses a refresh because the saved login expired or was revoked. Say what to do, not only that it failed.
      setRefreshFailed(id);
      const what = e instanceof Error && e.message ? e.message.replace(/\.?$/, ".") : "Could not refresh your assets.";
      setError(
        data?.configured
          ? `${what} Meta may have stopped accepting this saved login. Press Reconnect and approve everything to fix it.`
          : `${what} Meta may have stopped accepting this saved login. Reconnecting is not switched on for this server yet, so email ${COMPANY.email} and we will help.`,
      );
    } finally {
      setBusy(null);
    }
  };

  if (!data) return error ? <p role="alert" className="text-sm text-bad-fg">{error}</p> : <Spinner label="Loading" />;
  const canManage = role === "owner" || role === "admin";

  return (
    <>
      <PageHeader
        title="Connections"
        description="Connect Facebook, Instagram and ads so Edwyz can run campaigns, capture leads and publish for you."
        actions={canManage && data.configured ? <Button onClick={() => void connect()} disabled={busy !== null}>{busy === "connect" ? "Opening Meta" : "Connect with Facebook"}</Button> : undefined}
      />
      {notice && <p role="status" className="mb-4 rounded-lg border border-border bg-surface px-4 py-3 text-sm">{notice}</p>}
      {error && <p role="alert" className="mb-4 text-sm text-bad-fg">{error}</p>}
      {notConfiguredNotice(data.configured, data.connections.length) && <p className="mb-4 text-sm text-muted">{notConfiguredNotice(data.configured, data.connections.length)}</p>}
      {!canManage && <p className="mb-4 text-sm text-muted">Only an owner or admin can connect, refresh or disconnect.</p>}

      {meta?.metaLimit && role && <MetaLimitStep payload={meta} role={role} onConnectAgain={data.configured ? () => void connect() : null} onChanged={() => void load()} />}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          {data.connections.length === 0 && (
            <EmptyState
              title="Nothing connected yet"
              body={
                data.configured || !canManage
                  ? "Connect a Facebook account to discover your Pages, Instagram accounts, ad accounts, pixels and catalogs."
                  : `Connecting Pages, Instagram and ads is not switched on for this server yet, so there is nothing to press here. Email ${COMPANY.email} and we will tell you when it is ready.`
              }
              action={
                !data.configured && canManage ? (
                  <Button variant="secondary" onClick={() => window.location.assign(`mailto:${COMPANY.email}?subject=${encodeURIComponent("Enable Meta connections")}`)}>
                    Email support
                  </Button>
                ) : undefined
              }
            />
          )}
          {data.connections.map((c) => (
            <Card key={c.id}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">Facebook account</p>
                  <p className="break-all text-xs text-muted">
                    Meta user id {c.metaUserId}. Expires: {fmt(c.tokenExpiresAt)}. Last checked: {fmt(c.lastCheckedAt)}.
                  </p>
                </div>
                <Badge tone={tone(c.status)}>{STATUS_LABEL[c.status] ?? c.status}</Badge>
              </div>
              {c.missingScopes.length > 0 && (
                <p className="mt-3 break-words text-sm text-warn-fg">Permission missing: {c.missingScopes.join(", ")}. Reconnect and approve everything to enable all features.</p>
              )}
              {(c.unusedScopes?.length ?? 0) > 0 && (
                <p className="mt-3 break-words text-sm text-warn-fg">
                  This login also grants permissions Edwyz does not use: {c.unusedScopes?.join(", ")}. An owner of the Meta app should remove them from the Login for Business configuration, then reconnect.
                </p>
              )}
              <AssetGroups assets={c.assets} />
              {canManage && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {c.status !== "revoked" && (
                    <Button size="sm" variant="secondary" onClick={() => void refresh(c.id)} disabled={busy !== null}>
                      {busy === `r:${c.id}` ? "Refreshing" : "Refresh assets"}
                    </Button>
                  )}
                  {(["expired", "expiring", "revoked"].includes(c.status) || refreshFailed === c.id) && data.configured && (
                    <Button size="sm" onClick={() => void connect()} disabled={busy !== null}>
                      Reconnect
                    </Button>
                  )}
                  {c.status !== "revoked" && (
                    <Button size="sm" variant="danger" onClick={() => setDisconnecting(c)} disabled={busy !== null}>
                      Disconnect
                    </Button>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>

        <Card>
          <h2 className="font-semibold">What we can access</h2>
          <p className="mt-1 text-xs text-muted">Only what you approve in the Meta dialog. Tokens are encrypted and never shown. Nothing spends money without your confirmation.</p>
          <ul className="mt-3 space-y-2 text-sm">
            {data.scopes.map((s) => (
              <li key={s.scope}>
                <span className="font-mono text-xs">{s.scope}</span>
                <br />
                <span className="text-muted">{s.purpose}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      {disconnecting && (
        <DisconnectDialog
          connection={disconnecting}
          isOwner={role === "owner"}
          offboard={(meta?.offboard ?? []).filter((o) => disconnecting.assets.some((a) => a.id === o.adAccountAssetId))}
          onClose={() => setDisconnecting(null)}
          onDone={(text) => {
            setDisconnecting(null);
            setNotice(text);
            void load();
          }}
        />
      )}
    </>
  );
}

/**
 * The consent step after discovery (docs/SPEND-CONTROLS-SPEC.md 5.1): the owner sees the 5.1 text, the checkbox and
 * [Turn on Meta's limit]; an admin sees that only the owner can, and can ask (the owner gets the task). Everything happens
 * in Edwyz; the only Meta screen is its login ([Connect again with an admin account]).
 */
export function MetaLimitStep({ payload, role, onChanged, onConnectAgain }: { payload: MetaLimitPayload; role: string; onChanged: () => void; onConnectAgain: (() => void) | null }) {
  const meta = payload.metaLimit;
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const checkId = useId();
  if (!meta) return null;
  const owner = role === "owner";
  const admin = role === "admin";
  const consent = payload.consent;
  const showConsent = owner && meta.canTurnOn && consent !== null && meta.state !== "no_permission";
  const askOwner = admin && (meta.state === "off" || meta.state === "pending_owner");
  const connectAgain = meta.action?.kind === "connect_again" && (owner || admin);
  if (!showConsent && !askOwner && !connectAgain) return null;

  async function post(body: Record<string, unknown>, done: (m: MetaLimitDTO | null) => string) {
    setBusy(true);
    setMessage("");
    try {
      const r = await apiFetch<{ metaLimit: MetaLimitDTO | null }>("/api/spend/meta-limit", { method: "POST", body });
      setMessage(done(r.metaLimit));
      onChanged();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Something went wrong.");
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-6" title={showConsent ? consent!.title : "Spending limit on Meta"} description="Meta itself stops your ads when this limit is reached, even if something goes wrong on our side." data-testid="meta-limit-step">
      {showConsent && (
        <div className="space-y-3 text-sm">
          {consent!.existingCap && <p className="font-medium">{consent!.existingCap}</p>}
          <ul className="list-disc space-y-1 pl-5">
            {consent!.body.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="flex items-start gap-2">
            <input id={checkId} type="checkbox" className="mt-1 h-4 w-4 shrink-0" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <label htmlFor={checkId}>{consent!.checkbox}</label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!agreed} loading={busy} onClick={() => void post({ action: "turn_on", agreed: true, textVersion: consent!.textVersion }, (m) => m?.text ?? "Meta's limit is being turned on.")}>
              {consent!.button}
            </Button>
          </div>
        </div>
      )}
      {askOwner && (
        <div className="space-y-3 text-sm">
          <p>{meta.state === "pending_owner" ? ADMIN_PENDING_TEXT : "Meta's limit adds a safety stop on Meta's side for this ad account. Only the workspace owner can turn it on."}</p>
          {meta.state === "off" && (
            <Button variant="secondary" loading={busy} onClick={() => void post({ action: "turn_on" }, () => ADMIN_PENDING_TEXT)}>
              Ask the owner to turn it on
            </Button>
          )}
        </div>
      )}
      {connectAgain && (
        <div className="space-y-3 text-sm">
          <p>{meta.text}</p>
          {onConnectAgain && (
            <Button variant="secondary" onClick={onConnectAgain}>
              {meta.action!.label}
            </Button>
          )}
        </div>
      )}
      <p role="status" aria-live="polite" className="mt-3 text-sm text-muted">
        {message}
      </p>
    </Card>
  );
}

/**
 * Disconnecting (docs/SPEND-CONTROLS-SPEC.md 5.9, 5.8): what happens at Meta, the choice for Meta's limit (default keep),
 * and, when a campaign could not be paused, [Try again] first; only the owner can type DISCONNECT to go ahead anyway.
 */
export function DisconnectDialog({
  connection,
  isOwner,
  offboard,
  onClose,
  onDone,
  initialBlocked = null,
}: {
  connection: Pick<Connection, "id" | "sharedWithOtherWorkspace">;
  isOwner: boolean;
  offboard: OffboardAccount[];
  onClose: () => void;
  onDone: (notice: string) => void;
  initialBlocked?: ReturnType<typeof blockedDisconnect>;
}) {
  const [choice, setChoice] = useState<MetaOffboardChoice>(offboard[0]?.selected ?? "keep");
  const [blocked, setBlocked] = useState(initialBlocked);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const groupId = useId();
  const warning = connection.sharedWithOtherWorkspace
    ? "This Facebook account is also connected to another Edwyz workspace. We will not revoke it at Meta, so that workspace keeps working. Here we will only delete the stored tokens and stop using the assets."
    : "We will revoke Edwyz's access for this Facebook account at Meta, which removes it everywhere, including any other Edwyz workspace you connect with the same account. Then we delete the stored tokens.";

  async function send(force: boolean) {
    setBusy(true);
    setError("");
    try {
      const r = await apiFetch<{ revokedAtMeta?: boolean; skippedSharedUser?: boolean; pagesUnsubscribeFailed?: number; metaLimitText?: string | null }>("/api/meta-connect/disconnect", {
        method: "POST",
        body: { connectionId: connection.id, metaLimitChoice: choice, ...(force ? { force: true, confirm: typed.trim() } : {}) },
      });
      onDone(disconnectNotice(r));
    } catch (e) {
      const b = blockedDisconnect(e);
      if (b) setBlocked(b);
      else setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Disconnect this Meta account?"
      role="alertdialog"
      dismissible={!busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          {blocked ? (
            <Button variant="secondary" loading={busy} onClick={() => void send(false)}>
              Try again
            </Button>
          ) : (
            <Button variant="danger" loading={busy} onClick={() => void send(false)}>
              Disconnect
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p>
          {warning} We will also stop lead alerts for your Pages at Meta, unless another workspace still uses the same Page. We pause every ad Edwyz runs on this account first.
        </p>
        {offboard.map((o) => (
          <fieldset key={o.adAccountAssetId} className="space-y-2" aria-describedby={groupId}>
            <legend className="font-medium">Meta&apos;s spending limit on {o.accountName ?? o.accountExternalId}</legend>
            <p id={groupId} className="text-muted">
              Choose what happens to the limit on Meta. Your Edwyz limits keep working either way.
            </p>
            {o.choices.map((c) => (
              <label key={c.choice} className="flex min-h-10 items-center gap-2">
                <input type="radio" name={`offboard-${o.adAccountAssetId}`} value={c.choice} checked={choice === c.choice} onChange={() => setChoice(c.choice)} />
                <span>{c.label}</span>
              </label>
            ))}
          </fieldset>
        ))}
        {blocked && (
          <Alert tone="warn" title="Some campaigns are still running">
            <p>{blocked.text}</p>
            {blocked.campaigns.length > 0 && (
              <ul className="mt-2 list-disc pl-5">
                {blocked.campaigns.map((c) => (
                  <li key={c.id} className="break-words">
                    {c.name}
                  </li>
                ))}
              </ul>
            )}
            <details className="mt-2">
              <summary className="cursor-pointer">More help</summary>
              <p className="mt-1">If Try again keeps failing, you can also pause these campaigns in Meta Ads Manager.</p>
            </details>
          </Alert>
        )}
        {blocked?.canForce && isOwner && (
          <div className="space-y-2">
            <FormField label={`Type ${DISCONNECT_WORD} to disconnect anyway`}>
              <Input autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
            </FormField>
            <Button variant="danger" disabled={typed.trim() !== DISCONNECT_WORD} loading={busy} onClick={() => void send(true)}>
              Disconnect anyway
            </Button>
          </div>
        )}
        <p role="status" aria-live="polite" className="text-bad-fg">
          {error}
        </p>
      </div>
    </Dialog>
  );
}

function AssetGroups({ assets }: { assets: Asset[] }) {
  if (assets.length === 0) return <p className="mt-4 text-sm text-muted">No assets found.</p>;
  const types = Object.keys(TYPE_LABEL).filter((t) => assets.some((a) => a.type === t));
  return (
    <div className="mt-4 space-y-3">
      {types.map((t) => (
        <div key={t}>
          <h3 className="text-sm font-medium">{TYPE_LABEL[t]}</h3>
          <ul className="mt-1 divide-y divide-border">
            {assets
              .filter((a) => a.type === t)
              .map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5 text-sm">
                  <span className="min-w-0 max-w-full truncate">{a.name ?? a.externalId}</span>
                  <span className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
                    {a.type === "page" && a.status === "active" && <LeadSync meta={a.meta} />}
                    <Badge tone={a.status === "active" ? "good" : "neutral"}>{STATUS_LABEL[a.status] ?? a.status}</Badge>
                  </span>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function LeadSync({ meta }: { meta: Asset["meta"] }) {
  const sub = meta?.leadgenSubscription;
  if (sub?.status === "subscribed") return <Badge tone="good">Lead alerts on</Badge>;
  if (sub?.status === "failed") return <span title={sub.reason}><Badge tone="bad">Lead alerts failed, press Refresh assets</Badge></span>;
  if (sub?.status === "pending") return <Badge tone="neutral">Lead alerts pending, press Refresh assets</Badge>;
  return <Badge tone="neutral">Lead alerts not set up, press Refresh assets</Badge>;
}
