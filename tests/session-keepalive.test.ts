import { describe, expect, it, vi } from "vitest";
import { FRESH_MS, createRenewer, type RenewDeps } from "@/components/app/SessionKeepAlive";

/** A lock like navigator.locks: one holder at a time, in request order. */
function fakeLock() {
  let tail: Promise<void> = Promise.resolve();
  return (fn: () => Promise<void>) => {
    const run = tail.then(fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** Two tabs share the lock and the stored "last renewed" time, as two tabs of one browser do. */
function browser(status = 200) {
  let stamp = 0;
  let clock = 1_000_000;
  const refresh = vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 5));
    return status;
  });
  const withLock = fakeLock();
  const tab = (onSignedOut = vi.fn()) => {
    const deps: RenewDeps = { refresh, withLock, lastRenewed: () => stamp, markRenewed: (at) => (stamp = at), onSignedOut, now: () => clock };
    return { renew: createRenewer(deps), onSignedOut };
  };
  return { refresh, tab, advance: (ms: number) => (clock += ms), stamp: () => stamp };
}

describe("SessionKeepAlive renewals", () => {
  it("a timer and a focus event firing together in one tab renew once", async () => {
    const b = browser();
    const { renew } = b.tab();
    await Promise.all([renew(), renew(), renew()]);
    expect(b.refresh).toHaveBeenCalledTimes(1);
    expect(b.stamp()).toBeGreaterThan(0);
  });

  it("two tabs waking together renew once: the second finds the first one's renewal fresh", async () => {
    const b = browser();
    const one = b.tab();
    const two = b.tab();
    await Promise.all([one.renew(), two.renew()]);
    expect(b.refresh).toHaveBeenCalledTimes(1);
  });

  it("renews again once the last renewal is no longer fresh", async () => {
    const b = browser();
    const { renew } = b.tab();
    await renew();
    b.advance(FRESH_MS - 1);
    await renew();
    expect(b.refresh).toHaveBeenCalledTimes(1);
    b.advance(2);
    await renew();
    expect(b.refresh).toHaveBeenCalledTimes(2);
  });

  it("sends the tab to sign-in only when the renewal is refused, and does not mark a refusal as fresh", async () => {
    const b = browser(401);
    const { renew, onSignedOut } = b.tab();
    await renew();
    expect(onSignedOut).toHaveBeenCalledOnce();
    expect(b.stamp()).toBe(0);
  });

  it("an offline attempt is retried on the next call", async () => {
    let stamp = 0;
    const refresh = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(200);
    const renew = createRenewer({ refresh, withLock: (fn) => fn(), lastRenewed: () => stamp, markRenewed: (at) => (stamp = at), onSignedOut: vi.fn() });
    await renew();
    expect(stamp).toBe(0);
    await renew();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(stamp).toBeGreaterThan(0);
  });
});
