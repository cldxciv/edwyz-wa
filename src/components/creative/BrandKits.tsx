"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { PageHeader } from "@/components/app/PageHeader";
import { Alert, Badge, Button, Card, Dialog, EmptyState, ErrorState, FormField, Input, Select, Skeleton, Textarea, apiFetch, confirm, toast } from "@/components/ui";
import { SPECIAL_CATEGORIES, suggestSpecialAdCategory } from "@/lib/creative/constants";
import { friendlyMessage } from "./messages";
import { CATEGORY_LABEL, LinkButton, type Brand } from "./shared";
import { invalidColours, safeColour, splitList } from "./wizard";

type Form = { name: string; websiteUrl: string; logoUrl: string; colors: string; fonts: string; tone: string; bannedWords: string; industry: string; specialAdCategory: string; confirmed: boolean };

const empty: Form = { name: "", websiteUrl: "", logoUrl: "", colors: "", fonts: "", tone: "", bannedWords: "", industry: "", specialAdCategory: "none", confirmed: false };

function toForm(b: Brand): Form {
  return { name: b.name, websiteUrl: b.websiteUrl ?? "", logoUrl: b.logoUrl ?? "", colors: b.colors.join(", "), fonts: b.fonts.join(", "), tone: b.tone ?? "", bannedWords: b.bannedWords.join(", "), industry: b.industry ?? "", specialAdCategory: b.specialAdCategory, confirmed: true };
}

const FORM_ID = "brand-kit-form";
/** 16 px text in fields on phones, so iOS does not zoom the page when a field gets focus. */
const PHONE_TEXT = "max-sm:[&_input]:text-base! max-sm:[&_textarea]:text-base! max-sm:[&_select]:text-base!";
const FIELDS: (keyof Form)[] = ["name", "websiteUrl", "logoUrl", "colors", "fonts", "tone", "bannedWords", "industry", "specialAdCategory"];

function BrandDialog({ editing, initial, onClose, onSaved }: { editing: string | "new"; initial: Form; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<Form>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [touched, setTouched] = useState(false);
  const [lookOpen, setLookOpen] = useState(!!(initial.colors || initial.fonts || initial.logoUrl));
  const [focusTick, setFocusTick] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const dirty = FIELDS.some((k) => form[k] !== initial[k]);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const suggestion = suggestSpecialAdCategory(form.industry);
  const badColours = invalidColours(form.colors);
  const nameError = touched && !form.name.trim() ? "Enter a name for this brand." : null;
  const colourError = badColours.length > 0 ? `These are not valid colours: ${badColours.join(", ")}. Use six-digit codes like #1f2a44.` : null;

  function onIndustry(industry: string) {
    const next = suggestSpecialAdCategory(industry);
    set({ industry, ...(form.confirmed ? {} : { specialAdCategory: next }) });
  }

  // After a failed check, move to the first field with a problem. The colour box lives in a closed section, so open it first.
  useEffect(() => {
    if (focusTick > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusTick]);

  async function requestClose() {
    if (busy) return;
    if (dirty && !(await confirm({ title: "Discard your changes?", body: "What you typed in this brand kit will be lost.", confirmLabel: "Discard changes", tone: "danger" }))) return;
    onClose();
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!form.name.trim() || colourError) {
      if (colourError) setLookOpen(true);
      setFocusTick((t) => t + 1);
      return;
    }
    setBusy(true);
    setError("");
    const body = {
      name: form.name,
      websiteUrl: form.websiteUrl.trim() || null,
      logoUrl: form.logoUrl.trim() || null,
      colors: splitList(form.colors),
      fonts: splitList(form.fonts),
      tone: form.tone.trim() || null,
      bannedWords: splitList(form.bannedWords),
      industry: form.industry.trim() || null,
      specialAdCategory: form.specialAdCategory,
    };
    try {
      if (editing === "new") await apiFetch("/api/creative/brands", { method: "POST", body });
      else await apiFetch(`/api/creative/brands/${editing}`, { method: "PATCH", body });
      toast.success(editing === "new" ? "Brand kit created" : "Brand kit saved");
      onSaved();
    } catch (err) {
      setError(friendlyMessage(err, "We could not save this brand kit. Check your connection and try again."));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={editing === "new" ? "New brand kit" : "Edit brand kit"}
      description="A brand kit keeps your look and rules in one place, so every ad stays on brand."
      size="lg"
      onClose={() => void requestClose()}
      dismissible={!busy}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={() => void requestClose()} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={FORM_ID} loading={busy}>
            Save brand kit
          </Button>
        </>
      }
    >
      <form id={FORM_ID} ref={formRef} noValidate className={`grid gap-4 ${PHONE_TEXT}`} onSubmit={(e) => void save(e)}>
        {error && <Alert tone="bad">{error}</Alert>}
        <FormField label="Brand name" required error={nameError}>
          <Input data-autofocus="" required maxLength={120} autoComplete="organization" value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </FormField>
        <FormField label="What kind of business is it?" optional hint="For example: real estate, school, restaurant. We use it to spot ads with extra rules.">
          <Input value={form.industry} onChange={(e) => onIndustry(e.target.value)} />
        </FormField>
        <FormField label="Website" optional hint="Starts with https. We read the public pages once, when you ask us to research a brief.">
          <Input type="url" inputMode="url" placeholder="https://example.com" value={form.websiteUrl} onChange={(e) => set({ websiteUrl: e.target.value })} />
        </FormField>
        <FormField label="How should your ads sound?" optional hint="For example: friendly and plain, short sentences, no jargon.">
          <Textarea rows={2} maxLength={500} value={form.tone} onChange={(e) => set({ tone: e.target.value })} />
        </FormField>
        <FormField label="Words to avoid" optional hint="Separate with commas. Any ad that uses one of these is flagged as Must fix.">
          <Textarea rows={2} value={form.bannedWords} onChange={(e) => set({ bannedWords: e.target.value })} />
        </FormField>
        <FormField
          label="Does this brand advertise housing, jobs, credit or politics?"
          hint={suggestion !== "none" ? `Based on the business type we suggest: ${CATEGORY_LABEL[suggestion]}. Please confirm.` : "Choose one if it does. These ads have extra rules from Meta. Otherwise leave it as None."}
        >
          <Select value={form.specialAdCategory} onChange={(e) => set({ specialAdCategory: e.target.value, confirmed: true })}>
            {SPECIAL_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </Select>
        </FormField>
        <details className="rounded-control border border-border p-3" open={lookOpen} onToggle={(e) => setLookOpen(e.currentTarget.open)}>
          <summary className="min-h-10 cursor-pointer text-sm font-medium leading-10">Look and feel (optional)</summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <FormField label="Logo link" optional hint="A link to your logo image, starting with https.">
              <Input type="url" inputMode="url" value={form.logoUrl} onChange={(e) => set({ logoUrl: e.target.value })} />
            </FormField>
            <FormField label="Fonts" optional hint="Separate with commas.">
              <Input value={form.fonts} onChange={(e) => set({ fonts: e.target.value })} />
            </FormField>
            <FormField className="sm:col-span-2" label="Brand colours" optional hint="Six-digit codes separated by commas, like #1f2a44, #ffffff." error={colourError}>
              <Input value={form.colors} onChange={(e) => set({ colors: e.target.value })} />
            </FormField>
          </div>
        </details>
      </form>
    </Dialog>
  );
}

export function BrandKits() {
  const [brands, setBrands] = useState<Brand[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState<{ id: string | "new"; form: Form } | null>(null);
  const region = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      setBrands((await apiFetch<{ items: Brand[] }>("/api/creative/brands")).items);
    } catch (e) {
      setLoadError(friendlyMessage(e, "Check your connection and try again."));
      setBrands((cur) => cur ?? []);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // After a delete the tapped button is gone. Land on the first remaining card, or on the page area when none are left.
  useEffect(() => {
    if (!refocus.current || brands === null) return;
    refocus.current = false;
    (region.current?.querySelector<HTMLElement>("ul button, ul a") ?? region.current)?.focus();
  }, [brands]);

  async function remove(b: Brand) {
    const ok = await confirm({
      title: `Delete "${b.name}"?`,
      body: "Its briefs and every ad made from them are deleted too. This cannot be undone.",
      confirmLabel: "Delete brand kit",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/creative/brands/${b.id}`, { method: "DELETE" });
      toast.success(`Deleted "${b.name}"`);
      refocus.current = true;
      await load();
    } catch (e) {
      toast.error(friendlyMessage(e, "We could not delete this brand kit. Try again."));
    }
  }

  const openNew = () => setEditing({ id: "new", form: empty });

  return (
    <div ref={region} tabIndex={-1} className="outline-none">
      <PageHeader
        title="Brand kits"
        description="Your colours, tone and words to avoid. We use them for every brief and check every ad against them."
        breadcrumbs={[{ label: "Creative Studio", href: "/app/creative" }, { label: "Brand kits" }]}
        actions={brands && brands.length > 0 ? <Button onClick={openNew}>New brand kit</Button> : undefined}
      />

      {brands === null ? (
        <div aria-busy="true">
          <p role="status" className="sr-only">
            Loading brand kits
          </p>
          <div aria-hidden className="grid gap-4 sm:grid-cols-2">
            {[0, 1].map((i) => (
              <Card key={i}>
                <Skeleton className="h-5 w-40" />
                <Skeleton className="mt-3 h-4 w-24" />
                <Skeleton className="mt-4 h-5 w-32" />
              </Card>
            ))}
          </div>
        </div>
      ) : loadError ? (
        <ErrorState title="We could not load your brand kits" message={loadError} action={<Button variant="secondary" onClick={() => void load()}>Try again</Button>} />
      ) : brands.length === 0 ? (
        <EmptyState
          title="No brand kits yet"
          body="A brand kit tells us how your business looks and sounds, so your ads stay on brand. Create one before your first brief."
          action={<Button onClick={openNew}>Create brand kit</Button>}
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {brands.map((b) => {
            const colours = b.colors.map(safeColour).filter((c): c is string => !!c);
            const suggested = b.suggestedSpecialAdCategory ?? "none";
            return (
              <li key={b.id}>
                <Card className="h-full" title={b.name} description={b.industry ?? "No business type set"} actions={b.specialAdCategory !== "none" ? <Badge tone="warn">{CATEGORY_LABEL[b.specialAdCategory]} ads</Badge> : undefined}>
                  {colours.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="sr-only">Brand colours: {colours.join(", ")}</span>
                      {colours.map((c) => (
                        <span key={c} aria-hidden className="h-6 w-6 rounded-full border border-border-strong" style={{ backgroundColor: c }} title={c} />
                      ))}
                    </div>
                  )}
                  {b.tone && <p className="mt-3 line-clamp-2 text-sm text-muted">Sounds: {b.tone}</p>}
                  {suggested !== "none" && suggested !== b.specialAdCategory && (
                    <Alert tone="warn" className="mt-3">
                      The business type suggests the {CATEGORY_LABEL[suggested]}{" "}category. Please review it.
                    </Alert>
                  )}
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button variant="secondary" aria-label={`Edit ${b.name}`} onClick={() => setEditing({ id: b.id, form: toForm(b) })}>
                      Edit
                    </Button>
                    <LinkButton variant="primary" href={`/app/creative/new?brand=${encodeURIComponent(b.id)}`}>
                      New brief
                    </LinkButton>
                    <Button variant="ghost" aria-label={`Delete ${b.name}`} onClick={() => void remove(b)}>
                      Delete
                    </Button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {editing && (
        <BrandDialog
          key={editing.id}
          editing={editing.id}
          initial={editing.form}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
