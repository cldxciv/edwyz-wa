export type TeamRow = { id: string; name: string; isDefault: boolean; memberIds: string[]; createdAt: string };
export type PersonRow = { userId: string; name: string; email: string; role: string };

export const MAX_TEAM_NAME = 60;

/** Names of the people in a team, in the order of the member list. Unknown ids (people who left) are skipped. */
export function memberNames(team: TeamRow, people: PersonRow[]): string[] {
  const ids = new Set(team.memberIds);
  return people.filter((p) => ids.has(p.userId)).map((p) => p.name);
}

export function memberSummary(team: TeamRow, people: PersonRow[]): string {
  const names = memberNames(team, people);
  if (names.length === 0) return team.isDefault ? "Everyone. Add people to limit who gets new chats." : "Nobody yet";
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

export function teamNameProblem(value: string, existing: TeamRow[], editingId?: string): string | null {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) return "Give the team a name.";
  if (name.length > MAX_TEAM_NAME) return `Use ${MAX_TEAM_NAME} characters or fewer.`;
  if (existing.some((t) => t.id !== editingId && t.name.toLowerCase() === name.toLowerCase())) return "You already have a team with that name.";
  return null;
}

/** The label used in pickers: the default team says so, because chats without a team belong to it. */
export function teamLabel(team: Pick<TeamRow, "name" | "isDefault">): string {
  return team.isDefault ? `${team.name} (default)` : team.name;
}

/**
 * The people a chat of this team can be handed to: the team's members, or everyone when the team has nobody in it (or the chat has no
 * team and the default team is empty). The current person is kept in the list so the picker can still show them.
 */
export function peopleForTeam<P extends { userId: string }>(teams: TeamRow[], teamId: string | null, people: P[], currentUserId?: string | null): P[] {
  const team = teamId ? teams.find((t) => t.id === teamId) : teams.find((t) => t.isDefault);
  if (!team || team.memberIds.length === 0) return people;
  return people.filter((p) => team.memberIds.includes(p.userId) || p.userId === currentUserId);
}
