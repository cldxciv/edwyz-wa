/**
 * Switches of Studio (branded images) and Canva (docs/specs/ADS-MCP-CANVA-CREATIVE-SPEC.md 5.8; MCC-00). Read on every call, so
 * a test or an env change takes effect without a restart. src/lib/env-rules.mjs refuses an unknown value at startup; here an
 * unknown value falls back to the safe default:
 *   STUDIO_ENABLED=off (every Studio surface hidden, /api/studio/** and the logo route answer 404),
 *   Canva on only with Studio on AND both CANVA_CLIENT_ID and CANVA_CLIENT_SECRET set, CANVA_VIDEO=off,
 *   STUDIO_DAILY_RENDERS=100, and the default image provider stays "placeholder" while Studio is off.
 *
 * Pure: no database, no network, no secret returned.
 */
import { STUDIO_NUMBERS } from "@/lib/env-rules.mjs";

type Env = Record<string, string | undefined>;

const read = (env: Env, key: string): string => (env[key] ?? "").trim().toLowerCase();
const isSet = (env: Env, key: string): boolean => (env[key] ?? "").trim() !== "";

/** A whole number inside its STUDIO_NUMBERS range, or the default for anything else. */
export function boundedNumber(env: Env, key: keyof typeof STUDIO_NUMBERS): number {
  const [min, max, fallback] = STUDIO_NUMBERS[key];
  const raw = (env[key] ?? "").trim();
  if (!/^\d{1,10}$/.test(raw)) return fallback;
  const n = Number(raw);
  return n >= min && n <= max ? n : fallback;
}

/** The Studio master switch (default off). Off hides every Studio surface and Canva with it. */
export function studioEnabled(env: Env = process.env): boolean {
  return read(env, "STUDIO_ENABLED") === "on";
}

/** The Canva app's credentials are both set. Says nothing about whether Canva is on: see canvaEnabled(). */
export function canvaConfigured(env: Env = process.env): boolean {
  return isSet(env, "CANVA_CLIENT_ID") && isSet(env, "CANVA_CLIENT_SECRET");
}

/** Canva is on only when Studio is on and Canva is configured. */
export function canvaEnabled(env: Env = process.env): boolean {
  return studioEnabled(env) && canvaConfigured(env);
}

/** MP4 imports from Canva (default off: keep off until the VPS disk is below 80%, D13). Needs Canva on. */
export function canvaVideo(env: Env = process.env): boolean {
  return canvaEnabled(env) && read(env, "CANVA_VIDEO") === "on";
}

/** Saved Studio images a workspace may make per day (10 to 5000, default 100). */
export function studioDailyRenders(env: Env = process.env): number {
  return boundedNumber(env, "STUDIO_DAILY_RENDERS");
}

/**
 * The image provider used when CREATIVE_IMAGE_PROVIDER is unset: "brand" (the Studio renderer, a real JPEG Meta accepts) once
 * Studio is on, and "placeholder" (as before) while it is off, so turning nothing on changes nothing.
 */
export function defaultImageProvider(env: Env = process.env): "brand" | "placeholder" {
  return studioEnabled(env) ? "brand" : "placeholder";
}
