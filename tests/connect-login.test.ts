import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { START_MAX_AGE_MS, createLoginPreloader, loginOptions, type StartInfo } from "@/components/connect/login";

const info = (state: string): StartInfo => ({ configId: "cfg", appId: "app", state });
const sdk = () => ({ login: vi.fn() });

function setup() {
  let clock = 1_000_000;
  let n = 0;
  const fb = sdk();
  const fetchStart = vi.fn(async () => info(`state-${++n}`));
  const loadSdk = vi.fn(async (_appId: string) => fb);
  const pre = createLoginPreloader({ fetchStart, loadSdk, now: () => clock });
  return { pre, fb, fetchStart, loadSdk, advance: (ms: number) => void (clock += ms) };
}

describe("Embedded Signup login options", () => {
  it("uses the configuration, a code response and sessionInfoVersion 3", () => {
    expect(loginOptions("cfg")).toEqual({
      config_id: "cfg",
      response_type: "code",
      override_default_response_type: true,
      extras: { setup: {}, sessionInfoVersion: "3" },
    });
  });
});

describe("login preloader", () => {
  it("has the SDK and state ready before the click, so take() hands them over without awaiting anything", async () => {
    const { pre, fb, loadSdk } = setup();
    await pre.prepare();
    const ready = pre.take();
    expect(ready).not.toBeNull();
    expect(ready!.sdk).toBe(fb);
    expect(ready!.info.state).toBe("state-1");
    expect(loadSdk).toHaveBeenCalledWith("app");
  });

  it("returns a prepared state once: it is single use on the server, so the second take is empty", async () => {
    const { pre } = setup();
    await pre.prepare();
    expect(pre.take()).not.toBeNull();
    expect(pre.take()).toBeNull();
  });

  it("does not refetch while a fresh state is held, and shares one in-flight preparation", async () => {
    const { pre, fetchStart } = setup();
    await Promise.all([pre.prepare(), pre.prepare(), pre.prepare()]);
    await pre.prepare();
    expect(fetchStart).toHaveBeenCalledTimes(1);
  });

  it("drops a state older than 8 minutes (the server accepts 10) and prepares a new one on request", async () => {
    const { pre, advance, fetchStart } = setup();
    await pre.prepare();
    advance(START_MAX_AGE_MS - 1);
    await pre.prepare();
    expect(fetchStart).toHaveBeenCalledTimes(1);
    advance(2);
    expect(pre.take()).toBeNull();
    await pre.prepare();
    expect(fetchStart).toHaveBeenCalledTimes(2);
    expect(pre.take()!.info.state).toBe("state-2");
  });

  it("is empty before anything was prepared, so the caller uses the awaiting fallback", async () => {
    const { pre, fetchStart } = setup();
    expect(pre.take()).toBeNull();
    const loaded = await pre.load();
    expect(loaded.info.state).toBe("state-1");
    expect(fetchStart).toHaveBeenCalledTimes(1);
  });

  it("swallows a failed preload (offline, blocked script) and leaves the fallback to report it", async () => {
    const fetchStart = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(info("s"));
    const pre = createLoginPreloader({ fetchStart, loadSdk: async () => sdk() });
    await expect(pre.prepare()).resolves.toBeUndefined();
    expect(pre.take()).toBeNull();
    await pre.prepare();
    expect(pre.take()).not.toBeNull();
    const failing = createLoginPreloader({ fetchStart: async () => info("s"), loadSdk: async () => Promise.reject(new Error("sdk")) });
    await expect(failing.load()).rejects.toThrow("sdk");
  });
});

describe("ConnectWhatsApp click handler", () => {
  const source = readFileSync("src/components/connect/ConnectWhatsApp.tsx", "utf8");
  const handler = source.slice(source.indexOf("const connect = useCallback("), source.indexOf("async function reconnect()"));

  it("is not async and calls the prepared SDK before any await", () => {
    expect(handler.startsWith("const connect = useCallback(() => {")).toBe(true);
    const fast = handler.slice(handler.indexOf("const ready = preloader.take()"), handler.indexOf("Fallback"));
    expect(fast).toContain("launch(ready.sdk, ready.info)");
    expect(fast).not.toMatch(/\bawait\b/);
    expect(handler.slice(0, handler.indexOf("const ready = preloader.take()"))).not.toMatch(/\bawait\b/);
  });

  it("preloads on the page and no longer fetches the state inside the click", () => {
    expect(source).toContain("void preloader.prepare()");
    expect(source).toContain("loginOptions(configId)");
    expect(handler).not.toContain('api<{ configId: string; appId: string; state: string }>("/api/onboarding/start")');
  });
});
