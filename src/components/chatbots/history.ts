export type History<T> = { past: T[]; present: T; future: T[]; lastKey: string | null };

export const MAX_HISTORY = 100;

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], lastKey: null };
}

/** Records a new state. Consecutive commits with the same `key` (typing, dragging) collapse into one undo step. */
export function commit<T>(h: History<T>, next: T, key: string | null = null): History<T> {
  if (Object.is(next, h.present)) return h;
  if (key !== null && key === h.lastKey) return { ...h, present: next, future: [] };
  return { past: [...h.past, h.present].slice(-MAX_HISTORY), present: next, future: [], lastKey: key };
}

export function undo<T>(h: History<T>): History<T> {
  if (!h.past.length) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], lastKey: null };
}

export function redo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), lastKey: null };
}

export const canUndo = <T,>(h: History<T>) => h.past.length > 0;
export const canRedo = <T,>(h: History<T>) => h.future.length > 0;
export const endBatch = <T,>(h: History<T>): History<T> => (h.lastKey === null ? h : { ...h, lastKey: null });
