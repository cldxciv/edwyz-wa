/*
 * Pure logic behind the Connect WhatsApp button, kept out of the component so it can be tested without a browser.
 *
 * Browsers only open a popup (FB.login) when it is called synchronously from the click that asked for it; after an awaited fetch or a
 * script download the click's user activation can be gone (Safari, Firefox with strict settings, slow networks), and the window is
 * silently blocked. So the SDK and the signup state are loaded ahead of the click, and the click handler takes them from the
 * preloader and calls FB.login without awaiting anything first.
 */

export type StartInfo = { configId: string; appId: string; state: string };
export type LoginSdk<Response = unknown> = {
  login: (callback: (response: Response) => void, options: Record<string, unknown>) => void;
};

/** The state is valid for 10 minutes on the server; a prepared one older than this is thrown away and fetched again. */
export const START_MAX_AGE_MS = 8 * 60_000;

/** Session info version of Embedded Signup, as in Meta's current snippet: the WA_EMBEDDED_SIGNUP events then carry the waba and phone ids. */
export const SESSION_INFO_VERSION = "3";

/** Options for FB.login (Embedded Signup v4 with a configuration). */
export function loginOptions(configId: string): Record<string, unknown> {
  return {
    config_id: configId,
    response_type: "code",
    override_default_response_type: true,
    extras: { setup: {}, sessionInfoVersion: SESSION_INFO_VERSION },
  };
}

type Ready<Sdk> = { info: StartInfo; sdk: Sdk; at: number };

export type LoginPreloader<Sdk extends LoginSdk> = {
  /** Fetches the state and loads the SDK ahead of the click. Safe to call repeatedly; failures are swallowed and leave the async fallback. */
  prepare: () => Promise<void>;
  /**
   * Returns the prepared SDK and state when both are there and fresh, and forgets them (a state is single use). Null otherwise; the
   * caller then falls back to the awaiting path.
   */
  take: () => Ready<Sdk> | null;
  /** The awaiting path for when nothing was prepared: fetch, load, return. */
  load: () => Promise<{ info: StartInfo; sdk: Sdk }>;
};

export function createLoginPreloader<Sdk extends LoginSdk>(deps: {
  fetchStart: () => Promise<StartInfo>;
  loadSdk: (appId: string) => Promise<Sdk>;
  now?: () => number;
}): LoginPreloader<Sdk> {
  const now = deps.now ?? Date.now;
  let ready: Ready<Sdk> | null = null;
  let inflight: Promise<void> | null = null;

  const fresh = () => ready !== null && now() - ready.at < START_MAX_AGE_MS;

  async function build(): Promise<Ready<Sdk>> {
    const at = now();
    const info = await deps.fetchStart();
    const sdk = await deps.loadSdk(info.appId);
    return { info, sdk, at };
  }

  return {
    prepare() {
      if (fresh()) return Promise.resolve();
      if (inflight) return inflight;
      inflight = build()
        .then((r) => void (ready = r))
        .catch(() => void (ready = null))
        .finally(() => void (inflight = null));
      return inflight;
    },
    take() {
      if (!ready || !fresh()) {
        ready = null;
        return null;
      }
      const out = ready;
      ready = null;
      return out;
    },
    async load() {
      const { info, sdk } = await build();
      return { info, sdk };
    },
  };
}
