"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, DataTable, EmptyState, ErrorState, Input, Select, StatusPill, apiFetch, confirm, toast, type Column } from "@/components/ui";
import { displayName } from "@/lib/contacts/identity";
import { PageHeader } from "@/components/app/PageHeader";
import { ContactDialog, type ContactRow } from "./ContactDialog";
import { ImportDialog } from "./ImportDialog";
import { LinkButton } from "@/components/broadcasts/LinkButton";
import { canManage, useApi, useRole } from "./hooks";
import { friendlyError, optInView } from "./helpers";
import { useOwnerStageOptions } from "./OwnerStage";
import { dispatchEddyEvent } from "@/components/eddy/events";

type Page = { items: ContactRow[]; nextCursor: string | null };
type Filters = { q: string; tag: string; segment: string };
type DialogState = null | { kind: "edit"; contact: ContactRow | null } | { kind: "import" };

const NO_FILTERS: Filters = { q: "", tag: "", segment: "" };

export function ContactsView({ openAdd = false, initialSegment }: { openAdd?: boolean; initialSegment?: string }) {
  const router = useRouter();
  const role = useRole();
  const admin = canManage(role);
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [segment, setSegment] = useState(initialSegment ?? "");
  const [applied, setApplied] = useState<Filters>({ ...NO_FILTERS, segment: initialSegment ?? "" });
  const segments = useApi<{ segments: { id: string; name: string }[]; presets: { id: string; name: string }[] }>("/api/segments");
  const [rows, setRows] = useState<ContactRow[]>([]);
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(openAdd ? { kind: "edit", contact: null } : null);
  const [seenAdd, setSeenAdd] = useState(openAdd);
  const [missingSegment, setMissingSegment] = useState(false);
  const latest = useRef(0);
  const directory = useOwnerStageOptions();
  useEffect(() => void (dialog?.kind === "edit" && dialog.contact && dispatchEddyEvent("wa:eddy-selection", { type: "contact", id: dialog.contact.id })), [dialog]); // tells Eddy which contact is open

  if (openAdd !== seenAdd) {
    setSeenAdd(openAdd);
    if (openAdd) setDialog({ kind: "edit", contact: null });
  }

  useEffect(() => {
    if (openAdd) router.replace("/app/contacts", { scroll: false });
  }, [openAdd, router]);

  const load = useCallback(async (after: string | null, filters: Filters) => {
    const ticket = ++latest.current;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (filters.q) params.set("q", filters.q);
    if (filters.tag) params.set("tag", filters.tag);
    if (filters.segment) params.set("segmentId", filters.segment);
    if (after) params.set("cursor", after);
    try {
      const page = await apiFetch<Page>(`/api/contacts?${params}`);
      if (ticket !== latest.current) return;
      setRows((prev) => (after ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setKnownTags((prev) => [...new Set([...prev, ...page.items.flatMap((c) => c.tags)])].sort());
    } catch (e) {
      if (ticket !== latest.current) return;
      if (!after && filters.segment && e instanceof Error && /segment not found/i.test(e.message)) {
        // An old link or a deleted segment: show everyone and say why, instead of an error that Try again cannot fix.
        setMissingSegment(true);
        setSegment("");
        setApplied({ ...filters, segment: "" });
        return;
      }
      const message = friendlyError(e, "We could not load your contacts. Check your connection and try again.");
      if (after) toast.error("We could not load more contacts", { description: message });
      else setError(message);
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(null, applied);
  }, [applied, load]);

  useEffect(() => {
    if (missingSegment) router.replace("/app/contacts", { scroll: false });
  }, [missingSegment, router]);

  useEffect(() => {
    const next = { q: q.trim(), tag: tag.trim(), segment };
    const id = setTimeout(() => setApplied((cur) => (cur.q === next.q && cur.tag === next.tag && cur.segment === next.segment ? cur : next)), 350);
    return () => clearTimeout(id);
  }, [q, tag, segment]);

  const refresh = useCallback(() => load(null, applied), [load, applied]);
  const filtered = !!(applied.q || applied.tag || applied.segment);
  const segmentName = [...(segments.data?.segments ?? []), ...(segments.data?.presets ?? [])].find((s) => s.id === applied.segment)?.name;

  function clearFilters() {
    setMissingSegment(false);
    setQ("");
    setTag("");
    setSegment("");
    setApplied(NO_FILTERS);
  }

  const remove = useCallback(
    async (contact: ContactRow) => {
      const ok = await confirm({
        title: `Delete ${displayName(contact)}?`,
        body: "Their conversations and broadcast history will be removed too. This cannot be undone.",
        confirmLabel: "Delete contact",
        tone: "danger",
      });
      if (!ok) return;
      try {
        await apiFetch(`/api/contacts/${contact.id}`, { method: "DELETE" });
        toast.success("Contact deleted");
        void refresh();
      } catch (e) {
        toast.error("We could not delete this contact", { description: friendlyError(e, "Check your connection and try again.") });
      }
    },
    [refresh],
  );

  const columns = useMemo<Column<ContactRow>[]>(
    () => [
      { key: "name", header: "Name", primary: true, cell: (c) => c.name || <span className="text-muted">No name</span> },
      {
        key: "phone",
        header: "Phone number",
        cell: (c) =>
          c.phone ? (
            <span className="whitespace-nowrap">{c.phone}</span>
          ) : (
            <span className="text-muted" title="This person messages you through a WhatsApp username and has not shared a phone number.">
              {c.username || c.bsuid ? displayName({ ...c, name: null }) : "No phone number"}
            </span>
          ),
      },
      {
        key: "tags",
        header: "Tags",
        cell: (c) =>
          c.tags.length ? (
            <span className="flex flex-wrap gap-1 sm:justify-start">
              {c.tags.map((t) => (
                <Badge key={t}>{t}</Badge>
              ))}
            </span>
          ) : (
            <span className="text-muted">None</span>
          ),
      },
      { key: "owner", header: "Owner", cell: (c) => (c.ownerUserId ? (directory.names.get(c.ownerUserId) ?? "Former member") : <span className="text-muted">No owner</span>) },
      { key: "stage", header: "Lead stage", cell: (c) => (c.leadStage ? <Badge tone="info">{c.leadStage}</Badge> : <span className="text-muted">Not set</span>) },
      {
        key: "consent",
        header: "Permission to message",
        cell: (c) => {
          const view = optInView(c);
          return (
            <span className="flex flex-col items-start gap-1 max-sm:items-end">
              <StatusPill status={view.status} label={view.label} tone={view.tone} />
              {view.detail && <span className="text-xs text-muted">{view.detail}</span>}
            </span>
          );
        },
      },
      {
        key: "actions",
        header: "Actions",
        srOnlyHeader: true,
        align: "right",
        cell: (c) => (
          <span className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" className="max-sm:min-h-10" onClick={() => setDialog({ kind: "edit", contact: c })} aria-label={`Edit ${displayName(c)}`}>
              Edit
            </Button>
            {admin && (
              <Button size="sm" variant="ghost" className="max-sm:min-h-10" onClick={() => void remove(c)} aria-label={`Delete ${displayName(c)}`}>
                Delete
              </Button>
            )}
          </span>
        ),
      },
    ],
    [admin, remove, directory.names],
  );

  const addButton = (
    <Button onClick={() => setDialog({ kind: "edit", contact: null })} className="max-sm:min-h-11">
      Add contact
    </Button>
  );

  const empty = filtered ? (
    <EmptyState
      compact
      title={applied.q ? `No contacts match "${applied.q}"` : applied.tag ? `No contacts tagged "${applied.tag}"` : `No contacts in ${segmentName ? `"${segmentName}"` : "this segment"}`}
      body={applied.q ? "Check the spelling, or try a different search, tag or segment." : applied.tag ? "Check the spelling of the tag, or try a different one." : "No one is in this segment right now."}
      action={
        <Button variant="secondary" onClick={clearFilters}>
          {applied.q ? "Clear search" : "Show all contacts"}
        </Button>
      }
    />
  ) : (
    <EmptyState
      compact
      title="No contacts yet"
      body="Add the people you want to message on WhatsApp. Marketing messages go only to contacts who agreed to receive them."
      action={
        <>
          {addButton}
          {admin && (
            <Button variant="secondary" onClick={() => setDialog({ kind: "import" })}>
              Import from a CSV file
            </Button>
          )}
        </>
      }
    />
  );

  return (
    <div>
      <PageHeader
        title="Contacts"
        description="The people you can message. Marketing messages go only to contacts who agreed to receive them and have not opted out."
        actions={
          <>
            <LinkButton href="/app/contacts/segments" variant="secondary" className="max-sm:min-h-11">
              Segments
            </LinkButton>
            {admin && (
              <Button variant="secondary" className="max-sm:min-h-11" onClick={() => setDialog({ kind: "import" })}>
                Import contacts
              </Button>
            )}
            {addButton}
          </>
        }
      />

      <form
        className="mb-4 flex flex-wrap items-end gap-3"
        role="search"
        aria-label="Find contacts"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied({ q: q.trim(), tag: tag.trim(), segment });
        }}
      >
        <div className="min-w-0 flex-[2_1_14rem]">
          <label htmlFor="contact-search" className="mb-1 block text-sm font-medium">
            Search
          </label>
          <Input id="contact-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or phone number" autoComplete="off" />
        </div>
        <div className="min-w-0 flex-[1_1_10rem]">
          <label htmlFor="contact-tag" className="mb-1 block text-sm font-medium">
            Tag
          </label>
          <Input id="contact-tag" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Any tag" list="contact-tags" autoComplete="off" />
          <datalist id="contact-tags">
            {knownTags.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </div>
        <div className="min-w-0 flex-[1_1_10rem]">
          <label htmlFor="contact-segment" className="mb-1 block text-sm font-medium">
            Segment
          </label>
          <Select
            id="contact-segment"
            value={segment}
            onChange={(e) => {
              setMissingSegment(false);
              setSegment(e.target.value);
            }}
          >
            <option value="">All contacts</option>
            {(segments.data?.segments.length ?? 0) > 0 && (
              <optgroup label="Your segments">
                {segments.data?.segments.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Ready-made">
              {segments.data?.presets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </optgroup>
          </Select>
        </div>
        {(q || tag || segment) && (
          <Button type="button" variant="ghost" onClick={clearFilters} className="max-sm:min-h-11">
            Clear search
          </Button>
        )}
      </form>

      {missingSegment && (
        <Alert
          className="mb-4"
          tone="warn"
          title="That segment no longer exists"
          action={
            <Button size="sm" variant="ghost" onClick={() => setMissingSegment(false)}>
              Dismiss
            </Button>
          }
        >
          It may have been deleted, so you are seeing all contacts. Pick another segment above.
        </Alert>
      )}

      {error ? (
        <ErrorState
          title="We could not load your contacts"
          message={error}
          action={
            <Button variant="secondary" onClick={() => void refresh()}>
              Try again
            </Button>
          }
        />
      ) : (
      <DataTable
          caption="Contacts"
          columns={columns}
          rows={rows}
          rowKey={(c) => c.id}
          loading={loading && rows.length === 0}
          empty={empty}
          footer={
            rows.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p role="status" aria-live="polite" className="text-sm text-muted">
                  Showing {rows.length.toLocaleString()} {rows.length === 1 ? "contact" : "contacts"}
                  {cursor ? ". More are available." : "."}
                </p>
                {cursor && (
                  <Button variant="secondary" loading={loading} onClick={() => void load(cursor, applied)} className="max-sm:min-h-11">
                    Show more contacts
                  </Button>
                )}
              </div>
            )
          }
        />
      )}

      {dialog?.kind === "edit" && (
        <ContactDialog
          contact={dialog.contact}
          canRecordConsent={admin}
          onClose={() => setDialog(null)}
          onSaved={(msg) => {
            toast.success(msg);
            setDialog(null);
            void refresh();
          }}
        />
      )}
      {dialog?.kind === "import" && <ImportDialog onClose={() => setDialog(null)} onDone={() => void refresh()} />}
    </div>
  );
}
