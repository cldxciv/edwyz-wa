/**
 * Playwright global setup (docs/IG-PAGE-ADS-SPEC.md 9.3, 9.4; PRM-16): starts the fake Meta Graph server (e2e/fake-meta-server.ts,
 * PRM-03) on 127.0.0.1 before any spec runs, and stops it after the last one.
 *
 * Who sets the app's environment: the runner. With E2E_BASE_URL unset, playwright.config.ts starts the app under test itself
 * (its `webServer`) with the settings appServerEnv() gives: NODE_ENV=test (or development with E2E_APP_MODE=dev),
 * GRAPH_BASE_URL pointing here, SPEND_DRY_RUN=1, PROMOTE_ENABLED=on, PROMOTE_AUDIENCES=all and EDDY_FAKE_MODEL=scripted. It
 * records exactly what it passed in E2E_APP_ENV, which this setup and e2e/promote-helpers.ts read. Reading GRAPH_BASE_URL or
 * SPEND_DRY_RUN from the runner's own shell or .env would say nothing about the app: `next start` alone runs with
 * NODE_ENV=production, where the app ignores both (src/lib/env-rules.mjs testGraphBaseUrl, src/lib/spend/flags.ts spendDryRun).
 *
 * With E2E_BASE_URL set, the app was started by someone else and its settings cannot be known here: the fake still starts (on
 * GRAPH_BASE_URL's port from the shell or .env, else FAKE_META_PORT, else 4010), and the promote specs refuse to run.
 *
 * When the port is already taken by a fake Meta server (another runner on this machine, or one started by hand), that server
 * is reused and left running. Anything else on the port stops the run with the reason.
 */
import { isLoopbackGraphBaseUrl } from "../src/lib/env-rules.mjs";
import { DEFAULT_FAKE_META_PORT, startFakeMetaServer } from "./fake-meta-server";

type Env = Record<string, string | undefined>;

/** Where playwright.config.ts records the environment it started the app with (JSON). */
export const APP_ENV_KEY = "E2E_APP_ENV";
/** The port the app Playwright starts listens on (e2e/helpers.ts BASE defaults to it). */
export const APP_PORT = 3500;

/** Loads the app's .env the way e2e/helpers.ts does (values already in the environment win). A missing file is fine. */
function loadAppEnv(): void {
  try {
    process.loadEnvFile?.(".env");
  } catch {
    // No .env here: the environment alone decides.
  }
}

const defaultPort = (protocol: string) => (protocol === "https:" ? 443 : 80);

/**
 * The port the fake must listen on: GRAPH_BASE_URL's when set (it must be loopback), else FAKE_META_PORT, else 4010.
 * Throws when GRAPH_BASE_URL is set but is not a loopback address.
 */
export function fakeMetaPort(env: Env = process.env): number {
  const graph = (env.GRAPH_BASE_URL ?? "").trim();
  if (graph) {
    if (!isLoopbackGraphBaseUrl(graph)) {
      throw new Error("GRAPH_BASE_URL must be an http address on 127.0.0.1, localhost or [::1] (the fake Meta server). Remove it or fix it before running the end-to-end suite.");
    }
    const url = new URL(graph);
    return url.port ? Number(url.port) : defaultPort(url.protocol);
  }
  const fromEnv = Number((env.FAKE_META_PORT ?? "").trim());
  return Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65_536 ? fromEnv : DEFAULT_FAKE_META_PORT;
}

export type AppServerMode = "start" | "dev";

/** start (the default): `next start` of your build, with NODE_ENV=test. dev: `next dev`. Anything else stops the run. */
export function appServerMode(env: Env = process.env): AppServerMode {
  const value = (env.E2E_APP_MODE ?? "").trim().toLowerCase();
  if (value === "" || value === "start") return "start";
  if (value === "dev") return "dev";
  throw new Error("E2E_APP_MODE must be start (next start of your build, the default) or dev (next dev).");
}

/**
 * What Playwright starts the app with (playwright.config.ts webServer.env), on top of the runner's own environment; the app's
 * .env fills only what is still unset. Never NODE_ENV=production: there the app ignores GRAPH_BASE_URL and SPEND_DRY_RUN.
 */
export function appServerEnv(env: Env, origin: string): Record<string, string> {
  return {
    NODE_ENV: appServerMode(env) === "dev" ? "development" : "test",
    SITE_URL: origin,
    GRAPH_BASE_URL: `http://127.0.0.1:${fakeMetaPort(env)}`,
    SPEND_DRY_RUN: "1",
    PROMOTE_ENABLED: "on",
    PROMOTE_AUDIENCES: "all",
    EDDY_FAKE_MODEL: "scripted",
  };
}

/** The command Playwright starts the app with. */
export function appServerCommand(env: Env = process.env, port: number = APP_PORT): string {
  return appServerMode(env) === "dev" ? `npx next dev -p ${port}` : `npx next start -p ${port}`;
}

/** The environment the runner started the app with (E2E_APP_ENV), or null when the app was started elsewhere. */
export function recordedAppEnv(env: Env = process.env): Record<string, string> | null {
  const raw = (env[APP_ENV_KEY] ?? "").trim();
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return null;
  }
}

/** True when a fake Meta server already answers its health check on this port. */
async function fakeAlreadyRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__fake/health`, { signal: AbortSignal.timeout(2_000) });
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return res.ok && body?.ok === true;
  } catch {
    return false;
  }
}

/** The fake's port: the one the runner gave the app, else (an app started elsewhere) the shell's or .env's. */
export function setupPort(env: Env = process.env): number {
  const recorded = recordedAppEnv(env);
  if (recorded) return fakeMetaPort({ GRAPH_BASE_URL: recorded.GRAPH_BASE_URL });
  return fakeMetaPort(env);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!recordedAppEnv(process.env)) loadAppEnv();
  const port = setupPort(process.env);
  try {
    const server = await startFakeMetaServer({ port });
    process.env.FAKE_META_URL = server.url;
    return () => server.close();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "EADDRINUSE" && (await fakeAlreadyRunning(port))) {
      process.env.FAKE_META_URL = `http://127.0.0.1:${port}`;
      return async () => undefined;
    }
    if (code === "EADDRINUSE") {
      throw new Error(`Port ${port} is in use by something that is not the fake Meta server. Free it, or set FAKE_META_PORT to another port.`);
    }
    throw error;
  }
}
