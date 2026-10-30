import { bounds } from "./layout";
import type { FlowDefinition } from "./types";

export type View = { x: number; y: number; k: number };
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;

export const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/** Zooms by `factor` keeping the screen point (cx, cy) fixed on the same canvas point. */
export function zoomAt(view: View, factor: number, cx: number, cy: number): View {
  const k = clampZoom(view.k * factor);
  const real = k / view.k;
  return { k, x: cx - (cx - view.x) * real, y: cy - (cy - view.y) * real };
}

export const screenToCanvas = (view: View, sx: number, sy: number) => ({ x: (sx - view.x) / view.k, y: (sy - view.y) / view.k });

export function fitView(flow: FlowDefinition, width: number, height: number, pad = 40): View {
  const b = bounds(flow);
  if (!b || width <= 0 || height <= 0) return { x: 0, y: 0, k: 1 };
  const k = clampZoom(Math.min((width - pad * 2) / b.w, (height - pad * 2) / b.h, 1));
  return { k, x: (width - b.w * k) / 2 - b.x * k, y: (height - b.h * k) / 2 - b.y * k };
}
