"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/app/Icon";
import { PageHeader } from "@/components/app/PageHeader";
import { Alert, Button, EmptyState, ErrorState, FormField, Input, Skeleton, apiFetch, toast } from "@/components/ui";
import type { ProjectSummary, ProjectsOverview } from "@/lib/projects/types";
import { FILTER_FROM, PAGE_DESCRIPTION, SPEND_HINT, filterProjects, listSummary, switchFailedText, switchingText } from "./helpers";
import { PROJECTS_HREF } from "./links";
import { NewProjectDialog } from "./NewProjectDialog";
import { ProjectCard } from "./ProjectCard";
import { switchToProject } from "./switch";

const fail = (e: unknown) => (e instanceof Error && e.message ? e.message : "Check your connection and try again.");

function ProjectsSkeleton() {
  return (
    <div role="status" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <span className="sr-only">Loading your projects</span>
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-64 w-full" />
      ))}
    </div>
  );
}

/**
 * All projects: every workspace the person belongs to, as cards (one column on phones), with Switch and New project.
 * `startNew` opens the New project form at once (the workspace menu links here with ?new=1).
 */
export function ProjectsView({ startNew = false }: { startNew?: boolean }) {
  const router = useRouter();
  const [data, setData] = useState<ProjectsOverview | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [creating, setCreating] = useState(startNew);
  const [query, setQuery] = useState("");
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await apiFetch<ProjectsOverview>("/api/projects/overview"));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The workspace menu's New project link can be followed while this page is already open.
  useEffect(() => {
    if (startNew) setCreating(true);
  }, [startNew]);

  function closeNew() {
    setCreating(false);
    // Drop ?new=1 so a reload or Back does not open the form again.
    if (startNew) router.replace(PROJECTS_HREF);
  }

  async function open(project: ProjectSummary) {
    setSwitchingId(project.id);
    setStatus(switchingText(project.name));
    try {
      await switchToProject(project.id);
    } catch (err) {
      toast.error(switchFailedText(project.name, fail(err)));
      setSwitchingId(null);
      setStatus("");
    }
  }

  const projects = useMemo(() => data?.projects ?? [], [data]);
  const shown = useMemo(() => filterProjects(projects, query), [projects, query]);
  const summary = data ? listSummary(shown.length, projects.length, query) : "";

  const header = (
    <PageHeader
      title="All projects"
      description={PAGE_DESCRIPTION}
      actions={
        <Button type="button" onClick={() => setCreating(true)}>
          <Icon name="plus" className="h-4 w-4" />
          New project
        </Button>
      }
    />
  );

  return (
    <div>
      {header}
      {loadError && !data ? (
        <ErrorState title="We could not load your projects" message="Check your connection and try again." action={<Button variant="secondary" onClick={() => void load()}>Try again</Button>} />
      ) : !data ? (
        <ProjectsSkeleton />
      ) : (
        <div className="space-y-4">
          {data.truncated && (
            <Alert tone="info">
              Showing {projects.length} of your {data.total} projects: this one and the ones you joined first. Use the workspace menu at the top to reach the others.
            </Alert>
          )}
          {projects.length > FILTER_FROM && (
            <FormField label="Find a project" className="max-w-sm">
              <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. Sharma" autoComplete="off" />
            </FormField>
          )}
          <p className="text-sm text-muted" aria-live="polite">
            {summary}
          </p>
          {shown.length === 0 ? (
            projects.length === 0 ? (
              <EmptyState title="No projects yet" body="Start a project for each business or client you look after." action={<Button onClick={() => setCreating(true)}>New project</Button>} />
            ) : (
              <EmptyState compact title={`No projects match "${query.trim()}"`} body="Check the spelling, or clear the search to see every project." action={<Button variant="secondary" onClick={() => setQuery("")}>Clear search</Button>} />
            )
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((p) => (
                <li key={p.id} className="min-w-0">
                  <ProjectCard project={p} leadsWindowDays={data.leadsWindowDays} switching={switchingId === p.id} disabled={switchingId !== null && switchingId !== p.id} onSwitch={(project) => void open(project)} />
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted">{SPEND_HINT} Unread chats count only the chats you can see in that project.</p>
        </div>
      )}
      <p role="status" aria-live="polite" className="sr-only">
        {status}
      </p>
      {creating && <NewProjectDialog access={data?.newProject ?? null} onClose={closeNew} onCreated={() => void load()} />}
    </div>
  );
}
