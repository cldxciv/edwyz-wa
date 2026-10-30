import type { ReactNode } from "react";
import type { StepId } from "@/lib/setup/checklist";

export type IllustrationName = StepId | "inbox" | "chart" | "error" | "offline" | "success" | "welcome-chat" | "welcome-send" | "welcome-auto";

const stroke = "stroke-accent fill-none";
const soft = "fill-accent/15 stroke-none";
const paper = "fill-background stroke-accent";
const line = "stroke-border fill-none";

const ART: Record<IllustrationName, ReactNode> = {
  connect: (
    <>
      <circle cx="60" cy="46" r="34" className={soft} />
      <rect x="42" y="10" width="36" height="70" rx="7" className={paper} strokeWidth="2" />
      <path d="M52 17h16" className={stroke} strokeWidth="2" strokeLinecap="round" />
      <path d="M49 30h22a3 3 0 013 3v10a3 3 0 01-3 3H60l-6 5v-5h-5a3 3 0 01-3-3V33a3 3 0 013-3z" className="fill-accent" />
      <path d="M85 20a14 14 0 010 20M92 14a22 22 0 010 32" className={stroke} strokeWidth="2" strokeLinecap="round" />
      <circle cx="84" cy="66" r="9" className="fill-accent" />
      <path d="M80 66l3 3 5-6" className="stroke-background fill-none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  template: (
    <>
      <circle cx="60" cy="46" r="34" className={soft} />
      <rect x="34" y="12" width="46" height="62" rx="5" className={paper} strokeWidth="2" />
      <path d="M42 26h30M42 36h30M42 46h18" className={line} strokeWidth="3" strokeLinecap="round" />
      <rect x="42" y="56" width="22" height="9" rx="4.5" className="fill-accent" />
      <circle cx="82" cy="62" r="13" className="fill-accent" />
      <path d="M76 62l4.5 4.5L89 57" className="stroke-background fill-none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  contacts: (
    <>
      <circle cx="60" cy="46" r="34" className={soft} />
      <circle cx="46" cy="34" r="9" className={paper} strokeWidth="2" />
      <path d="M28 66c0-10 8-17 18-17s18 7 18 17" className={`${paper}`} strokeWidth="2" strokeLinecap="round" />
      <circle cx="76" cy="38" r="7" className="fill-accent" />
      <path d="M62 66c0-8 6-14 14-14s14 6 14 14" className="fill-accent" />
      <path d="M92 18v12M86 24h12" className={stroke} strokeWidth="2.5" strokeLinecap="round" />
    </>
  ),
  broadcast: (
    <>
      <circle cx="60" cy="46" r="34" className={soft} />
      <path d="M22 44L90 18 70 72 54 54z" className={paper} strokeWidth="2" strokeLinejoin="round" />
      <path d="M54 54l36-36" className={stroke} strokeWidth="2" strokeLinecap="round" />
      <path d="M54 54v14l8-9" className="fill-accent" />
      <circle cx="26" cy="68" r="3" className="fill-accent" />
      <circle cx="36" cy="74" r="2" className="fill-accent" />
      <circle cx="96" cy="60" r="3" className="fill-accent" />
      <circle cx="102" cy="48" r="2" className="fill-accent" />
    </>
  ),
  invite: (
    <>
      <circle cx="60" cy="46" r="34" className={soft} />
      <circle cx="38" cy="38" r="8" className={paper} strokeWidth="2" />
      <path d="M22 66c0-9 7-15 16-15s16 6 16 15" className={paper} strokeWidth="2" strokeLinecap="round" />
      <circle cx="82" cy="38" r="8" className="fill-accent" />
      <path d="M66 66c0-9 7-15 16-15s16 6 16 15" className="fill-accent" />
      <rect x="46" y="14" width="28" height="19" rx="3" className={paper} strokeWidth="2" />
      <path d="M47 16l13 10 13-10" className={stroke} strokeWidth="2" strokeLinejoin="round" />
    </>
  ),
  routing: (
    <>
      <circle cx="60" cy="46" r="34" className={soft} />
      <rect x="14" y="34" width="26" height="22" rx="5" className={paper} strokeWidth="2" />
      <path d="M22 42h10M22 48h6" className={line} strokeWidth="2.5" strokeLinecap="round" />
      <path d="M40 45h14c8 0 8-17 18-17M54 45c8 0 8 17 18 17" className={stroke} strokeWidth="2" strokeLinecap="round" />
      <circle cx="82" cy="28" r="9" className="fill-accent" />
      <circle cx="82" cy="62" r="9" className="fill-accent" />
      <path d="M77 62l3.5 3.5L87 59" className="stroke-background fill-none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  automation: (
    <>
      <circle cx="60" cy="46" r="34" className={soft} />
      <path d="M60 14v8" className={stroke} strokeWidth="2" strokeLinecap="round" />
      <circle cx="60" cy="12" r="3" className="fill-accent" />
      <rect x="34" y="22" width="52" height="38" rx="10" className={paper} strokeWidth="2" />
      <circle cx="48" cy="40" r="5" className="fill-accent" />
      <circle cx="72" cy="40" r="5" className="fill-accent" />
      <path d="M52 52h16" className={stroke} strokeWidth="2" strokeLinecap="round" />
      <path d="M44 60v6M76 60v6" className={stroke} strokeWidth="2" strokeLinecap="round" />
      <path d="M92 18h14a3 3 0 013 3v8a3 3 0 01-3 3h-6l-5 4v-4h-3a3 3 0 01-3-3v-8a3 3 0 013-3z" className="fill-accent" />
    </>
  ),
  facebook: (
    <>
      <circle cx="60" cy="46" r="34" className={soft} />
      <rect x="22" y="16" width="76" height="56" rx="6" className={paper} strokeWidth="2" />
      <path d="M22 30h76" className={stroke} strokeWidth="2" />
      <circle cx="40" cy="46" r="8" className="fill-accent" />
      <path d="M54 42h34M54 50h22" className={line} strokeWidth="3" strokeLinecap="round" />
      <path d="M34 66v-5M44 66v-9M54 66v-13" className="stroke-accent" strokeWidth="4" strokeLinecap="round" />
      <path d="M88 8l6 6-6 6" className={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  plan: (
    <>
      <circle cx="60" cy="46" r="34" className={soft} />
      <rect x="24" y="24" width="72" height="46" rx="7" className={paper} strokeWidth="2" />
      <path d="M24 38h72" className="stroke-accent" strokeWidth="9" />
      <path d="M34 56h20M34 63h12" className={line} strokeWidth="3" strokeLinecap="round" />
      <circle cx="82" cy="58" r="8" className="fill-accent" />
      <path d="M79 58l2.5 2.5L86 56" className="stroke-background fill-none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  inbox: (
    <>
      <circle cx="60" cy="46" r="34" className={soft} />
      <path d="M26 50l10-24h48l10 24v18a4 4 0 01-4 4H30a4 4 0 01-4-4z" className={paper} strokeWidth="2" strokeLinejoin="round" />
      <path d="M26 50h24a10 10 0 0020 0h24" className={stroke} strokeWidth="2" strokeLinejoin="round" />
      <path d="M46 38h28M50 31h20" className={line} strokeWidth="3" strokeLinecap="round" />
    </>
  ),
  chart: (
    <>
      <circle cx="60" cy="46" r="34" className={soft} />
      <path d="M26 20v52h70" className={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="36" y="52" width="10" height="20" rx="2" className="fill-accent/40" />
      <rect x="54" y="40" width="10" height="32" rx="2" className="fill-accent/70" />
      <rect x="72" y="28" width="10" height="44" rx="2" className="fill-accent" />
    </>
  ),
  error: (
    <>
      <circle cx="60" cy="46" r="34" className="fill-red-100 stroke-none" />
      <path d="M60 18L94 74H26z" className="fill-background stroke-red-700" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M60 36v18" className="stroke-red-700" strokeWidth="3.5" strokeLinecap="round" />
      <circle cx="60" cy="63" r="2.5" className="fill-red-700" />
    </>
  ),
  offline: (
    <>
      <circle cx="60" cy="46" r="34" className={soft} />
      <path d="M36 66a14 14 0 010-28 20 20 0 0138-4 15 15 0 012 32z" className={paper} strokeWidth="2" strokeLinejoin="round" />
      <path d="M30 20l60 56" className="stroke-red-700" strokeWidth="3" strokeLinecap="round" />
    </>
  ),
  success: (
    <>
      <circle cx="60" cy="46" r="34" className={soft} />
      <circle cx="60" cy="46" r="22" className="fill-accent" />
      <path d="M49 46l8 8 15-17" className="stroke-background fill-none" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 22l4 4M100 24l-4 4M24 70l4-3M98 68l-4-3" className={stroke} strokeWidth="2.5" strokeLinecap="round" />
    </>
  ),
  "welcome-chat": (
    <>
      <circle cx="60" cy="46" r="34" className={soft} />
      <path d="M26 24h44a5 5 0 015 5v20a5 5 0 01-5 5H52l-10 9v-9h-16a5 5 0 01-5-5V29a5 5 0 015-5z" className={paper} strokeWidth="2" strokeLinejoin="round" />
      <path d="M32 35h30M32 43h18" className={line} strokeWidth="3" strokeLinecap="round" />
      <path d="M82 40h14a5 5 0 015 5v14a5 5 0 01-5 5h-4v8l-9-8h-6a5 5 0 01-5-5V45a5 5 0 015-5z" className="fill-accent" />
    </>
  ),
  "welcome-send": (
    <>
      <circle cx="60" cy="46" r="34" className={soft} />
      <path d="M24 46L96 16 76 74 56 56z" className={paper} strokeWidth="2" strokeLinejoin="round" />
      <path d="M56 56L96 16" className={stroke} strokeWidth="2" strokeLinecap="round" />
      <circle cx="28" cy="68" r="3" className="fill-accent" />
      <circle cx="100" cy="58" r="3" className="fill-accent" />
    </>
  ),
  "welcome-auto": (
    <>
      <circle cx="60" cy="46" r="34" className={soft} />
      <rect x="34" y="24" width="52" height="38" rx="10" className={paper} strokeWidth="2" />
      <circle cx="48" cy="42" r="5" className="fill-accent" />
      <circle cx="72" cy="42" r="5" className="fill-accent" />
      <path d="M52 54h16" className={stroke} strokeWidth="2" strokeLinecap="round" />
      <path d="M60 24v-8" className={stroke} strokeWidth="2" strokeLinecap="round" />
      <circle cx="60" cy="14" r="3" className="fill-accent" />
      <path d="M92 52l4 8 8 4-8 4-4 8-4-8-8-4 8-4z" className="fill-accent" />
    </>
  ),
};

/** Decorative drawings for empty states, setup steps and the welcome dialog. They carry no meaning, so they are hidden from screen readers. */
export function Illustration({ name, className = "h-24 w-32" }: { name: IllustrationName; className?: string }) {
  return (
    <svg viewBox="0 0 120 90" aria-hidden="true" focusable="false" className={className}>
      {ART[name]}
    </svg>
  );
}
