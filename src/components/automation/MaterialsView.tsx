"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge, Button, DataTable, EmptyState, ErrorState, apiFetch, confirm, toast, Alert, type Column } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { canManage, useApi, useRole } from "@/components/contacts/hooks";
import { humanError } from "./helpers";
import { linkButton } from "./linkButton";
import { MaterialDialog, type Material } from "./MaterialDialog";

const KIND_LABEL: Record<string, string> = { text: "Text", media: "Photo, video or audio", document: "Document" };

function preview(m: Material): string {
  if (m.kind === "text") return m.body ?? "";
  const file = m.mediaKey && /^https:\/\//i.test(m.mediaKey) ? m.mediaKey : "File from your media library";
  return m.body ? `${m.body} (${file})` : file;
}

/** Ready-made answers (text, photos, videos, audio, documents) that rules can send. */
export function MaterialsView() {
  const role = useRole();
  const editable = canManage(role);
  const { data, error, loading, reload } = useApi<{ materials: Material[] }>("/api/automation/materials");
  const [dialog, setDialog] = useState<{ material: Material | null } | null>(null);
  const materials = data?.materials ?? [];

  async function remove(m: Material) {
    let usedBy: string[] = [];
    try {
      usedBy = (await apiFetch<{ usedBy: string[] }>(`/api/automation/materials/${m.id}`)).usedBy;
    } catch {
      // the delete itself will report any real problem
    }
    const ok = await confirm({
      title: `Delete "${m.name}"?`,
      body: usedBy.length ? `These rules send it and will skip that step: ${usedBy.slice(0, 5).join(", ")}${usedBy.length > 5 ? ` and ${usedBy.length - 5} more` : ""}.` : "No rule sends it right now.",
      confirmLabel: "Delete material",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/automation/materials/${m.id}`, { method: "DELETE" });
      toast.success(`"${m.name}" was deleted.`);
      reload();
    } catch (e) {
      toast.error(humanError(e, "delete this material"));
    }
  }

  const columns: Column<Material>[] = [
    { key: "name", header: "Name", primary: true, sortable: true, accessor: (m) => m.name.toLowerCase(), cell: (m) => <span className="font-semibold">{m.name}</span> },
    { key: "kind", header: "Type", cell: (m) => <Badge>{KIND_LABEL[m.kind] ?? m.kind}</Badge> },
    { key: "preview", header: "Content", cell: (m) => <span className="line-clamp-2 max-w-md whitespace-pre-wrap break-words text-muted">{preview(m)}</span> },
    {
      key: "actions",
      header: "Actions",
      srOnlyHeader: true,
      cell: (m) =>
        editable ? (
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <Button size="sm" variant="secondary" className="max-sm:min-h-10" aria-label={`Edit ${m.name}`} onClick={() => setDialog({ material: m })}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" className="max-sm:min-h-10 text-bad-fg" aria-label={`Delete ${m.name}`} onClick={() => void remove(m)}>
              Delete
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Reply materials"
        description="Keep answers you send often in one place: texts, photos, videos, audio clips and documents. Pick them in your rules instead of typing them again."
        actions={
          <>
            <Link href="/app/automation" className={linkButton("secondary", "md")}>
              All rules
            </Link>
            {editable && <Button onClick={() => setDialog({ material: null })}>New material</Button>}
          </>
        }
      />
      {role && !editable && (
        <Alert tone="info" className="mb-4">
          You can look at reply materials. Only admins and owners can change them.
        </Alert>
      )}
      {error && !data ? (
        <ErrorState title="We could not load your reply materials" message="Check your connection and try again." action={<Button onClick={reload}>Try again</Button>} />
      ) : (
        <DataTable
          caption="Reply materials"
          columns={columns}
          rows={materials}
          rowKey={(m) => m.id}
          loading={loading && !data}
          skeletonRows={3}
          empty={<EmptyState title="No reply materials yet" body="Add a price list, an address with directions or a brochure once, then send it from any rule." action={editable ? <Button onClick={() => setDialog({ material: null })}>New material</Button> : undefined} />}
        />
      )}
      {dialog && (
        <MaterialDialog
          material={dialog.material}
          onClose={() => setDialog(null)}
          onSaved={(m) => {
            toast.success(dialog.material ? `"${m.name}" was updated.` : `"${m.name}" was created.`);
            setDialog(null);
            reload();
          }}
        />
      )}
    </div>
  );
}
