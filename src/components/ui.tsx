import { cloneElement, isValidElement, useId, type ComponentProps, type HTMLAttributes, type ReactElement, type ReactNode } from "react";
import { cn } from "./ui/cn";
import { clampPercent, meterTone } from "./ui/a11y";
import { Skeleton } from "./ui/feedback";
import { statusLabel, statusTone, type Tone } from "./ui/status";

/*
 * Design system entry point. Everything the app needs is exported from here; client-only pieces live in ./ui/* and
 * are re-exported at the bottom. See docs/ui-guidelines.md.
 */

export { cn };
export { Button, buttonSizes, buttonVariants, type ButtonProps } from "./ui/Button";
export { Alert, EmptyState, ErrorState, Skeleton, SkeletonText, Spinner } from "./ui/feedback";

export function Card({
  className,
  children,
  title,
  description,
  actions,
  footer,
  padded = true,
  headingLevel: Heading = "h2",
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** Set false for edge-to-edge content such as a table. */
  padded?: boolean;
  headingLevel?: "h2" | "h3" | "h4";
}) {
  const header = title || actions;
  return (
    <div className={cn("rounded-card border border-border bg-raised shadow-raised", padded && "p-5", className)} {...rest}>
      {header && (
        <div className={cn("mb-4 flex flex-wrap items-start justify-between gap-3", !padded && "px-5 pt-5")}>
          <div className="min-w-0">
            {title && <Heading className="text-base font-semibold tracking-tight">{title}</Heading>}
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
        </div>
      )}
      {children}
      {footer && <div className={cn("mt-4 border-t border-border pt-4", !padded && "px-5 pb-5")}>{footer}</div>}
    </div>
  );
}

const badgeTones: Record<Tone, string> = {
  neutral: "bg-surface text-muted border-border",
  good: "bg-good-soft text-good-fg border-good-line",
  warn: "bg-warn-soft text-warn-fg border-warn-line",
  bad: "bg-bad-soft text-bad-fg border-bad-line",
  info: "bg-info-soft text-info-fg border-info-line",
};

export function Badge({ tone = "neutral", children, dot, className }: { tone?: Tone; children: ReactNode; dot?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium", badgeTones[tone], className)}>
      {dot && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/** One status, one colour, everywhere. Pass the raw status string; the map lives in ./ui/status. */
export function StatusPill({ status, label, tone, className }: { status: string | null | undefined; label?: string; tone?: Tone; className?: string }) {
  return (
    <Badge dot tone={tone ?? statusTone(status)} className={className}>
      {label ?? statusLabel(status)}
    </Badge>
  );
}

const fieldBase =
  "block w-full min-h-10 rounded-control border border-border-strong bg-raised px-3 py-2 text-sm text-foreground shadow-raised placeholder:text-muted transition-colors duration-(--dur-fast) hover:border-foreground/50 focus:border-accent aria-invalid:border-bad disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted disabled:shadow-none [&[readonly]]:bg-surface";

type Wiring = { id: string; describedBy?: string; invalid?: boolean; required?: boolean };

function wire(child: ReactNode, w: Wiring, onlyIfId?: string): ReactNode {
  if (!isValidElement(child)) return child;
  const props = child.props as Record<string, unknown>;
  if (onlyIfId !== undefined && props.id !== onlyIfId) return child;
  const extra: Record<string, unknown> = {};
  if (props.id === undefined) extra.id = w.id;
  if (w.describedBy) extra["aria-describedby"] = [props["aria-describedby"], w.describedBy].filter(Boolean).join(" ");
  if (w.invalid) extra["aria-invalid"] = true;
  if (w.required && props["aria-required"] === undefined) extra["aria-required"] = true;
  return Object.keys(extra).length ? cloneElement(child as ReactElement<Record<string, unknown>>, extra) : child;
}

type FieldShellProps = {
  label: string;
  id: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  optional?: boolean;
  children: ReactNode;
  onlyIfId?: string;
  className?: string;
};

function FieldShell({ label, id, hint, error, required, optional, children, onlyIfId, className }: FieldShellProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {required && (
          <span aria-hidden className="ml-0.5 text-bad-fg">
            *
          </span>
        )}
        {optional && <span className="ml-1.5 text-xs font-normal text-muted">(optional)</span>}
      </label>
      {wire(children, { id, describedBy, invalid: !!error, required }, onlyIfId)}
      {hint && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs font-medium text-bad-fg">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Label, control, hint and error for one input. The control must carry id={htmlFor}. Existing callers keep working;
 * hint and error are now linked to the control for screen readers.
 */
export function Field({ label, htmlFor, hint, error, required, optional, children }: { label: string; htmlFor: string; hint?: string; error?: string | null; required?: boolean; optional?: boolean; children: ReactNode }) {
  return (
    <FieldShell label={label} id={htmlFor} hint={hint} error={error} required={required} optional={optional} onlyIfId={htmlFor}>
      {children}
    </FieldShell>
  );
}

/** Like Field, but generates the id and wires it into the single child control for you. */
export function FormField({ label, hint, error, required, optional, children, className }: { label: string; hint?: string; error?: string | null; required?: boolean; optional?: boolean; children: ReactElement; className?: string }) {
  const id = useId();
  return (
    <FieldShell label={label} id={id} hint={hint} error={error} required={required} optional={optional} className={className}>
      {children}
    </FieldShell>
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(fieldBase, className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(fieldBase, "min-h-20", className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(fieldBase, "pr-8", className)} {...props} />;
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

const meterFill: Record<Tone, string> = { neutral: "bg-muted", good: "bg-good", warn: "bg-warn", bad: "bg-bad", info: "bg-info" };

/**
 * Determinate bar (pass value) or indeterminate (omit value). tone="auto" turns amber at warnAt and red at dangerAt percent,
 * which suits quotas. The label is always available to screen readers; set showLabel to see it too.
 */
export function ProgressBar({
  value,
  max = 100,
  label,
  showLabel,
  showValue,
  valueText,
  tone = "good",
  warnAt = 70,
  dangerAt = 90,
  size = "md",
  className,
}: {
  value?: number;
  max?: number;
  label: string;
  showLabel?: boolean;
  showValue?: boolean;
  valueText?: string;
  tone?: Tone | "auto";
  warnAt?: number;
  dangerAt?: number;
  size?: "sm" | "md";
  className?: string;
}) {
  const id = useId();
  const determinate = value !== undefined;
  const percent = determinate ? clampPercent(value, max) : 0;
  const resolved: Tone = tone === "auto" ? meterTone(percent, warnAt, dangerAt) : tone;
  const text = valueText ?? `${Math.round(percent)}%`;
  return (
    <div className={className}>
      {(showLabel || showValue) && (
        <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
          <span id={id} className={cn("font-medium", !showLabel && "sr-only")}>
            {label}
          </span>
          {showValue && determinate && <span className="tabular-nums text-muted">{text}</span>}
        </div>
      )}
      <div
        role="progressbar"
        aria-labelledby={showLabel || showValue ? id : undefined}
        aria-label={showLabel || showValue ? undefined : label}
        aria-valuemin={determinate ? 0 : undefined}
        aria-valuemax={determinate ? max : undefined}
        aria-valuenow={determinate ? Math.min(Math.max(value, 0), max) : undefined}
        aria-valuetext={determinate ? text : undefined}
        className={cn("w-full overflow-hidden rounded-full bg-surface-2", size === "sm" ? "h-1.5" : "h-2.5")}
      >
        <div
          className={cn("h-full rounded-full transition-[width] duration-(--dur-slow) ease-(--ease-out)", meterFill[resolved], !determinate && "ui-skeleton w-full opacity-60")}
          style={determinate ? { width: `${percent}%` } : undefined}
        />
      </div>
    </div>
  );
}

/** Headline number with a label, for dashboards and summaries. delta.good says whether the change is an improvement, independent of its direction. */
export function Stat({
  label,
  value,
  hint,
  delta,
  icon,
  loading,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  delta?: { value: string; direction?: "up" | "down" | "flat"; good?: boolean };
  icon?: ReactNode;
  loading?: boolean;
  className?: string;
}) {
  const direction = delta?.direction ?? "flat";
  const arrow = direction === "up" ? "▲" : direction === "down" ? "▼" : "▬";
  return (
    <div className={cn("rounded-card border border-border bg-raised p-4 shadow-raised", className)} aria-busy={loading || undefined}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted">{label}</p>
        {icon && (
          <span className="text-muted" aria-hidden>
            {icon}
          </span>
        )}
      </div>
      {loading ? (
        <>
          <Skeleton className="mt-2 h-7 w-24" />
          <span className="sr-only">Loading {label}</span>
        </>
      ) : (
        <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      )}
      {!loading && (delta || hint) && (
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted">
          {delta && (
            <span className={cn("inline-flex items-center gap-1 font-medium", delta.good === undefined ? "text-muted" : delta.good ? "text-good-fg" : "text-bad-fg")}>
              <span aria-hidden>{arrow}</span>
              <span className="sr-only">{direction === "up" ? "Up " : direction === "down" ? "Down " : "No change "}</span>
              {delta.value}
            </span>
          )}
          {hint}
        </p>
      )}
    </div>
  );
}

/** A keyboard key or a combination: <KeyboardKey keys={["Ctrl", "K"]} /> or <KeyboardKey>Esc</KeyboardKey>. */
export function KeyboardKey({ children, keys }: { children?: ReactNode; keys?: string[] }) {
  if (keys?.length) {
    return (
      <span className="inline-flex items-center gap-1">
        {keys.map((k, i) => (
          <span key={`${k}-${i}`} className="inline-flex items-center gap-1">
            {i > 0 && (
              <span aria-hidden className="text-xs text-muted">
                +
              </span>
            )}
            <kbd className="ui-kbd">{k}</kbd>
          </span>
        ))}
      </span>
    );
  }
  return <kbd className="ui-kbd">{children}</kbd>;
}

export const Kbd = KeyboardKey;

/** Small typed fetch helper for client components. Throws Error(message) with the server's error text on non-2xx; the parsed response is on `body`. */
export async function apiFetch<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  // A network failure surfaces as the browser's own TypeError ("Failed to fetch"); never show that text.
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  }).catch(() => {
    throw new Error("We could not reach the server.");
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((json as { error?: string }).error ?? "Something went wrong."), { body: json });
  return json as T;
}


export { statusLabel, statusTone, STATUS_TONE, isKnownStatus, normalizeStatus, type Tone } from "./ui/status";
export { nextSort, sortRows, type SortState, type SortDir, type SortValue } from "./ui/table-sort";
export { clampPercent, meterTone } from "./ui/a11y";
export { ToastProvider, toast, useToast, type ToastApi } from "./ui/Toast";
export type { ToastInput, ToastTone } from "./ui/toast-state";
export { ConfirmDialog, ConfirmProvider, confirm, useConfirm, type ConfirmOptions } from "./ui/ConfirmDialog";
export { Dialog, type DialogProps } from "./ui/Dialog";
export { Tooltip } from "./ui/Tooltip";
export { Tabs, tabIds, type TabItem } from "./ui/Tabs";
export { DataTable, type Column, type DataTableProps } from "./ui/DataTable";
export { CopyButton } from "./ui/CopyButton";
export { UiProvider } from "./ui/UiProvider";
