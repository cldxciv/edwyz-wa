import { useId } from "react";
import { Spinner, cn } from "@/components/ui";

/**
 * Checkbox with a label and optional help text. The whole row is the click target (at least 40 px high).
 * `busy` keeps the box enabled (so focus is never lost) but ignores changes and shows a small "Saving" spinner.
 * `detail` is a small technical line under the description (for example the raw API scope).
 * `forWhat` adds a hidden suffix to the label for screen readers, so repeated rows can be told apart.
 */
export function CheckRow({
  checked,
  onChange,
  label,
  description,
  detail,
  disabled,
  busy,
  forWhat,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  detail?: string;
  disabled?: boolean;
  busy?: boolean;
  forWhat?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex min-h-10 items-start gap-3 py-1.5", className)}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-busy={busy || undefined}
        aria-describedby={description ? `${id}-d` : undefined}
        onChange={(e) => {
          if (!busy) onChange(e.target.checked);
        }}
        className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-accent disabled:cursor-not-allowed"
      />
      <label htmlFor={id} className={cn("min-w-0 cursor-pointer text-sm", disabled && "cursor-not-allowed text-muted")}>
        <span className="font-medium">
          {label}
          {forWhat && <span className="sr-only"> for {forWhat}</span>}
        </span>
        {description && (
          <span id={`${id}-d`} className="block text-xs text-muted">
            {description}
          </span>
        )}
        {detail && <span className="block font-mono text-xs text-muted">{detail}</span>}
      </label>
      {busy && <Spinner label="Saving" size="sm" />}
    </div>
  );
}
