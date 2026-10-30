import type { ComponentProps } from "react";
import { cn } from "./cn";

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap select-none transition-colors duration-(--dur-fast) disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress";

export const buttonVariants = {
  primary: "bg-accent text-on-accent shadow-raised hover:bg-accent-strong",
  secondary: "border border-border-strong bg-raised text-foreground shadow-raised hover:bg-surface-2",
  danger: "bg-danger text-on-accent shadow-raised hover:bg-danger-strong",
  ghost: "text-foreground hover:bg-surface-2",
} as const;

export const buttonSizes = {
  sm: "min-h-8 px-3 text-xs",
  md: "min-h-10 px-5 text-sm",
  lg: "min-h-11 px-6 text-base",
} as const;

export type ButtonProps = ComponentProps<"button"> & {
  variant?: keyof typeof buttonVariants;
  size?: keyof typeof buttonSizes;
  /** Disables the button, shows a spinner and sets aria-busy. Keep the label so the width does not jump. */
  loading?: boolean;
};

export function ButtonSpinner() {
  return <span className="ui-spinner h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent" aria-hidden />;
}

export function Button({ variant = "primary", size = "md", loading, disabled, className, children, ...props }: ButtonProps) {
  return (
    <button className={cn(buttonBase, buttonVariants[variant], buttonSizes[size], className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading && <ButtonSpinner />}
      {children}
    </button>
  );
}
