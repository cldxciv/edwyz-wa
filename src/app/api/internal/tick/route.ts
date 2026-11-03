import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { safeEqual } from "@/lib/meta";
import { errorResponse } from "@/lib/tenancy";
import { daemonIsAlive } from "@/worker/daemon";
import { runPass } from "@/worker/loop";

export const dynamic = "force-dynamic";

/**
 * Runs one worker pass over every queue and scheduled task. This is the documented fallback to the worker daemon (src/worker/index.ts, pm2 app
 * edwyz-wa-worker): keep the every-minute cron calling it so work still moves if the daemon is down. While the daemon's own heartbeat
 * (worker:daemon) is fresh the tick stands down and only answers {skipped}, so the two never process jobs side by side.
 *   curl -fsS -X POST -H "x-worker-secret: $WORKER_SECRET" https://wa.edwyz.com/api/internal/tick
 */
export async function POST(request: Request) {
  const secret = process.env.WORKER_SECRET;
  const given = request.headers.get("x-worker-secret");
  if (!secret || !given || !safeEqual(given, secret)) {
    return Response.json({ error: "Forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  try {
    if (await daemonIsAlive()) return Response.json({ skipped: "worker daemon is running" }, { headers: { "Cache-Control": "no-store" } });
    const result = await runPass();
    await prisma
      .$executeRaw`INSERT INTO "PlatformSetting" (key, value, "updatedAt") VALUES ('worker:heartbeat', '{}'::jsonb, now()) ON CONFLICT (key) DO UPDATE SET "updatedAt" = now()`
      .catch((error: unknown) => log.error("worker.heartbeat_failed", { err: error, route: "internal.tick" }));
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e, request);
  }
}
