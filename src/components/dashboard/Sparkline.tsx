import { sparkGeometry } from "./helpers";

const W = 120;
const H = 36;

/** Tiny trend line. The label is read aloud in place of the drawing; the exact numbers are in the table under the tiles. */
export function Sparkline({ values, label }: { values: (number | null)[]; label: string }) {
  const g = sparkGeometry(values, W, H);
  if (g.points.length === 0) return <div className="h-9" aria-hidden />;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="h-9 w-full overflow-visible">
      {g.area && <path d={g.area} className="fill-accent/10 stroke-none" />}
      <path d={g.line} className="fill-none stroke-accent" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {g.last && <circle cx={g.last.x} cy={g.last.y} r="3" className="fill-accent" />}
    </svg>
  );
}
