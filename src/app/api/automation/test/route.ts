import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { pickRule, type RuleLike } from "@/lib/automation/engine";
import { listRules } from "@/lib/automation/rules";
import { describeAction } from "@/lib/automation/v2/describe";
import { MESSAGE_TYPES } from "@/lib/automation/v2/model";
import { simulate, type RuleRow } from "@/lib/automation/v2/run";
import { readJsonLimited } from "@/lib/http/body";
import { errorResponse, HttpError } from "@/lib/tenancy";

const strings = (value: unknown, max: number) => (Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && x.length <= 60).slice(0, max) : []);

/**
 * POST { text, firstMessage?, messageType?, tags?, attributes?, at? } -> { rule, matches }
 * Dry run, nothing is sent and cooldowns are ignored. `rule` is the classic rule that would answer (or null);
 * `matches` lists the v2 rules whose conditions fit, in running order, each with what it would do.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const body = await readJsonLimited(request, 8 * 1024);
    if (typeof body.text !== "string" || body.text.length > 1000) throw new HttpError(400, "text must be a string up to 1000 characters.");
    const at = typeof body.at === "string" ? new Date(body.at) : new Date();
    if (Number.isNaN(at.getTime())) throw new HttpError(400, "at is not a valid date.");
    const messageType = typeof body.messageType === "string" && (MESSAGE_TYPES as readonly string[]).includes(body.messageType) ? body.messageType : "text";
    const firstMessage = body.firstMessage === true;
    const attributes = body.attributes && typeof body.attributes === "object" && !Array.isArray(body.attributes) ? (body.attributes as Record<string, unknown>) : {};

    const rules = (await listRules(actor.tenantId)).filter((r) => r.enabled);
    const classic = rules.filter((r) => r.version !== 2);
    const rule = await pickRule(classic as unknown as (RuleLike & { name: string })[], "", { text: body.text, receivedAt: at, silentMinutes: firstMessage ? null : 0 }, async () => false);
    const matches = simulate(rules.filter((r) => r.version === 2) as unknown as RuleRow[], {
      text: body.text,
      messageType,
      newChat: firstMessage,
      silentMinutes: firstMessage ? null : 0,
      at,
      phone: typeof body.phone === "string" ? body.phone : "",
      tags: strings(body.tags, 20),
      attributes,
    });
    return Response.json({
      rule: rule ? { id: rule.id, name: rule.name, type: rule.type, replyText: rule.replyText } : null,
      matches: matches.map((m) => ({ id: m.id, name: m.name, does: m.summary.actions.map((a) => describeAction(a)) })),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
