"use client";

import { useState } from "react";
import { useApi } from "@/components/contacts/hooks";
import { Field, Select, apiFetch } from "@/components/ui";
import { peopleForTeam, teamLabel, type TeamRow } from "./helpers";

/** Teams for pickers. Empty until loaded; the pickers stay hidden when the workspace only has the default team. */
export function useTeams(): TeamRow[] {
  const teams = useApi<{ teams: TeamRow[] }>("/api/teams");
  return teams.data?.teams ?? [];
}

/** Inbox list filter: all teams, one team, or chats with no team. Hidden when there is only the default team. */
export function TeamFilter({ value, onChange }: { value: string; onChange: (team: string) => void }) {
  const teams = useTeams();
  if (teams.length < 2) return null;
  return (
    <Select aria-label="Filter by team" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">All teams</option>
      {teams.map((t) => (
        <option key={t.id} value={t.id}>
          {teamLabel(t)}
        </option>
      ))}
    </Select>
  );
}

type Person = { userId: string; name: string };

/**
 * Chat panel: move a chat to a team, then choose who handles it inside that team. Moving a chat to a new team lets routing pick
 * someone in it when the current person is not a member; the second picker lists only the team's people.
 */
export function TeamAssign({ conversationId, teamId, assignedToId, members, onChanged }: { conversationId: string; teamId: string | null; assignedToId: string | null; members: Person[]; onChanged: () => void }) {
  const teams = useTeams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (teams.length < 2) return null;
  const defaultTeam = teams.find((t) => t.isDefault);
  const value = teamId ?? defaultTeam?.id ?? "";
  const people = peopleForTeam(teams, teamId, members, assignedToId);

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/teams/assign", { method: "POST", body: { conversationId, ...body } });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="col-span-2">
        <Field label="Team" htmlFor="panel-team" error={error}>
          <Select id="panel-team" value={value} disabled={busy} onChange={(e) => void send({ teamId: e.target.value === defaultTeam?.id ? null : e.target.value, route: true })}>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {teamLabel(t)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="col-span-2">
        <Field label="Handled by (inside the team)" htmlFor="panel-team-person" hint="Only people in the chosen team are listed.">
          <Select id="panel-team-person" value={assignedToId ?? ""} disabled={busy} onChange={(e) => void send({ teamId, userId: e.target.value || null })}>
            <option value="">Nobody yet</option>
            {people.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </>
  );
}
