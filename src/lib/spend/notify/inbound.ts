/**
 * Owner replies to spending notices on WhatsApp (docs/SPEND-CONTROLS-SPEC.md 7.4 items 3-5). webhooks/processor.ts routes
 * them here only for the platform's notifier workspace:
 *
 * - `spopt:<channelId>:<hmac16>` ("Yes, send me alerts") verifies that channel; `spopt:<channelId>:<hmac16>:no` ("No")
 *   turns that one channel off.
 * - `spdec:<approvalId>:<hmac16>` ("Decline") declines a pending request through Phase 0's decide path, via 'whatsapp', and
 *   answers in the window the tap opened: "Declined. Nothing was changed." Only when the sender's wa_id is a verified,
 *   opted-in channel of the owner or an approver of that workspace, and the HMAC (bound to that wa_id) matches.
 * - Approve is NEVER accepted from a quick reply: approving raises spend, so it needs a signed-in approver (7.4).
 * - STOP opts out every channel with that phone; START re-enables only the channel it came from (handleOwnerKeyword).
 * Anything else, a wrong phone or a wrong HMAC, is ignored silently. Never throws.
 */
import { prisma } from "@/lib/db";
import { describeError } from "@/lib/safe-error";
import type { SpendDb } from "../control";
import { declineChannel, optOutPhone, ownerOrApprover, startFromPhone, verifyChannel, verifyReplyPayload } from "./owner-channel";
import { phoneDigits, readNotifierConfig, sendNotifierReply } from "./platform-sender";
import { REPLY_DECLINED, REPLY_NO, REPLY_VERIFIED } from "./templates";

type Env = Record<string, string | undefined>;

export type OwnerReply = {
  /** The notifier workspace the reply arrived in. */
  tenantId: string;
  /** The sender's WhatsApp id (digits). */
  waId: string;
  /** button.payload of the quick reply, for example "spdec:<approvalId>:<hmac16>". */
  payload: string;
  messageId?: string;
};

export type OwnerReplyResult = { handled: boolean; action: "none" | "declined" | "opted_in" | "opted_out" | "ignored"; reason?: string };

export type InboundOptions = { db?: SpendDb; env?: Env; now?: Date; reply?: typeof sendNotifierReply };

const ignored = (reason: string): OwnerReplyResult => ({ handled: false, action: "ignored", reason });

/** Handles an owner's quick reply in the notifier workspace. Never throws. */
export async function handleOwnerReply(input: OwnerReply, opts: InboundOptions = {}): Promise<OwnerReplyResult> {
  const db = (opts.db ?? prisma) as unknown as SpendDb;
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const reply = opts.reply ?? sendNotifierReply;
  try {
    const config = await readNotifierConfig(db);
    if (!config || config.tenantId !== input.tenantId) return ignored("not_notifier");
    const waId = phoneDigits(input.waId);
    const parsed = verifyReplyPayload(input.payload, waId, env);
    if (!parsed) return ignored("bad_payload");

    if (parsed.kind === "spopt") {
      const channel = await verifyChannel(parsed.id, waId, { db, now });
      if (!channel) return ignored("no_channel");
      await reply(waId, REPLY_VERIFIED, channel.tenantId, { db, config });
      return { handled: true, action: "opted_in" };
    }
    if (parsed.kind === "spno") {
      const channel = await declineChannel(parsed.id, waId, { db, now });
      if (!channel) return ignored("no_channel");
      await reply(waId, REPLY_NO, channel.tenantId, { db, config });
      return { handled: true, action: "opted_out" };
    }

    // spdec: the approval names its workspace; the sender must be a verified approver channel there.
    const approval = (await db.spendApproval.findFirst({ where: { id: parsed.id }, select: { id: true, tenantId: true } })) as { id: string; tenantId: string } | null;
    if (!approval) return ignored("no_request");
    const channel = (await db.ownerNotifyChannel.findFirst({ where: { tenantId: approval.tenantId, phoneE164: `+${waId}`, optOutAt: null, verifiedAt: { not: null } } })) as { userId: string } | null;
    if (!channel) return ignored("not_an_approver_phone");
    const who = await ownerOrApprover(approval.tenantId, channel.userId, db);
    if (!who.allowed) return ignored("not_an_approver");
    // Loaded when used: approvals.ts imports this notifier.
    const { decideApproval } = await import("../approvals");
    let text = REPLY_DECLINED;
    let action: OwnerReplyResult["action"] = "declined";
    try {
      const result = await decideApproval(approval.tenantId, approval.id, "decline", "whatsapp", { type: "whatsapp", userId: channel.userId }, { db, now, env });
      text = result.status === "declined" ? REPLY_DECLINED : result.text;
    } catch (error) {
      // Already decided, expired or replaced: say what happened, in the same window.
      text = error instanceof Error && error.message ? error.message : REPLY_DECLINED;
      action = "ignored";
    }
    await reply(waId, text, approval.tenantId, { db, config });
    return action === "declined" ? { handled: true, action } : { handled: true, action: "ignored", reason: "closed" };
  } catch (error) {
    console.error(`[spend] owner reply not handled: ${describeError(error)}`);
    return ignored("failed");
  }
}

export type OwnerKeyword = { tenantId: string; waId: string; keyword: "stop" | "start" };

/**
 * STOP and START from an owner in the notifier workspace (7.4 item 5). The processor has already applied the contact's own
 * opt-out or opt-in; this keeps the channels in step. Never throws.
 */
export async function handleOwnerKeyword(input: OwnerKeyword, opts: InboundOptions = {}): Promise<{ changed: number }> {
  const db = (opts.db ?? prisma) as unknown as SpendDb;
  try {
    const config = await readNotifierConfig(db);
    if (!config || config.tenantId !== input.tenantId || !phoneDigits(input.waId)) return { changed: 0 };
    if (input.keyword === "stop") return { changed: await optOutPhone(input.waId, { db, now: opts.now }) };
    return { changed: (await startFromPhone(config.tenantId, input.waId, { db, now: opts.now })) ? 1 : 0 };
  } catch (error) {
    console.error(`[spend] owner keyword not handled: ${describeError(error)}`);
    return { changed: 0 };
  }
}
