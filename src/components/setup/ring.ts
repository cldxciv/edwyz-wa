/** Stroke values for a progress ring. Percent is clamped to 0-100 so bad input can never draw a broken circle. */
export function ringDash(percent: number, radius: number) {
  const safe = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  const circumference = 2 * Math.PI * radius;
  return { circumference, offset: circumference * (1 - safe / 100), percent: Math.round(safe) };
}
