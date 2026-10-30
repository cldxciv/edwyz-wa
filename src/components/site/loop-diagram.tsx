const NODES = [
  { title: "Ad", lines: ["People see your ad on", "Facebook or Instagram"] },
  { title: "Lead", lines: ["They fill a form or tap", "the WhatsApp button"] },
  { title: "Follow-up", lines: ["A first message goes out", "and your team takes over"] },
  { title: "Sale", lines: ["Mark it won and tell", "Meta which ad worked"] },
] as const;

const DESCRIPTION =
  "Four connected steps. One: people see your ad on Facebook or Instagram. Two: they fill in a form or tap the WhatsApp button and become a lead. Three: a first WhatsApp message goes out and your team takes over. Four: you mark the sale as won and tell Meta which ad worked. That result then helps your next ads.";

type Box = { x: number; y: number; w: number; h: number };

function Node({ box, index, title, lines }: { box: Box; index: number; title: string; lines: readonly string[] }) {
  return (
    <g>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={16} className="fill-surface stroke-border" strokeWidth={1.5} />
      <circle cx={box.x + 28} cy={box.y + 30} r={14} className="fill-accent" />
      <text x={box.x + 28} y={box.y + 35} textAnchor="middle" fontSize={15} fontWeight={700} fill="#fff">
        {index + 1}
      </text>
      <text x={box.x + 52} y={box.y + 36} fontSize={20} fontWeight={700} className="fill-foreground">
        {title}
      </text>
      {lines.map((line, i) => (
        <text key={line} x={box.x + 18} y={box.y + 68 + i * 20} fontSize={14.5} className="fill-muted">
          {line}
        </text>
      ))}
    </g>
  );
}

function Arrow({ id, d }: { id: string; d: string }) {
  return <path d={d} fill="none" strokeWidth={2} className="pub-flow stroke-muted" markerEnd={`url(#${id})`} />;
}

function Marker({ id }: { id: string }) {
  return (
    <marker id={id} viewBox="0 0 10 10" refX={8} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
      <path d="M0 0 10 5 0 10z" className="fill-muted" />
    </marker>
  );
}

function Horizontal() {
  const boxes: Box[] = NODES.map((_, i) => ({ x: i * 256, y: 12, w: 192, h: 112 }));
  return (
    <svg viewBox="0 0 960 232" role="img" aria-labelledby="loop-h-title loop-h-desc" className="hidden h-auto w-full md:block">
      <title id="loop-h-title">The loop: ad, lead, WhatsApp follow-up, sale</title>
      <desc id="loop-h-desc">{DESCRIPTION}</desc>
      <defs>
        <Marker id="loop-h-arrow" />
      </defs>
      {boxes.map((box, i) => (
        <Node key={NODES[i].title} box={box} index={i} title={NODES[i].title} lines={NODES[i].lines} />
      ))}
      {boxes.slice(0, -1).map((b, i) => (
        <Arrow key={i} id="loop-h-arrow" d={`M${b.x + b.w + 6} ${b.y + b.h / 2} H${boxes[i + 1].x - 8}`} />
      ))}
      <Arrow id="loop-h-arrow" d="M864 136 C864 218 96 218 96 140" />
      <text x={480} y={206} textAnchor="middle" fontSize={15} className="fill-muted">
        What sold teaches your next ad
      </text>
    </svg>
  );
}

function Vertical() {
  const boxes: Box[] = NODES.map((_, i) => ({ x: 10, y: 8 + i * 140, w: 260, h: 112 }));
  return (
    <svg viewBox="0 0 280 600" role="img" aria-labelledby="loop-v-title loop-v-desc" className="mx-auto h-auto w-full max-w-xs md:hidden">
      <title id="loop-v-title">The loop: ad, lead, WhatsApp follow-up, sale</title>
      <desc id="loop-v-desc">{DESCRIPTION}</desc>
      <defs>
        <Marker id="loop-v-arrow" />
      </defs>
      {boxes.map((box, i) => (
        <Node key={NODES[i].title} box={box} index={i} title={NODES[i].title} lines={NODES[i].lines} />
      ))}
      {boxes.slice(0, -1).map((b, i) => (
        <Arrow key={i} id="loop-v-arrow" d={`M140 ${b.y + b.h + 4} V${boxes[i + 1].y - 6}`} />
      ))}
      <text x={140} y={582} textAnchor="middle" fontSize={15} className="fill-muted">
        What sold teaches your next ad
      </text>
    </svg>
  );
}

export function LoopDiagram() {
  return (
    <figure className="mt-10">
      <Horizontal />
      <Vertical />
    </figure>
  );
}
