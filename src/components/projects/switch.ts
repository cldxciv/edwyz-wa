import { apiFetch } from "@/components/ui";
import type { CreatedProject } from "@/lib/projects/types";

/** Where a switch lands: the dashboard of the project switched to (the same as the workspace menu). */
export const AFTER_SWITCH = "/app";

const go = (path: string) => window.location.assign(path);

/** Moves this browser's session to the project through POST /api/auth/switch-workspace, then opens its dashboard. */
export async function switchToProject(tenantId: string, navigate: (path: string) => void = go): Promise<void> {
  await apiFetch("/api/auth/switch-workspace", { method: "POST", body: { tenantId } });
  navigate(AFTER_SWITCH);
}

/** POST /api/projects. Throws the server's refusal (its `body.field` says when it is about the name). */
export function createProjectRequest(name: string): Promise<CreatedProject> {
  return apiFetch<CreatedProject>("/api/projects", { method: "POST", body: { name } });
}
