import { Badge } from "@/components/ui";
import { responseHighlight } from "./helpers";
import type { LeadItem } from "./types";

export function ResponseBadge({ lead, now }: { lead: Pick<LeadItem, "status" | "createdAt" | "responseSeconds">; now: number }) {
  const h = responseHighlight(lead, now);
  return (
    <Badge tone={h.tone} dot>
      <span title={h.hint}>{h.label}</span>
    </Badge>
  );
}

export function ConsentBadge({ needsOptIn }: { needsOptIn: boolean }) {
  return needsOptIn ? <Badge tone="warn">Needs opt-in</Badge> : <Badge tone="good">Opted in</Badge>;
}
