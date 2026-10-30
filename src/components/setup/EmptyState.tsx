import type { ReactNode } from "react";
import { cn } from "@/components/ui";
import { Illustration, type IllustrationName } from "./Illustrations";

export type EmptyStateProps = {
  title: string;
  /** One or two plain sentences: what this place is for and what to do next. */
  body?: string;
  /** The single next step, usually a Button or a link styled as one. */
  action?: ReactNode;
  secondary?: ReactNode;
  illustration?: IllustrationName | null;
  /** "error" announces itself to screen readers and uses a red illustration by default. */
  tone?: "neutral" | "error";
  compact?: boolean;
  className?: string;
};

/** A friendly "nothing here yet" or "something went wrong" panel that always points at a next step. */
export function EmptyState({ title, body, action, secondary, illustration, tone = "neutral", compact = false, className }: EmptyStateProps) {
  const art = illustration === undefined ? (tone === "error" ? "error" : "inbox") : illustration;
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={cn("rounded-2xl border border-dashed text-center", tone === "error" ? "border-red-200 bg-red-50/40" : "border-border", compact ? "p-6" : "p-8 sm:p-10", className)}
    >
      {art && <Illustration name={art} className={cn("mx-auto", compact ? "h-16 w-20" : "h-24 w-32")} />}
      <p className={cn("font-semibold", art && "mt-3")}>{title}</p>
      {body && <p className="mx-auto mt-2 max-w-md text-sm text-muted">{body}</p>}
      {(action || secondary) && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          {action}
          {secondary}
        </div>
      )}
    </div>
  );
}

/** Link styled like the primary or secondary Button, for use as an EmptyState action. */
export function actionLinkClass(primary = true) {
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-colors",
    primary ? "bg-accent text-white hover:bg-accent-strong" : "border border-border bg-background hover:bg-surface",
  );
}
