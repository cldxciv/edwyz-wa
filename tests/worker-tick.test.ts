import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runPass: vi.fn(), alive: vi.fn(), exec: vi.fn(async () => 1) }));
vi.mock("@/lib/db", () => ({ prisma: { $executeRaw: mocks.exec } }));
vi.mock("@/worker/loop", () => ({ runPass: mocks.runPass }));
vi.mock("@/worker/daemon", () => ({ daemonIsAlive: mocks.alive }));

import { POST } from "@/app/api/internal/tick/route";

const call = () => POST(new Request("https://wa.edwyz.com/api/internal/tick", { method: "POST", headers: { "x-worker-secret": "s3" } }));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WORKER_SECRET = "s3";
  mocks.runPass.mockResolvedValue({ webhook: 1, send: 0, broadcast: 0, swept: 0, queues: {}, periodic: [] });
});

describe("cron tick next to the worker daemon", () => {
  it("runs a full pass when the daemon is not running (the documented fallback)", async () => {
    mocks.alive.mockResolvedValue(false);
    const res = await call();
    expect(res.status).toBe(200);
    expect(mocks.runPass).toHaveBeenCalledOnce();
  });

  it("stands down while the daemon is alive, so jobs of one contact are never processed by two processes at once", async () => {
    mocks.alive.mockResolvedValue(true);
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "worker daemon is running" });
    expect(mocks.runPass).not.toHaveBeenCalled();
  });
});
