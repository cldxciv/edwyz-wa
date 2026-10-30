import type { ReactNode } from "react";
import { cn } from "./cn";
import type { Tone } from "./status";

const SPINNER_SIZES = { sm: "h-3.5 w-3.5 border-2", md: "h-4 w-4 border-2", lg: "h-6 w-6 border-[3px]" } as const;

export function Spinner({ label = "Loading", size = "md", hideLabel }: { label?: string; size?: keyof typeof SPINNER_SIZES; hideLabel?: boolean }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-muted">
      <span className={cn("ui-spinner rounded-full border-border-strong border-t-accent", SPINNER_SIZES[size])} aria-hidden />
      <span className={hideLabel ? "sr-only" : undefined}>{label}</span>
    </span>
  );
}

/** Placeholder block while content loads. Decorative: put aria-busy on the container and a Spinner or status text for screen readers. */
export function Skeleton({ className, circle }: { className?: string; circle?: boolean }) {
  return <span aria-hidden className={cn("ui-skeleton block", circle ? "rounded-full" : "rounded-md", className ?? "h-4 w-full")} />;
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn("h-3.5", i === lines - 1 && lines > 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

/**
 * Nothing to show yet. Title says what is missing, body says why or what to do, action is the one next step.
 * "compact" is for panels and table bodies, the default is for whole pages.
 */
export function EmptyState({ title, body, action, icon, compact }: { title: string; body?: string; action?: ReactNode; icon?: ReactNode; compact?: boolean }) {
  return (
    <div className={cn("rounded-card border border-dashed border-border-strong text-center", compact ? "p-6" : "p-10")}>
      {icon && (
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-surface-2 text-muted" aria-hidden>
          {icon}
        </div>
      )}
      <p className="font-semibold">{title}</p>
      {body && <p className="mx-auto mt-2 max-w-md text-sm text-muted">{body}</p>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/** A request failed. Say what happened in plain words and offer a retry. */
export function ErrorState({ title = "We could not load this", message, action }: { title?: string; message?: string; action?: ReactNode }) {
  return (
    <div role="alert" className="rounded-card border border-bad-line bg-bad-soft p-6 text-center">
      <p className="font-semibold text-bad-fg">{title}</p>
      {message && <p className="mx-auto mt-2 max-w-md text-sm text-bad-fg">{message}</p>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

const alertStyles: Record<Tone, string> = {
  neutral: "border-border bg-surface text-foreground",
  good: "border-good-line bg-good-soft text-good-fg",
  warn: "border-warn-line bg-warn-soft text-warn-fg",
  bad: "border-bad-line bg-bad-soft text-bad-fg",
  info: "border-info-line bg-info-soft text-info-fg",
};

/** Inline notice inside a page or form. For results of an action use a toast instead. */
export function Alert({ tone = "info", title, children, action, className }: { tone?: Tone; title?: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div role={tone === "bad" ? "alert" : "status"} className={cn("flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3 text-sm", alertStyles[tone], className)}>
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? "mt-0.5" : undefined}>{children}</div>}
      </div>
      {action && <div className="flex shrink-0 gap-2">{action}</div>}
    </div>
  );
}
