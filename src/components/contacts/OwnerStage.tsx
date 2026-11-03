"use client";

import { useMemo } from "react";
import { FormField, Select } from "@/components/ui";
import { useApi } from "./hooks";

export type PersonOption = { userId: string; name: string };

/** The workspace members (for the owner picker) and the lead stages the owner configured. Fails quietly: the fields just stay empty. */
export function useOwnerStageOptions() {
  const members = useApi<{ members: PersonOption[] }>("/api/workspace/members");
  const stages = useApi<{ leadStages: string[] }>("/api/teams");
  const people = useMemo(() => members.data?.members ?? [], [members.data]);
  const names = useMemo(() => new Map(people.map((p) => [p.userId, p.name])), [people]);
  return { people, names, stages: stages.data?.leadStages ?? [] };
}

/** Only the changed fields are sent, so saving a name never overwrites an owner someone else just set. */
export function ownerStagePatch(initial: { owner: string; stage: string }, next: { owner: string; stage: string }): { ownerUserId?: string | null; leadStage?: string | null } | null {
  const patch: { ownerUserId?: string | null; leadStage?: string | null } = {};
  if (next.owner !== initial.owner) patch.ownerUserId = next.owner || null;
  if (next.stage !== initial.stage) patch.leadStage = next.stage || null;
  return Object.keys(patch).length ? patch : null;
}

export function OwnerStageFields({
  owner,
  stage,
  onOwner,
  onStage,
  people,
  stages,
}: {
  owner: string;
  stage: string;
  onOwner: (value: string) => void;
  onStage: (value: string) => void;
  people: PersonOption[];
  stages: string[];
}) {
  const stageChoices = stage && !stages.includes(stage) ? [stage, ...stages] : stages;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormField label="Owner" optional hint="The teammate responsible for this customer.">
        <Select value={owner} onChange={(e) => onOwner(e.target.value)}>
          <option value="">No owner</option>
          {people.map((p) => (
            <option key={p.userId} value={p.userId}>
              {p.name}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Lead stage" optional hint="Where this customer is in your sales process. The list is set in Chat routing settings. It is separate from the stages on the Leads page.">
        <Select value={stage} onChange={(e) => onStage(e.target.value)}>
          <option value="">Not set</option>
          {stageChoices.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </FormField>
    </div>
  );
}
