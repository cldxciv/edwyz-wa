/** Roving focus for tabs. Skips disabled tabs and wraps. Returns null for keys that do not navigate. */
export function nextTabIndex(count: number, current: number, key: string, disabled: readonly boolean[] = [], vertical = false): number | null {
  const indexes = Array.from({ length: count }, (_, i) => i).filter((i) => !disabled[i]);
  if (indexes.length === 0) return null;
  if (key === "Home") return indexes[0];
  if (key === "End") return indexes[indexes.length - 1];
  const step = key === (vertical ? "ArrowDown" : "ArrowRight") ? 1 : key === (vertical ? "ArrowUp" : "ArrowLeft") ? -1 : 0;
  if (!step) return null;
  let i = current;
  for (let n = 0; n < count; n++) {
    i = (i + step + count) % count;
    if (!disabled[i]) return i;
  }
  return null;
}

/**
 * Index to focus when Tab is pressed inside a trapped region of `count` focusable elements.
 * Returns -1 when nothing is focusable (keep focus on the container) and null when the browser default is correct.
 */
export function trapTarget(count: number, activeIndex: number, shift: boolean): number | null {
  if (count === 0) return -1;
  if (shift && activeIndex <= 0) return count - 1;
  if (!shift && activeIndex === count - 1) return 0;
  return null;
}

export function clampPercent(value: number, max = 100): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.max(0, (value / max) * 100));
}

export type MeterTone = "good" | "warn" | "bad" | "info";

/** Capacity meters turn amber then red as they fill. Thresholds are percentages. */
export function meterTone(percent: number, warnAt = 70, dangerAt = 90): MeterTone {
  return percent >= dangerAt ? "bad" : percent >= warnAt ? "warn" : "good";
}
