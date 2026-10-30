import type { ReactNode } from "react";
import { cn } from "@/components/ui";

/** A grey placeholder block. Decorative: wrap a group of them in SkeletonGroup to announce loading once. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-lg bg-surface motion-reduce:animate-none", className)} />;
}

export function SkeletonGroup({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}
