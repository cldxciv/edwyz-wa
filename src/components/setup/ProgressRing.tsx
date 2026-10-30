import { cn } from "@/components/ui";
import { ringDash } from "./ring";

/** Circular progress with the percentage in the middle. Announced as a progress bar for screen readers. */
export function ProgressRing({ percent, label, size = 72, className }: { percent: number; label: string; size?: number; className?: string }) {
  const radius = 26;
  const { circumference, offset, percent: shown } = ringDash(percent, radius);
  return (
    <div className={cn("relative shrink-0", className)} style={{ width: size, height: size }}>
      <svg viewBox="0 0 64 64" width={size} height={size} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={shown} className="-rotate-90">
        <circle cx="32" cy="32" r={radius} fill="none" strokeWidth="6" className="stroke-border" />
        <circle
          cx="32"
          cy="32"
          r={radius}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          className="stroke-accent transition-[stroke-dashoffset] duration-700 motion-reduce:transition-none"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <span aria-hidden className="absolute inset-0 flex items-center justify-center text-sm font-semibold">
        {shown}%
      </span>
    </div>
  );
}
