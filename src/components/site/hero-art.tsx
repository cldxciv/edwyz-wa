/** Decorative picture of the shared inbox. Sample names and text only; it makes no claim about real customers. */
export function HeroArt() {
  const rows = [
    { name: "Asha", initial: "A", y: 64, active: true },
    { name: "Ravi", initial: "R", y: 124, active: false },
    { name: "Meera", initial: "M", y: 184, active: false },
  ];
  return (
    <svg viewBox="0 0 440 380" className="h-auto w-full" aria-hidden="true" focusable="false">
      <rect x="2" y="2" width="436" height="376" rx="24" className="fill-surface stroke-border" strokeWidth="2" />

      <text x="28" y="42" fontSize="15" fontWeight="700" className="fill-foreground">Inbox</text>
      <rect x="318" y="24" width="96" height="24" rx="12" className="fill-accent" opacity="0.16" />
      <text x="366" y="40" textAnchor="middle" fontSize="11" fontWeight="600" className="fill-foreground">3 waiting</text>

      {rows.map((r) => (
        <g key={r.name}>
          <rect x="20" y={r.y} width="128" height="52" rx="12" className={r.active ? "fill-background stroke-accent" : "fill-background stroke-border"} strokeWidth="2" />
          <circle cx="42" cy={r.y + 26} r="12" className="fill-accent" opacity="0.2" />
          <text x="42" y={r.y + 30} textAnchor="middle" fontSize="11" fontWeight="700" className="fill-foreground">{r.initial}</text>
          <text x="62" y={r.y + 22} fontSize="12" fontWeight="700" className="fill-foreground">{r.name}</text>
          <rect x="62" y={r.y + 30} width="64" height="8" rx="4" className="fill-muted" opacity="0.35" />
          {r.active && <circle cx="134" cy={r.y + 18} r="4" className="fill-accent" />}
        </g>
      ))}

      <rect x="20" y="244" width="128" height="108" rx="14" className="fill-background stroke-border" strokeWidth="2" />
      <text x="32" y="268" fontSize="11" fontWeight="700" className="fill-foreground">Team</text>
      <circle cx="38" cy="290" r="6" className="fill-accent" opacity="0.5" />
      <text x="50" y="294" fontSize="10.5" className="fill-muted">Priya, 4 open</text>
      <circle cx="38" cy="314" r="6" className="fill-accent" opacity="0.5" />
      <text x="50" y="318" fontSize="10.5" className="fill-muted">Arun, 3 open</text>
      <circle cx="38" cy="338" r="6" className="fill-muted" opacity="0.4" />
      <text x="50" y="342" fontSize="10.5" className="fill-muted">Away</text>

      <rect x="160" y="64" width="260" height="288" rx="16" className="fill-background stroke-border" strokeWidth="2" />
      <text x="176" y="89" fontSize="13" fontWeight="700" className="fill-foreground">Asha</text>
      <rect x="296" y="74" width="112" height="22" rx="11" className="fill-accent" opacity="0.15" />
      <text x="352" y="89" textAnchor="middle" fontSize="10.5" fontWeight="600" className="fill-foreground">Assigned to you</text>
      <path d="M160 104h260" className="stroke-border" strokeWidth="2" />

      <rect x="176" y="116" width="168" height="34" rx="12" className="fill-surface stroke-border" strokeWidth="1.5" />
      <text x="188" y="137" fontSize="12" className="fill-foreground">Do you deliver to Pune?</text>

      <rect x="216" y="160" width="192" height="50" rx="12" className="fill-accent" />
      <text x="228" y="181" fontSize="12" fill="#fff">Yes, within 2 days.</text>
      <text x="228" y="199" fontSize="12" fill="#fff">Want our price list?</text>

      <rect x="176" y="222" width="232" height="30" rx="10" className="fill-warn-soft stroke-warn-line" strokeWidth="1.5" />
      <text x="188" y="241" fontSize="11" className="fill-warn-fg">Private note: offer free delivery</text>

      <rect x="176" y="262" width="176" height="24" rx="12" className="fill-accent" opacity="0.12" />
      <text x="188" y="278" fontSize="10.5" className="fill-foreground">Chatbot handed this to you</text>

      <rect x="176" y="300" width="232" height="38" rx="19" className="fill-surface stroke-border" strokeWidth="1.5" />
      <text x="194" y="323" fontSize="11.5" className="fill-muted">Type / for quick replies</text>
      <circle cx="388" cy="319" r="13" className="fill-accent" />
      <path d="m383 319h10m-4-4 4 4-4 4" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
