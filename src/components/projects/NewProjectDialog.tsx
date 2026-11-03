"use client";

import { useId, useRef, useState } from "react";
import { Alert, Button, Dialog, FormField, Input, toast } from "@/components/ui";
import { normalizeProjectName, projectNameProblem } from "@/lib/projects/names";
import { PROJECT_NAME_MAX, type CreatedProject, type NewProjectAccess } from "@/lib/projects/types";
import { NEW_PROJECT_DESCRIPTION, NEW_PROJECT_HINT, createRefusal, createdButNotOpenedText, switchingText } from "./helpers";
import { createProjectRequest, switchToProject } from "./switch";

type Props = {
  /** From the overview: null while it loads (the server checks again either way). */
  access: NewProjectAccess | null;
  onClose: () => void;
  /** The project was created but the switch failed: the list should show it. */
  onCreated?: () => void;
};

const fail = (e: unknown) => (e instanceof Error && e.message ? e.message : "Check your connection and try again.");

/** The New project form: a name, then the project is created with a free trial and this browser switches to it. */
export function NewProjectDialog({ access, onClose, onCreated }: Props) {
  const formId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [refusedName, setRefusedName] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const blocked = access && !access.allowed ? access.reason : null;
  const nameError = (tried ? projectNameProblem(name) : null) ?? refusedName;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    setRefusedName(null);
    setFormError(null);
    if (blocked) return;
    if (projectNameProblem(name)) {
      nameRef.current?.focus();
      return;
    }
    const clean = normalizeProjectName(name);
    setBusy(true);
    setStatus(`Starting ${clean}...`);
    let created: CreatedProject;
    try {
      created = await createProjectRequest(clean);
    } catch (err) {
      const refusal = createRefusal(err);
      setRefusedName(refusal.field);
      setFormError(refusal.form);
      setStatus("");
      setBusy(false);
      if (refusal.field) nameRef.current?.focus();
      return;
    }
    setStatus(switchingText(created.project.name));
    try {
      // Navigates away on success, so the form stays busy.
      await switchToProject(created.project.id);
    } catch (err) {
      setStatus("");
      setBusy(false);
      toast.error(createdButNotOpenedText(created.project.name, fail(err)));
      onCreated?.();
      onClose();
    }
  }

  return (
    <Dialog
      title="Start a new project"
      description={NEW_PROJECT_DESCRIPTION}
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={busy} disabled={Boolean(blocked)}>
            Create project
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        {blocked && (
          <Alert tone="warn" title="You can't start a new project yet">
            {blocked}
          </Alert>
        )}
        <FormField label="Project name" required hint={NEW_PROJECT_HINT} error={nameError}>
          <Input
            ref={nameRef}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (refusedName) setRefusedName(null);
            }}
            maxLength={PROJECT_NAME_MAX}
            autoComplete="organization"
            placeholder="e.g. Sharma Sweets"
            data-autofocus=""
            disabled={busy || Boolean(blocked)}
          />
        </FormField>
        {formError && <Alert tone="bad">{formError}</Alert>}
        <p role="status" aria-live="polite" className="sr-only">
          {status}
        </p>
      </form>
    </Dialog>
  );
}
