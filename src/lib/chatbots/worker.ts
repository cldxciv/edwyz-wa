import { prisma } from "@/lib/db";
import { describeError } from "@/lib/safe-error";
import { tenantMayRunBackground } from "@/lib/tenant-state";
import type { WorkerModule } from "@/worker/registry";
import { sendText } from "@/lib/inbox/service";
import { mayReceive, optedOutSince } from "@/lib/contacts/opt-out";
import { endSession, parseFlow, SESSION_TTL_MS, wakeSession, type SessionRow } from "./engine";
import { parseSettings, TIMEOUT_MAX_MINUTES } from "./flow";

const BATCH = 50;
const STUCK_ACTIVE_MS = 60 * 60 * 1000;
const BLOCKED_RETRY_MS = 15 * 60_000;
const BLOCKED_MAX_MS = 7 * 86_400_000;

type DueSession = SessionRow & { startedAt?: Date };

/**
 * The session's workspace is suspended, deleted or billing-locked, so nothing may be sent. The session is not dropped: its wake
 * time moves 15 minutes on (a compare-and-set on the old value, so a concurrent worker cannot both push and run it) and it is
 * picked up again once the workspace recovers. A session older than 7 days is ended as expired instead of waiting forever. The
 * push also takes it out of the front of the oldest-first batch, so blocked workspaces cannot starve healthy ones.
 */
async function deferBlockedSession(session: DueSession, now: Date): Promise<void> {
  if (session.startedAt && now.getTime() - session.startedAt.getTime() > BLOCKED_MAX_MS) return endSession(session, "expired");
  await prisma.chatbotSession.updateMany({
    where: { id: session.id, tenantId: session.tenantId, status: "active", wakeAt: session.wakeAt },
    data: { wakeAt: new Date(now.getTime() + BLOCKED_RETRY_MS) },
  });
}

/** Resumes sessions whose delay has passed. Returns how many were continued. */
export async function resumeDelayedSessions(now: Date = new Date()): Promise<number> {
  const due = (await prisma.chatbotSession.findMany({
    where: { status: "active", wakeAt: { lte: now } },
    orderBy: { wakeAt: "asc" },
    take: BATCH,
  })) as DueSession[];
  let resumed = 0;
  for (const session of due) {
    try {
      if (!(await tenantMayRunBackground(session.tenantId, now.getTime()))) {
        await deferBlockedSession(session, now);
        continue;
      }
      const chatbot = await prisma.chatbot.findFirst({ where: { id: session.chatbotId, tenantId: session.tenantId, status: "published" }, select: { publishedFlow: true } });
      const flow = chatbot ? parseFlow(chatbot.publishedFlow) : null;
      if (!flow) {
        await endSession(session, "expired");
        continue;
      }
      if (await wakeSession(session, flow)) resumed++;
    } catch (error) {
      console.error("[chatbot] wake failed:", describeError(error));
    }
  }
  return resumed;
}

/** Waiting sessions older than 24 hours expire; so do active sessions with no wake time that stopped moving (crashed runs). */
export async function expireStaleSessions(now: Date = new Date()): Promise<number> {
  const waiting = await prisma.chatbotSession.updateMany({
    where: { status: "waiting", updatedAt: { lt: new Date(now.getTime() - SESSION_TTL_MS) } },
    data: { status: "expired", endedAt: now, waitingNodeId: null },
  });
  const stuck = await prisma.chatbotSession.updateMany({
    where: { status: "active", wakeAt: null, updatedAt: { lt: new Date(now.getTime() - STUCK_ACTIVE_MS) } },
    data: { status: "expired", endedAt: now },
  });
  return waiting.count + stuck.count;
}

/** Bots read per page when looking for custom inactivity limits. */
const IDLE_BOTS = 100;
const IDLE_BATCH = 50;

/**
 * Tells the customer the chat with the bot has ended. Skipped when the window is closed: nothing is queued then. It is a reply in the
 * window, which an opt-out does not stop, unless they opted out during this session (lib/contacts/opt-out.ts optedOutSince).
 */
async function sendTimeoutMessage(session: { tenantId: string; conversationId: string; contactId: string; startedAt?: Date }, body: string, now: Date) {
  if (!(await tenantMayRunBackground(session.tenantId, now.getTime()))) return;
  const contact = await prisma.contact.findFirst({ where: { id: session.contactId, tenantId: session.tenantId }, select: { optedOutAt: true } });
  if (!contact || !mayReceive(contact, "service") || optedOutSince(contact, session.startedAt)) return;
  try {
    await sendText({ tenantId: session.tenantId, conversationId: session.conversationId, body, origin: "chatbot" });
  } catch (error) {
    console.error("[chatbot] inactivity message not sent:", describeError(error));
  }
}

type IdleBot = { id: string; tenantId: string; publishedFlow: unknown };

/** Every published bot with its own inactivity limit, a page at a time in id order, so none is skipped however many there are. */
async function* botsWithOwnTimeout(): AsyncGenerator<IdleBot> {
  let cursor: string | undefined;
  for (;;) {
    const page = (await prisma.chatbot.findMany({
      where: { status: "published", publishedFlow: { path: ["settings", "timeoutMinutes"], lt: TIMEOUT_MAX_MINUTES } },
      select: { id: true, tenantId: true, publishedFlow: true },
      orderBy: { id: "asc" },
      take: IDLE_BOTS,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })) as IdleBot[];
    yield* page;
    if (page.length < IDLE_BOTS) return;
    cursor = page[page.length - 1].id;
  }
}

/**
 * Bots with their own inactivity limit (shorter than the 24 hour default): waiting sessions that stayed silent that long end as
 * expired, and the bot's reminder message, when it has one, is sent once. Each session is claimed first so two workers never send twice.
 */
export async function expireIdleSessions(now: Date = new Date()): Promise<number> {
  let ended = 0;
  for await (const bot of botsWithOwnTimeout()) {
    try {
      const settings = parseSettings((bot.publishedFlow as { settings?: unknown } | null)?.settings);
      const idle = (await prisma.chatbotSession.findMany({
        where: { tenantId: bot.tenantId, chatbotId: bot.id, status: "waiting", updatedAt: { lt: new Date(now.getTime() - settings.timeoutMinutes * 60_000) } },
        take: IDLE_BATCH,
      })) as SessionRow[];
      for (const session of idle) {
        const claim = await prisma.chatbotSession.updateMany({
          where: { id: session.id, tenantId: session.tenantId, status: "waiting", updatedAt: session.updatedAt },
          data: { status: "expired", endedAt: now, waitingNodeId: null, wakeAt: null },
        });
        if (claim.count === 0) continue;
        ended++;
        if (settings.timeoutMessage) await sendTimeoutMessage(session, settings.timeoutMessage, now);
      }
    } catch (error) {
      console.error("[chatbot] idle expiry failed:", describeError(error));
    }
  }
  return ended;
}

export const worker: WorkerModule = {
  queues: {},
  periodic: [
    { name: "chatbots.resume-delayed", everyMs: 30_000, run: () => resumeDelayedSessions() },
    { name: "chatbots.expire-stale", everyMs: 5 * 60_000, run: () => expireStaleSessions() },
    { name: "chatbots.expire-idle", everyMs: 60_000, run: () => expireIdleSessions() },
  ],
};
