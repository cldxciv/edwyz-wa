"use client";

import { useCallback, useState } from "react";
import { useApi } from "@/components/contacts/hooks";
import { apiFetch } from "@/components/ui";
import type { StepId, SetupStep, SetupSummary } from "@/lib/setup/checklist";

export type SetupResponse = { steps: SetupStep[]; summary: SetupSummary; canDismiss: boolean };

/** Loads the setup checklist and exposes "not now" / "bring back" for admins. */
export function useSetup() {
  const api = useApi<SetupResponse>("/api/setup");
  const [override, setOverride] = useState<SetupResponse | null>(null);
  const [busy, setBusy] = useState<StepId | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const dismiss = useCallback(async (stepId: StepId, dismissed: boolean) => {
    setBusy(stepId);
    setActionError(null);
    try {
      setOverride(await apiFetch<SetupResponse>("/api/setup/dismiss", { method: "POST", body: { stepId, dismissed } }));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not save that. Try again.");
    } finally {
      setBusy(null);
    }
  }, []);

  const apiReload = api.reload;
  const reload = useCallback(() => {
    setOverride(null);
    apiReload();
  }, [apiReload]);

  return { data: override ?? api.data, error: api.error, loading: api.loading, reload, dismiss, busy, actionError };
}
