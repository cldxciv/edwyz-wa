"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Alert, Button, Card, Dialog, FormField, Input, StatusPill, apiFetch, confirm, toast } from "@/components/ui";
import { WebhookGuide } from "./WebhookGuide";
import { accessTokenError, friendlyError, needsAccessToken, parseShopDomain, secretError, shopDomainError, storeAnnouncement, storeView } from "./helpers";
import type { Store } from "./types";

/** Keeps password managers out of the store form: Chrome ignores autocomplete="off" on password inputs and filled the owner's saved login into these fields. */
const NOT_A_LOGIN = { "data-1p-ignore": "", "data-lpignore": "true", "data-form-type": "other" } as const;
/** "new-password" stops a saved password being filled in; the input stays masked. */
const SECRET_FIELD = { ...NOT_A_LOGIN, autoComplete: "new-password" } as const;

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3 sm:gap-4">
      <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-on-accent">
        {n}
      </span>
      <div className="min-w-0 flex-1 pb-6">
        <h3 className="mb-2 text-base font-semibold">
          <span className="sr-only">Step {n}: </span>
          {title}
        </h3>
        {children}
      </div>
    </li>
  );
}

function ConnectForm({ onConnected }: { onConnected: () => void }) {
  const [domain, setDomain] = useState("");
  const [secret, setSecret] = useState("");
  const [token, setToken] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const domainError = submitted ? shopDomainError(domain) : null;
  const secretProblem = submitted ? secretError(secret) : null;
  const tokenProblem = submitted ? accessTokenError(token) : null;

  async function connect(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setError("");
    const shopDomain = parseShopDomain(domain);
    if (!shopDomain || secretError(secret) || accessTokenError(token)) return;
    setBusy(true);
    try {
      await apiFetch("/api/commerce/stores", { method: "POST", body: { shopDomain, webhookSecret: secret.trim(), accessToken: token.trim() } });
      setDomain("");
      setSecret("");
      setToken("");
      setSubmitted(false);
      toast.success("Store connected", { description: "Shopify confirmed the store, so reminders can start." });
      onConnected();
    } catch (err) {
      setError(friendlyError(err, "We could not connect the store."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={connect} noValidate className="grid gap-4 md:grid-cols-2">
      <FormField label="Store address" required error={domainError} hint="The address that ends in .myshopify.com, for example my-store.myshopify.com. You can paste the link from your browser.">
        <Input name="shopify-store" value={domain} onChange={(e) => setDomain(e.target.value)} autoComplete="off" inputMode="url" autoCapitalize="none" spellCheck={false} {...NOT_A_LOGIN} />
      </FormField>
      <FormField label="Signing secret" required error={secretProblem} hint="The long code Shopify shows in the Webhooks section. It proves the notifications really come from your store. We store it encrypted.">
        <Input name="shopify-signing-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} spellCheck={false} {...SECRET_FIELD} />
      </FormField>
      <FormField label="Admin API access token" required error={tokenProblem} hint="From the custom app you create in Shopify (step 3). It lets us ask Shopify whether the store is really yours. We store it encrypted and never show it again.">
        <Input name="shopify-access-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false} {...SECRET_FIELD} />
      </FormField>
      {error && (
        <Alert className="md:col-span-2" tone="bad" title="We could not connect the store">
          {error}
        </Alert>
      )}
      <div className="md:col-span-2">
        <Button type="submit" loading={busy}>
          Connect store
        </Button>
      </div>
    </form>
  );
}

function SecretDialog({ store, onClose, onSaved }: { store: Store; onClose: () => void; onSaved: () => void }) {
  const formId = useId();
  const [secret, setSecret] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const problem = submitted ? secretError(secret) : null;

  async function save(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setError("");
    if (secretError(secret)) return;
    setBusy(true);
    try {
      await apiFetch(`/api/commerce/stores/${store.id}`, { method: "PATCH", body: { webhookSecret: secret.trim() } });
      toast.success("Signing secret updated");
      onSaved();
      onClose();
    } catch (err) {
      setError(friendlyError(err, "We could not save the secret."));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Update signing secret"
      description={store.shopDomain}
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            Save secret
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={save} noValidate className="space-y-4">
        <p className="text-sm text-muted">If Shopify notifications are not being accepted, the secret may be wrong. Copy it again from Settings, Notifications, Webhooks in Shopify.</p>
        <FormField label="New signing secret" required error={problem}>
          <Input data-autofocus="" name="shopify-signing-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} spellCheck={false} {...SECRET_FIELD} />
        </FormField>
        {error && <Alert tone="bad">{error}</Alert>}
      </form>
    </Dialog>
  );
}

/** Asks for the Admin API token when a store has none saved: to verify a waiting store, or to resume a paused one. */
function TokenDialog({ store, resume, onClose, onSaved }: { store: Store; resume: boolean; onClose: () => void; onSaved: () => void }) {
  const formId = useId();
  const [token, setToken] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const problem = submitted ? accessTokenError(token) : null;

  async function save(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setError("");
    if (accessTokenError(token)) return;
    setBusy(true);
    try {
      await apiFetch(`/api/commerce/stores/${store.id}`, { method: "PATCH", body: resume ? { status: "active", accessToken: token.trim() } : { accessToken: token.trim() } });
      toast.success(resume ? `${store.shopDomain} resumed` : `${store.shopDomain} verified`);
      onSaved();
      onClose();
    } catch (err) {
      setError(friendlyError(err, "We could not check the token with Shopify."));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={resume ? "Resume this store" : "Verify this store"}
      description={store.shopDomain}
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {resume ? "Resume store" : "Verify store"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={save} noValidate className="space-y-4">
        <p className="text-sm text-muted">We need the Admin API access token to confirm with Shopify that this store is yours. Copy it from the custom app in Settings, Apps and sales channels, Develop apps in Shopify.</p>
        <FormField label="Admin API access token" required error={problem}>
          <Input data-autofocus="" name="shopify-access-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false} {...SECRET_FIELD} />
        </FormField>
        {error && <Alert tone="bad">{error}</Alert>}
      </form>
    </Dialog>
  );
}

type PendingFocus = { kind: "added"; known: Set<string> } | { kind: "removed"; id: string };

export function StoreSection({ stores, editable, webhookUrl, selected, onSelect, onChange }: { stores: Store[]; editable: boolean; webhookUrl: string; selected?: string; onSelect: (id: string) => void; onChange: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [secretFor, setSecretFor] = useState<Store | null>(null);
  const [tokenFor, setTokenFor] = useState<{ store: Store; resume: boolean } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const anyPending = stores.some((s) => storeView(s).pending);
  const [guideOpen, setGuideOpen] = useState(anyPending);
  const lastLabels = useRef<Map<string, string>>(new Map());
  const pendingFocus = useRef<PendingFocus | null>(null);
  const heading = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (anyPending) setGuideOpen(true);
  }, [anyPending]);

  useEffect(() => {
    const before = lastLabels.current;
    const next = new Map<string, string>();
    for (const s of stores) {
      const view = storeView(s);
      next.set(s.id, view.label);
      if (before.has(s.id) && before.get(s.id) !== view.label) setAnnouncement(storeAnnouncement(s.shopDomain, view));
    }
    lastLabels.current = next;
  }, [stores]);

  useEffect(() => {
    const want = pendingFocus.current;
    if (!want) return;
    if (want.kind === "added") {
      const fresh = stores.find((s) => !want.known.has(s.id));
      if (!fresh) return;
      pendingFocus.current = null;
      document.querySelector<HTMLElement>(`[data-store-row="${CSS.escape(fresh.id)}"]`)?.focus();
    } else if (!stores.some((s) => s.id === want.id)) {
      pendingFocus.current = null;
      heading.current?.focus();
    }
  }, [stores]);

  const connected = () => {
    pendingFocus.current = { kind: "added", known: new Set(stores.map((s) => s.id)) };
    onChange();
  };

  const status = (
    <p role="status" className="sr-only">
      {announcement}
    </p>
  );

  async function togglePause(store: Store) {
    const pausing = store.status !== "disabled";
    setBusyId(store.id);
    try {
      await apiFetch(`/api/commerce/stores/${store.id}`, { method: "PATCH", body: { status: pausing ? "disabled" : "active" } });
      if (pausing) toast.success(`${store.shopDomain} is paused`, { description: "No reminders are sent until you resume it." });
      else toast.info(`${store.shopDomain} resumed`, { description: "Reminders start again for new checkouts." });
      onChange();
    } catch (err) {
      if (!pausing && needsAccessToken(err)) setTokenFor({ store, resume: true });
      else toast.error("We could not update the store", { description: friendlyError(err) });
    } finally {
      setBusyId(null);
    }
  }

  async function disconnect(store: Store) {
    const ok = await confirm({
      title: `Disconnect ${store.shopDomain}?`,
      body: "Reminders for this store stop and its abandoned cart history is deleted. You can connect the store again later.",
      confirmLabel: "Disconnect store",
      tone: "danger",
    });
    if (!ok) return;
    setBusyId(store.id);
    try {
      await apiFetch(`/api/commerce/stores/${store.id}`, { method: "DELETE" });
      toast.success(`${store.shopDomain} disconnected`);
      pendingFocus.current = { kind: "removed", id: store.id };
      onChange();
    } catch (err) {
      toast.error("We could not disconnect the store", { description: friendlyError(err) });
    } finally {
      setBusyId(null);
    }
  }

  if (stores.length === 0) {
    if (!editable) {
      return (
        <>
          <Alert tone="info" title="No store is connected yet">
            Ask an owner or admin to connect your Shopify store. Once it is connected, abandoned checkouts show up here.
          </Alert>
          {status}
        </>
      );
    }
    return (
      <>
      <Card
        title={
          <span ref={heading} tabIndex={-1} className="outline-none">
            Connect your Shopify store
          </span>
        }
        description="This takes about five minutes. You only do it once."
      >
        <ol className="m-0 list-none p-0">
          <Step n={1} title="Add three notifications in Shopify">
            <WebhookGuide url={webhookUrl} />
          </Step>
          <Step n={2} title="Copy the signing secret">
            <p className="text-sm">
              In the same Webhooks section, Shopify shows a <strong>signing secret</strong>, a long string of letters and numbers. Copy it. It proves to us that notifications really come from your store.
            </p>
          </Step>
          <Step n={3} title="Copy the Admin API access token">
            <p className="text-sm">
              In Shopify, open <strong>Settings</strong>, then <strong>Apps and sales channels</strong>, then <strong>Develop apps</strong>, and create an app. Under <strong>Configuration</strong> choose one read permission, for example <strong>read_orders</strong>, then
              select <strong>Install app</strong>. Shopify shows the <strong>Admin API access token</strong>{" "}once, so copy it right away. We use it to check that the store is yours.
            </p>
          </Step>
          <Step n={4} title="Connect your store here">
            <ConnectForm onConnected={connected} />
          </Step>
        </ol>
        <p className="mt-1 text-sm text-muted">When you connect, we check the token with Shopify and the store is verified straight away. Reminders then start for new checkouts.</p>
      </Card>
      {status}
      </>
    );
  }

  return (
    <>
    <Card
      title={
        <span ref={heading} tabIndex={-1} className="outline-none">
          {stores.length > 1 ? "Your stores" : "Your store"}
        </span>
      }
      description={stores.length > 1 ? "Reminders go out for the store you select below." : "Reminders go out for this store."}
    >
      <ul className="divide-y divide-border">
        {stores.map((s) => {
          const view = storeView(s);
          const busy = busyId === s.id;
          return (
            <li key={s.id} data-store-row={s.id} tabIndex={-1} className="py-3 outline-none first:pt-0">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  {stores.length > 1 ? (
                    <label className="flex min-h-10 items-center gap-2 text-sm">
                      <input type="radio" name="store" className="h-4 w-4 accent-accent" checked={selected === s.id} onChange={() => onSelect(s.id)} />
                      <span className="break-all font-medium">{s.shopDomain}</span>
                    </label>
                  ) : (
                    <p className="break-all text-sm font-medium">{s.shopDomain}</p>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <StatusPill status={s.status} label={view.label} tone={view.tone} />
                    <span>{view.detail}</span>
                  </div>
                </div>
                {editable && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" loading={busy} aria-label={`${s.status === "disabled" ? "Resume" : "Pause"} ${s.shopDomain}`} onClick={() => void togglePause(s)}>
                      {s.status === "disabled" ? "Resume" : "Pause"}
                    </Button>
                    {view.pending && (
                      <Button size="sm" variant="secondary" disabled={busy} aria-label={`Verify ${s.shopDomain}`} onClick={() => setTokenFor({ store: s, resume: false })}>
                        Verify
                      </Button>
                    )}
                    <Button size="sm" variant="secondary" disabled={busy} aria-label={`Update secret for ${s.shopDomain}`} onClick={() => setSecretFor(s)}>
                      Update secret
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busy} aria-label={`Disconnect ${s.shopDomain}`} onClick={() => void disconnect(s)}>
                      Disconnect
                    </Button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {anyPending && (
        <Alert className="mt-4" tone="warn" title="Waiting for Shopify to confirm the connection">
          <p>No reminders are sent until Shopify has confirmed the store is yours. Choose Verify and paste the Admin API access token from your custom app in Shopify.</p>
          <p className="mt-1">Once verified, check that the address in each webhook matches the one in the setup steps below, and update the signing secret if notifications are not being accepted.</p>
        </Alert>
      )}

      <details className="mt-4 rounded-control border border-border" open={guideOpen} onToggle={(e) => setGuideOpen(e.currentTarget.open)}>
        <summary className="min-h-10 cursor-pointer px-3 py-2.5 text-sm font-medium">Webhook setup steps</summary>
        <div className="border-t border-border p-3">
          <WebhookGuide url={webhookUrl} />
        </div>
      </details>

      {editable && (
        <details className="mt-3 rounded-control border border-border">
          <summary className="min-h-10 cursor-pointer px-3 py-2.5 text-sm font-medium">Connect another store</summary>
          <div className="border-t border-border p-3">
            <ConnectForm onConnected={connected} />
          </div>
        </details>
      )}

      {tokenFor && <TokenDialog store={tokenFor.store} resume={tokenFor.resume} onClose={() => setTokenFor(null)} onSaved={onChange} />}
      {secretFor && <SecretDialog store={secretFor} onClose={() => setSecretFor(null)} onSaved={onChange} />}
    </Card>
    {status}
    </>
  );
}
