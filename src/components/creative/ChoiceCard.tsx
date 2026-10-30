import type { ReactNode } from "react";
import { cn } from "@/components/ui";

/**
 * A whole card that acts as one radio button or checkbox. The native input stays visible, so the choice is clear
 * without colour, and the whole card is the touch target.
 */
export function ChoiceCard({
  type,
  name,
  checked,
  onChange,
  title,
  help,
  disabled,
  children,
  className,
}: {
  type: "radio" | "checkbox";
  name?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: ReactNode;
  help?: ReactNode;
  disabled?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "flex min-h-11 cursor-pointer items-start gap-3 rounded-card border bg-raised p-3.5 shadow-raised transition-colors duration-(--dur-fast) hover:bg-surface",
        checked ? "border-accent bg-accent-soft hover:bg-accent-soft" : "border-border-strong",
        disabled && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      <input type={type} name={name} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-accent" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{title}</span>
        {help && <span className="mt-0.5 block text-sm text-muted">{help}</span>}
        {children}
      </span>
    </label>
  );
}
