import { cn } from "@/components/ui";

type Props = {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Names the switch for screen readers, for example "Welcome message". Keep it the same when the switch changes: the state is announced from aria-checked. */
  label: string;
  disabled?: boolean;
  onText?: string;
  offText?: string;
  className?: string;
};

/** On/off switch. The state is written out as text next to the track, so it never relies on colour alone. */
export function Toggle({ checked, onChange, label, disabled, onText = "On", offText = "Off", className }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn("inline-flex min-h-10 items-center gap-2 rounded-full pr-1 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50", className)}
    >
      <span
        aria-hidden
        className={cn(
          "relative inline-block h-6 w-11 shrink-0 rounded-full border transition-colors duration-(--dur-fast)",
          checked ? "border-accent bg-accent" : "border-border-strong bg-surface-2",
        )}
      >
        <span
          className={cn(
            "absolute left-0.5 top-0.5 h-4.5 w-4.5 rounded-full shadow-raised transition-transform duration-(--dur-fast)",
            checked ? "translate-x-5 bg-on-accent" : "translate-x-0 bg-muted",
          )}
        />
      </span>
      <span aria-hidden className="w-7 text-left">{checked ? onText : offText}</span>
    </button>
  );
}
