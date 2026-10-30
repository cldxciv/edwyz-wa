"use client";

import { useState } from "react";
import { apiFetch } from "@/components/ui";
import { Dropdown } from "./Dropdown";
import { Icon } from "./Icon";

type Me = { workspaces: { id: string; name: string; role: string }[]; workspace: { id: string } | null };

/** Shows the workspace name; with two or more workspaces it becomes a menu that switches via /api/auth/switch-workspace. */
export function WorkspaceSwitcher({ currentName }: { currentName: string }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState("");

  function load() {
    if (me) return;
    apiFetch<Me>("/api/auth/me").then(setMe).catch(() => setMe(null));
  }

  async function change(tenantId: string) {
    setError("");
    try {
      await apiFetch("/api/auth/switch-workspace", { method: "POST", body: { tenantId } });
      window.location.assign("/app");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not switch workspace.");
    }
  }

  const items = (me?.workspaces ?? []).map((w) => ({
    label: w.name,
    description: w.role,
    checked: w.id === me?.workspace?.id,
    onSelect: () => (w.id === me?.workspace?.id ? undefined : void change(w.id)),
  }));

  return (
    <div className="relative min-w-0">
      <Dropdown
        label="Workspace"
        triggerLabel={`Workspace: ${currentName}`}
        align="left"
        onOpen={load}
        triggerClassName="max-w-full rounded-lg px-2 py-1.5 hover:bg-surface"
        trigger={
          <>
            <Icon name="building" className="h-4 w-4 text-muted" />
            <span className="truncate text-sm font-semibold">{currentName}</span>
            <Icon name="chevron-down" className="h-4 w-4 text-muted" />
          </>
        }
        header={<p className="text-xs font-medium uppercase tracking-wide text-muted">Switch workspace</p>}
        items={items.length > 0 ? items : [{ label: me ? "Only this workspace" : "Loading...", description: currentName, onSelect: () => undefined }]}
      />
      {error && (
        <p role="alert" className="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
        </p>
      )}
    </div>
  );
}
