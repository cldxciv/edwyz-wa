"use client";

import { useState } from "react";
import { Alert, Button, Dialog, FormField, Input, Select, Textarea, apiFetch } from "@/components/ui";
import { LIMITS } from "@/lib/automation/v2/model";
import { PLACEHOLDER_HELP } from "@/lib/automation/v2/variables";
import { useApi } from "@/components/contacts/hooks";
import { humanError, ownSubmit } from "./helpers";

export type Material = { id: string; name: string; kind: string; body: string | null; mediaKey: string | null; mediaMime: string | null };

const FILE_TYPES = [
  { value: "image/jpeg", label: "Photo" },
  { value: "video/mp4", label: "Video" },
  { value: "audio/mpeg", label: "Voice note or audio" },
];

const FORM_ID = "material-form";
const KEY = /^[a-f0-9]{32}\.(jpg|png|mp4|mov)$/;

type Library = { media: { key: string; kind: "image" | "video"; bytes: number; createdAt: string }[] };

type Props = {
  material: Material | null;
  onClose: () => void;
  onSaved: (material: Material) => void;
};

/** Create or edit one reply material: ready-made text, a photo, video, audio clip or document that rules can send. */
export function MaterialDialog({ material, onClose, onSaved }: Props) {
  const [name, setName] = useState(material?.name ?? "");
  const [kind, setKind] = useState(material?.kind ?? "text");
  const [body, setBody] = useState(material?.body ?? "");
  const [link, setLink] = useState(material?.mediaKey && !KEY.test(material.mediaKey) ? material.mediaKey : "");
  const [libraryKey, setLibraryKey] = useState(material?.mediaKey && KEY.test(material.mediaKey) ? material.mediaKey : "");
  const [mime, setMime] = useState(material?.mediaMime ?? (material?.kind === "document" ? "application/pdf" : "image/jpeg"));
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const library = useApi<Library>(kind === "media" ? "/api/content/media" : null);

  const media = libraryKey || link.trim();
  const problems = {
    name: !name.trim() ? 'Give the material a name, for example "Price list".' : undefined,
    body: kind === "text" && !body.trim() ? "Write the message customers will receive." : undefined,
    media: kind !== "text" && !media ? "Add a link to the file, or choose one from your media library." : kind !== "text" && !libraryKey && !/^https:\/\//i.test(media) ? "The link must start with https://." : undefined,
  };
  const invalid = Object.values(problems).some(Boolean);

  async function submit(e: React.FormEvent) {
    // The dialog is opened from inside the rule form: without this its submit would also run the rule form's and save the rule.
    if (!ownSubmit(e)) return;
    setAttempted(true);
    if (invalid) return;
    setBusy(true);
    setError(null);
    const payload = {
      name: name.trim(),
      kind,
      body: body.trim() || null,
      mediaKey: kind === "text" ? null : media,
      mediaMime: kind === "text" ? null : kind === "document" ? "application/pdf" : libraryKey ? (libraryKey.endsWith(".mp4") || libraryKey.endsWith(".mov") ? "video/mp4" : "image/jpeg") : mime,
    };
    try {
      const res = material ? await apiFetch<{ material: Material }>(`/api/automation/materials/${material.id}`, { method: "PATCH", body: payload }) : await apiFetch<{ material: Material }>("/api/automation/materials", { method: "POST", body: payload });
      onSaved(res.material);
    } catch (err) {
      setError(humanError(err, "save this reply material"));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={material ? "Edit reply material" : "New reply material"}
      description="Keep answers you send often in one place, then pick them in your rules."
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={FORM_ID} loading={busy}>
            {material ? "Save changes" : "Create material"}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={submit} noValidate className="space-y-4">
        {error && (
          <Alert tone="bad" title="Not saved">
            {error}
          </Alert>
        )}
        <FormField label="Name" required hint="Only your team sees this." error={attempted ? problems.name : undefined}>
          <Input value={name} maxLength={LIMITS.name} onChange={(e) => setName(e.target.value)} data-autofocus="" placeholder="e.g. Price list" />
        </FormField>
        <FormField label="What do you want to send?">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="text">A text message</option>
            <option value="media">A photo, video or audio clip</option>
            <option value="document">A document (for example a PDF)</option>
          </Select>
        </FormField>
        <FormField
          label={kind === "text" ? "Message" : "Caption"}
          required={kind === "text"}
          optional={kind !== "text"}
          hint={`${body.length}/${LIMITS.text}. You can use ${PLACEHOLDER_HELP.map((p) => p.token).join(", ")}.`}
          error={attempted ? problems.body : undefined}
        >
          <Textarea rows={kind === "text" ? 5 : 3} value={body} maxLength={LIMITS.text} onChange={(e) => setBody(e.target.value)} />
        </FormField>
        {kind !== "text" && (
          <fieldset className="space-y-3 rounded-card border border-border p-3">
            <legend className="px-1 text-sm font-medium">The file</legend>
            <FormField label="Link to the file" hint="A secure link (https) that opens the file without signing in." error={attempted && !libraryKey ? problems.media : undefined}>
              <Input type="url" inputMode="url" value={link} placeholder="https://example.com/price-list.pdf" onChange={(e) => (setLink(e.target.value), setLibraryKey(""))} />
            </FormField>
            {kind === "media" && (
              <>
                <FormField label="Or choose from your media library" optional hint={library.data && library.data.media.length === 0 ? "Your media library is empty. Add files from the Content calendar." : undefined}>
                  <Select value={libraryKey} onChange={(e) => (setLibraryKey(e.target.value), e.target.value && setLink(""))}>
                    <option value="">None</option>
                    {library.data?.media.map((m) => (
                      <option key={m.key} value={m.key}>
                        {m.kind === "video" ? "Video" : "Photo"} added {new Date(m.createdAt).toLocaleDateString()}
                      </option>
                    ))}
                  </Select>
                </FormField>
                {!libraryKey && (
                  <FormField label="What kind of file is the link?">
                    <Select value={mime} onChange={(e) => setMime(e.target.value)}>
                      {FILE_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                )}
              </>
            )}
          </fieldset>
        )}
      </form>
    </Dialog>
  );
}
