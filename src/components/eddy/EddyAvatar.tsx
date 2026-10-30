/**
 * Eddy's avatar (docs/EDDY-SPEC.md 2.5): a rounded speech bubble with two dot eyes and a small four-point spark at its top
 * right (the path of the app's `sparkles` icon), on a circle filled with var(--accent) and the glyph in var(--on-accent).
 * Sizes: 20 px in the launcher, 28 px in the transcript gutter, 56 px on the welcome and empty screens. Dark theme needs
 * nothing extra because the tokens flip. Off: a var(--muted) glyph on var(--surface).
 *
 * Working: three dots pulse at --dur-slow; with prefers-reduced-motion the dots stay still (motion-reduce), and the
 * caller shows the static "Working…" label.
 */
export type EddyAvatarState = "idle" | "working" | "needs_heads_up" | "needs_action" | "off";
export const EDDY_AVATAR_SIZES = { launcher: 20, gutter: 28, hero: 56 } as const;
export type EddyAvatarSize = keyof typeof EDDY_AVATAR_SIZES | number;

/** The spark of the existing sparkles icon (src/components/app/Icon.tsx), scaled into the top-right corner. */
const SPARK = "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z";
const BUBBLE = "M7 8.5h8.5a3 3 0 013 3v4a3 3 0 01-3 3h-5l-3.2 2.4a.5.5 0 01-.8-.4v-2.1A3 3 0 014 15.5v-4a3 3 0 013-3z";

export function EddyAvatar({ size = "gutter", state = "idle", label, className }: { size?: EddyAvatarSize; state?: EddyAvatarState; label?: string; className?: string }) {
  const px = typeof size === "number" ? size : EDDY_AVATAR_SIZES[size];
  const off = state === "off";
  const disc = off ? "var(--surface)" : "var(--accent)";
  const glyph = off ? "var(--muted)" : "var(--on-accent)";
  const dot = state === "needs_action" ? "var(--bad)" : state === "needs_heads_up" ? "var(--warn)" : null;
  return (
    <span
      className={["relative inline-flex shrink-0 items-center justify-center", className].filter(Boolean).join(" ")}
      style={{ width: px, height: px }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-eddy-avatar={state}
    >
      <svg viewBox="0 0 24 24" width={px} height={px} focusable="false" aria-hidden="true">
        <circle cx="12" cy="12" r="12" fill={disc} stroke={off ? "var(--border)" : "none"} strokeWidth={off ? 1 : 0} />
        <path d={BUBBLE} fill="none" stroke={glyph} strokeWidth="1.6" strokeLinejoin="round" />
        {state === "working" ? (
          <g fill={glyph}>
            <circle className="motion-safe:[animation:ui-pulse_calc(var(--dur-slow)*3)_ease-in-out_infinite]" cx="8.6" cy="13.5" r="1" style={{ animationDelay: "0ms" }} />
            <circle className="motion-safe:[animation:ui-pulse_calc(var(--dur-slow)*3)_ease-in-out_infinite]" cx="11.25" cy="13.5" r="1" style={{ animationDelay: "160ms" }} />
            <circle className="motion-safe:[animation:ui-pulse_calc(var(--dur-slow)*3)_ease-in-out_infinite]" cx="13.9" cy="13.5" r="1" style={{ animationDelay: "320ms" }} />
          </g>
        ) : (
          <g fill={glyph}>
            <circle cx="9.5" cy="13.5" r="1.1" />
            <circle cx="13" cy="13.5" r="1.1" />
          </g>
        )}
        <path d={SPARK} fill={glyph} transform="translate(13.2 1.6) scale(0.42)" />
      </svg>
      {dot && <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-(--background)" style={{ background: dot }} />}
    </span>
  );
}
