"use client";

import { useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/app/PageHeader";
import { useApi } from "@/components/contacts/hooks";
import { RoleGate } from "@/components/team/RoleGate";
import { Alert, Badge, Button, DataTable, Dialog, EmptyState, ErrorState, FormField, Input, apiFetch, confirm, toast, type Column } from "@/components/ui";
import { memberSummary, teamNameProblem, type PersonRow, type TeamRow } from "./helpers";

const touch = "max-sm:min-h-10";
const fail = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export function TeamsView() {
  return (
    <div className="max-w-4xl">
      <PageHeader title="Teams" description="Group your people so chats can go to the right team, for example Sales or Support. Chats with no team belong to the default team." />
      <RoleGate loadingLabel="Loading teams" skeletonClass="h-64" denied={<Alert tone="info">Only owners and admins can manage teams. You can send a chat to a team from the inbox.</Alert>}>
        <Manager />
      </RoleGate>
    </div>
  );
}

function NameDialog({ team, teams, onClose, onSaved }: { team: TeamRow | null; teams: TeamRow[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(team?.name ?? "");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const problem = tried ? teamNameProblem(name, teams, team?.id) : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    setError("");
    // Like the invite dialog: an invalid name puts the cursor back in the field, so typing goes where the error is.
    if (teamNameProblem(name, teams, team?.id)) {
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      if (team) await apiFetch(`/api/teams/${team.id}`, { method: "PATCH", body: { name } });
      else await apiFetch("/api/teams", { method: "POST", body: { name } });
      toast.success(team ? "Team renamed" : "Team created");
      onSaved();
    } catch (err) {
      setError(fail(err, "We could not save this team. Check your connection and try again."));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={team ? "Rename team" : "Add a team"}
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="team-name-form" loading={busy}>
            {team ? "Save" : "Add team"}
          </Button>
        </>
      }
    >
      <form id="team-name-form" onSubmit={submit} noValidate className="space-y-4">
        <FormField label="Team name" error={problem} required>
          <Input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" data-autofocus="" placeholder="Sales" />
        </FormField>
        {error && <Alert tone="bad">{error}</Alert>}
      </form>
    </Dialog>
  );
}

function MembersDialog({ team, people, onClose, onSaved }: { team: TeamRow; people: PersonRow[]; onClose: () => void; onSaved: () => void }) {
  const [picked, setPicked] = useState<Set<string>>(new Set(team.memberIds));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function toggle(id: string, on: boolean) {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/api/teams/${team.id}/members`, { method: "PUT", body: { userIds: [...picked] } });
      toast.success(`${team.name} updated`);
      onSaved();
    } catch (err) {
      setError(fail(err, "We could not save the team. Check your connection and try again."));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`People in ${team.name}`}
      description={team.isDefault ? "If nobody is picked, new chats go to everyone." : "New chats sent to this team go to the people picked here."}
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} loading={busy}>
            Save people
          </Button>
        </>
      }
    >
      <fieldset className="space-y-1">
        <legend className="sr-only">People in {team.name}</legend>
        {people.map((p) => (
          <label key={p.userId} className="flex min-h-10 cursor-pointer items-center gap-3 rounded-control px-1 text-sm hover:bg-surface">
            <input type="checkbox" className="h-5 w-5 shrink-0 accent-accent" checked={picked.has(p.userId)} onChange={(e) => toggle(p.userId, e.target.checked)} />
            <span className="min-w-0">
              <span className="block truncate font-medium">{p.name}</span>
              <span className="block truncate text-xs text-muted">{p.email}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {error && (
        <div className="mt-3">
          <Alert tone="bad">{error}</Alert>
        </div>
      )}
    </Dialog>
  );
}

type DialogState = null | { kind: "name"; team: TeamRow | null } | { kind: "members"; team: TeamRow };

function Manager() {
  const teams = useApi<{ teams: TeamRow[] }>("/api/teams");
  const members = useApi<{ members: PersonRow[] }>("/api/workspace/members");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const list = useMemo(() => teams.data?.teams ?? [], [teams.data]);
  const people = useMemo(() => members.data?.members ?? [], [members.data]);

  async function run(team: TeamRow, action: () => Promise<unknown>, success: string, failure: string) {
    setBusyId(team.id);
    try {
      await action();
      toast.success(success);
      teams.reload();
    } catch (e) {
      toast.error(failure, { description: fail(e, "Please try again.") });
    } finally {
      setBusyId(null);
    }
  }

  async function remove(team: TeamRow) {
    const ok = await confirm({
      title: `Delete ${team.name}?`,
      body: "Chats in this team go back to the default team. Nobody is removed from your workspace.",
      confirmLabel: "Delete team",
      tone: "danger",
    });
    if (ok) await run(team, () => apiFetch(`/api/teams/${team.id}`, { method: "DELETE" }), "Team deleted", "We could not delete this team");
  }

  const columns: Column<TeamRow>[] = [
    {
      key: "name",
      header: "Team",
      primary: true,
      cell: (t) => (
        <span className="flex flex-wrap items-center gap-2 font-medium">
          {t.name}
          {t.isDefault && <Badge tone="info">Default</Badge>}
        </span>
      ),
    },
    { key: "people", header: "People", cell: (t) => <span className="text-muted">{memberSummary(t, people)}</span> },
    {
      key: "actions",
      header: "Actions",
      srOnlyHeader: true,
      align: "right",
      cell: (t) => (
        <span className="flex flex-wrap justify-end gap-1">
          <Button size="sm" variant="secondary" className={touch} onClick={() => setDialog({ kind: "members", team: t })} aria-label={`Choose people for ${t.name}`}>
            People
          </Button>
          <Button size="sm" variant="ghost" className={touch} onClick={() => setDialog({ kind: "name", team: t })} aria-label={`Rename ${t.name}`}>
            Rename
          </Button>
          {!t.isDefault && (
            <>
              <Button
                size="sm"
                variant="ghost"
                className={touch}
                loading={busyId === t.id}
                onClick={() => void run(t, () => apiFetch(`/api/teams/${t.id}`, { method: "PATCH", body: { isDefault: true } }), `${t.name} is now the default team`, "We could not change the default team")}
                aria-label={`Make ${t.name} the default team`}
              >
                Make default
              </Button>
              <Button size="sm" variant="ghost" className={touch} onClick={() => void remove(t)} aria-label={`Delete ${t.name}`}>
                Delete
              </Button>
            </>
          )}
        </span>
      ),
    },
  ];

  if (teams.error && !teams.data) return <ErrorState title="We could not load your teams" message="Check your connection and try again." action={<Button onClick={teams.retry}>Try again</Button>} />;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button className="max-sm:min-h-11" onClick={() => setDialog({ kind: "name", team: null })}>
          Add a team
        </Button>
      </div>
      <DataTable
        caption="Teams and the people in them"
        columns={columns}
        rows={list}
        rowKey={(t) => t.id}
        loading={teams.loading && !teams.data}
        skeletonRows={3}
        empty={<EmptyState compact title="No teams yet" body="Add a team such as Sales or Support, then choose who is in it." />}
      />
      {dialog?.kind === "name" && (
        <NameDialog
          team={dialog.team}
          teams={list}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            teams.reload();
          }}
        />
      )}
      {dialog?.kind === "members" && (
        <MembersDialog
          team={dialog.team}
          people={people}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            teams.reload();
          }}
        />
      )}
    </div>
  );
}
