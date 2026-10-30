/**
 * Status chips for Eddy (docs/EDDY-SPEC.md 6.3, 6.5, 12.1a decision 0): the panel's status pill (Ready / Working… / Not
 * switched on / Paused / Off for this workspace …) and the state chip on every card. Built on the design-system Badge, so
 * the colour comes from the one status map and the label is always text (colour is never the only signal).
 */
import { Badge, type Tone } from "@/components/ui";
import type { CardState, EddyAvailability } from "@/lib/eddy/contract";
import { t, type CoreKey, type EddyLang } from "@/lib/eddy/i18n";

export type EddyChipState = EddyAvailability | "working";
export type CardChipState = CardState | "undone" | "refused";

const EDDY_TONE: Record<EddyChipState, Tone> = {
  ready: "good",
  working: "info",
  platform_off: "neutral",
  paused: "warn",
  workspace_off: "neutral",
  locked: "bad",
  allowance_used: "warn",
  user_capped: "warn",
};

const CARD_TONE: Record<CardChipState, Tone> = {
  pending: "info",
  running: "info",
  done: "good",
  failed: "bad",
  changed: "warn",
  expired: "neutral",
  cancelled: "neutral",
  unknown: "warn",
  needs_approver: "warn",
  awaiting_approval: "warn",
  spend_frozen: "bad",
  spend_not_set_up: "warn",
  spend_refused: "bad",
  demo: "neutral",
  not_connected: "warn",
  reconnect: "warn",
  undone: "neutral",
  refused: "bad",
};

export function eddyChip(lang: EddyLang, state: EddyChipState): { tone: Tone; label: string } {
  return { tone: EDDY_TONE[state] ?? "neutral", label: t(lang, `eddy.state.${state}` as CoreKey) };
}

export function cardChip(lang: EddyLang, state: CardChipState): { tone: Tone; label: string } {
  return { tone: CARD_TONE[state] ?? "neutral", label: t(lang, `card.state.${state}` as CoreKey) };
}

/** A chip with a tone and a label. `live` makes a change in the label announce politely (a status that moves on its own). */
export function StatusChip({ tone, label, live, className, dot = true }: { tone: Tone; label: string; live?: boolean; className?: string; dot?: boolean }) {
  const chip = (
    <Badge tone={tone} dot={dot} className={className}>
      {label}
    </Badge>
  );
  return live ? (
    <span role="status" aria-live="polite" aria-atomic="true" className="inline-flex">
      {chip}
    </span>
  ) : (
    chip
  );
}

/** The panel's status pill (6.3). */
export function EddyStatusChip({ lang, state, live }: { lang: EddyLang; state: EddyChipState; live?: boolean }) {
  const c = eddyChip(lang, state);
  return <StatusChip tone={c.tone} label={c.label} live={live} />;
}

/** The state chip of a card (6.5). */
export function CardStatusChip({ lang, state, live }: { lang: EddyLang; state: CardChipState; live?: boolean }) {
  const c = cardChip(lang, state);
  return <StatusChip tone={c.tone} label={c.label} live={live} />;
}
