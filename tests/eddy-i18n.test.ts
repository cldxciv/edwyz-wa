import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// The catalogue never touches a database; invoke.ts is imported only for its ACTION_COPY codes.
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { ACTION_COPY } from "@/lib/actions/invoke";
import type { Warning } from "@/lib/actions/types";
import { EDDY_AVAILABILITY_ORDER, EDDY_DEFAULTS, EDDY_LANGS, type CardState } from "@/lib/eddy/contract";
import {
  CORE,
  GOTO_KEYS,
  SPEND_CODES,
  STARTER_CHIP_KEYS,
  defineCatalogue,
  hasKey,
  htmlLang,
  interpolate,
  makeTranslator,
  placeholders,
  registerCatalogue,
  spendMessage,
  starterChips,
  starterPageOf,
  t,
  templateParts,
  translateKey,
  type Catalogue,
  type SpendVars,
} from "@/lib/eddy/i18n";
import { BANNED_COPY_WORDS, SPEND_COPY_CODES, formatCopyDate, formatCopyTime, spendCopy, type SpendCopyParams } from "@/lib/spend/copy";
import { formatMinor } from "@/lib/spend/money";

/**
 * docs/EDDY-SPEC.md 2.2, 2.4, 6.10, 6.12 (catalogue rules), 12.1a decisions 0 and 6, EDDY-12. Every file under
 * src/lib/eddy/copy/ is scanned: the core en/hi/hinglish files and any area catalogue a later package adds there
 * (`export const catalogue = defineCatalogue({en, hi, hinglish})`).
 */

const COPY_DIR = path.resolve(__dirname, "../src/lib/eddy/copy");
const CORE_FILES = ["en.ts", "hi.ts", "hinglish.ts"];

type Loaded = { name: string; cat: Catalogue<string> };

async function loadCatalogues(): Promise<Loaded[]> {
  const out: Loaded[] = [{ name: "core (en.ts, hi.ts, hinglish.ts)", cat: CORE as Catalogue<string> }];
  for (const file of readdirSync(COPY_DIR).filter((f) => /\.tsx?$/.test(f)).sort()) {
    const mod = (await import(path.join(COPY_DIR, file).replace(/\\/g, "/"))) as Record<string, unknown>;
    if (CORE_FILES.includes(file)) continue;
    const cat = mod.catalogue as Catalogue<string> | undefined;
    if (!cat || typeof cat !== "object" || !cat.en || !cat.hi || !cat.hinglish) throw new Error(`${file} must export \`catalogue\` built with defineCatalogue({en, hi, hinglish}).`);
    out.push({ name: file, cat });
  }
  return out;
}

const catalogues = await loadCatalogues();
const entries = (cat: Catalogue<string>, lang: "en" | "hi" | "hinglish") => Object.entries(cat[lang]) as [string, string][];

/** Latin words a Hindi string may contain (6.12): product names, Eddy, WhatsApp, Meta, Edwyz, Anthropic, Low/Medium, AI. */
const HI_LATIN_ALLOW = new Set(["Eddy", "WhatsApp", "Meta", "Edwyz", "Anthropic", "Facebook", "AI", "Low", "Medium"]);
/** Phrases kept in English as the app shows them (the Spending page's menu path). */
const HI_LATIN_PHRASES = ["Settings > Spending limits"];

function latinWordsOutsideAllowlist(text: string): string[] {
  let s = text.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, " ");
  for (const phrase of HI_LATIN_PHRASES) s = s.split(phrase).join(" ");
  return (s.match(/[A-Za-z]+/g) ?? []).filter((w) => !HI_LATIN_ALLOW.has(w));
}

/** 2.4: Eddy's first person never marks a gender. */
const HI_GENDERED = [/(रहा|रही|सकता|सकती|गया|गई)\s*हू[ँं]/u, /[ूऊ][ँं]?(गा|गी)(?![\p{M}\p{L}])/u];
const HINGLISH_GENDERED = [/\b(raha|rahi|sakta|sakti|gaya|gayi)\s+hoon\b/i, /\b[a-z]+(unga|ungi)\b/i];

describe("catalogue shape (6.12)", () => {
  it("finds the core catalogue and every area file under src/lib/eddy/copy", () => {
    expect(readdirSync(COPY_DIR)).toEqual(expect.arrayContaining(CORE_FILES));
    expect(catalogues.length).toBeGreaterThanOrEqual(1);
  });

  it.each(catalogues.map((c) => [c.name, c.cat] as const))("%s: every key exists in all three languages", (_name, cat) => {
    const en = Object.keys(cat.en).sort();
    expect(Object.keys(cat.hi).sort()).toEqual(en);
    expect(Object.keys(cat.hinglish).sort()).toEqual(en);
    for (const lang of EDDY_LANGS) for (const [key, value] of entries(cat, lang)) expect(value.trim().length, `${lang} ${key}`).toBeGreaterThan(0);
  });

  it.each(catalogues.map((c) => [c.name, c.cat] as const))("%s: every key has identical {placeholders} in all three languages", (_name, cat) => {
    for (const [key, value] of entries(cat, "en")) {
      expect(placeholders(cat.hi[key]), `hi ${key}`).toEqual(placeholders(value));
      expect(placeholders(cat.hinglish[key]), `hinglish ${key}`).toEqual(placeholders(value));
    }
  });

  it("no key is defined twice across catalogues", () => {
    const seen = new Map<string, string>();
    for (const { name, cat } of catalogues) {
      for (const key of Object.keys(cat.en)) {
        expect(seen.get(key), `${key} in ${name}`).toBeUndefined();
        seen.set(key, name);
      }
    }
  });
});

describe("language rules (2.2, 2.4, 6.12)", () => {
  it.each(catalogues.map((c) => [c.name, c.cat] as const))("%s: Hindi uses Latin letters only from the allowlist", (_name, cat) => {
    const offenders = entries(cat, "hi").flatMap(([key, value]) => latinWordsOutsideAllowlist(value).map((w) => `${key}: ${w}`));
    expect(offenders).toEqual([]);
  });

  it("the allowlist check itself catches English words and allows placeholders and the menu path", () => {
    expect(latinWordsOutsideAllowlist("आपका template अप्रूव हुआ")).toEqual(["template"]);
    expect(latinWordsOutsideAllowlist("{name} को Settings > Spending limits में WhatsApp और Meta")).toEqual([]);
  });

  it.each(catalogues.map((c) => [c.name, c.cat] as const))("%s: Hinglish has no Devanagari", (_name, cat) => {
    const offenders = entries(cat, "hinglish").filter(([, v]) => /\p{Script=Devanagari}/u.test(v)).map(([k]) => k);
    expect(offenders).toEqual([]);
  });

  it.each(catalogues.map((c) => [c.name, c.cat] as const))("%s: no gendered first-person form in Hindi or Hinglish (2.4)", (_name, cat) => {
    const hi = entries(cat, "hi").filter(([, v]) => HI_GENDERED.some((re) => re.test(v))).map(([k, v]) => `${k}: ${v}`);
    const hinglish = entries(cat, "hinglish").filter(([, v]) => HINGLISH_GENDERED.some((re) => re.test(v))).map(([k, v]) => `${k}: ${v}`);
    expect(hi).toEqual([]);
    expect(hinglish).toEqual([]);
  });

  it("the gender patterns catch the banned forms and allow the allowed ones", () => {
    for (const bad of ["मैं देख रहा हूँ", "मैं भेज सकती हूँ", "मैं कर दूँगी", "मैं करूँगा"]) expect(HI_GENDERED.some((re) => re.test(bad)), bad).toBe(true);
    for (const ok of ["मैंने टैग लगा दिया है", "क्या मैं कॉपी बना दूँ?", "भेजा जा रहा है", "Eddy चालू है", "यह Meta को जाएगा", "मैं Eddy हूँ"]) expect(HI_GENDERED.some((re) => re.test(ok)), ok).toBe(false);
    for (const bad of ["main dekh raha hoon", "main bhej sakti hoon", "main karunga", "main de dungi"]) expect(HINGLISH_GENDERED.some((re) => re.test(bad)), bad).toBe(true);
    for (const ok of ["maine tag laga diya hai", "list dikhaun?", "check chal raha hai", "Main Eddy hoon", "Yeh Meta ko jayega"]) expect(HINGLISH_GENDERED.some((re) => re.test(ok)), ok).toBe(false);
  });

  it("the name is always Eddy in Latin script, never एडी (2.2)", () => {
    for (const { cat } of catalogues) {
      for (const lang of EDDY_LANGS) for (const [key, v] of entries(cat, lang)) expect(v.includes("एडी"), `${lang} ${key}`).toBe(false);
    }
    expect(t("en", "launcher")).toBe("Ask Eddy");
    expect(t("hi", "launcher")).toBe("Eddy से पूछें");
    expect(t("hinglish", "launcher")).toBe("Eddy se poochhiye");
    for (const lang of EDDY_LANGS) expect(t(lang, "name")).toBe("Eddy");
  });

  // Thousands of expectations (every banned word x every key x 3 languages): 1.5 s alone, nearly 4 s under the full suite's
  // parallel load, so it gets a realistic budget instead of vitest's 5 s default. The checks are unchanged.
  it("no copy contains Phase 0's banned words, a Meta link, an emoji or an exclamation mark (2.3, 6.15, 4.13)", { timeout: 30_000 }, () => {
    for (const { cat } of catalogues) {
      for (const lang of EDDY_LANGS) {
        for (const [key, v] of entries(cat, lang)) {
          const lower = v.toLowerCase();
          for (const word of BANNED_COPY_WORDS) expect(lower.includes(word), `${lang} ${key} contains "${word}"`).toBe(false);
          expect(/facebook\.com|business\.facebook|meta\.com|fb\.me|https?:\/\//i.test(v), `${lang} ${key} has a link`).toBe(false);
          expect(/\p{Extended_Pictographic}/u.test(v), `${lang} ${key} has an emoji`).toBe(false);
          expect(v.includes("!"), `${lang} ${key} has "!"`).toBe(false);
        }
      }
    }
  });

  it("htmlLang gives hi, hi-Latn and en (6.3)", () => {
    expect(htmlLang("hi")).toBe("hi");
    expect(htmlLang("hinglish")).toBe("hi-Latn");
    expect(htmlLang("en")).toBe("en");
  });
});

describe("the 6.12 key copy, word for word", () => {
  const SPEC_EN: Record<string, string> = {
    launcher: "Ask Eddy",
    "composer.placeholder": "Ask Eddy anything about Edwyz",
    working: "Working…",
    "btn.stop": "Stop",
    "btn.new_chat": "New chat",
    "btn.edit": "Edit",
    "btn.cancel": "Cancel",
    "btn.undo": "Undo",
    "off.platform": "Eddy is not switched on yet. The Edwyz team is still setting it up. Everything else in the app works, and your setup list is below.",
    "off.workspace.agent": "Eddy isn't switched on for this workspace. Ask the owner: {names}.",
    "enable.title": "Switch on Eddy for {workspace}?",
    "verify.readonly": "You can ask Eddy questions now. To let Eddy change things, verify your email first.",
    "locked.admin": "Your plan has ended, so Eddy is off for now.",
    "allowance.used": "This month's AI limit is used up. It resets on {date}. Previews already on screen and your setup list still work.",
    "allowance.needs": "This needs about {need} AI credits; {left} are left this month.",
    busy: "Your last message is still being answered.",
    service_down: "Can't reach the AI service right now. Try again in a minute. Nothing was changed.",
    refusal: "I can't help with that one. Ask me about your chats, contacts, templates, broadcasts or setup.",
    "card.send_text.title": "Send this reply to {name}?",
    "card.send_text.confirm": "Send reply",
    "card.broadcast.title": "Send `{template}` to {count} contacts",
    "cost.free_window": "No WhatsApp charge (inside the 24-hour window)",
    "cost.estimate": "About {amount}",
    "cost.unknown": "Not available yet",
    "warn.irreversible": "This can't be undone.",
    "warn.external_meta": "This goes to Meta.",
    "card.done.send": "Sent to {name}.",
    "card.cancelled": "Cancelled. Nothing was sent.",
    "card.expired": "This preview expired.",
    "btn.refresh_preview": "Refresh preview",
    "card.unknown": "It isn't certain whether this went through. It's being checked, and it won't be tried again automatically.",
    "card.awaiting_approval": "Waiting for {approver}'s approval. It expires at {time}; if nobody answers, it is declined.",
    "done.tag": "Done. I tagged {name} as {tag}.",
    "undo.done": "Undone.",
    "undo.conflict": "Someone changed it since, so it was not undone.",
    "fail.131047": "Your message to {name} didn't go: the 24-hour chat window had closed, so WhatsApp only allows an approved template now.",
    "btn.pick_template": "Pick a template",
    "notice.quality_low": "Your number {phone} dropped to Low quality. To protect it, a safety stop paused {count} marketing broadcasts: {names}.",
    "notice.template_approved": "Meta approved your template `{name}`. Want to send it?",
    "notice.approvals": "{count} requests are waiting for you.",
    "off.platform_paused": "Eddy is paused by the Edwyz team for now. Everything else in the app works, and your setup list is below.",
    "notice.first_use": "Before you start: what you type to Eddy, and the workspace data it looks up for you, is sent to Anthropic to write the replies. Your chats with Eddy are kept for {days} days, and you can delete them at any time from the menu.",
    "demo.refused": "This is a demo workspace, so nothing is sent to Meta or to customers.",
    "not_connected.admin": "WhatsApp isn't connected to this workspace yet.",
    "btn.connect_whatsapp": "Connect WhatsApp",
    "not_connected.agent": "WhatsApp isn't connected yet. Ask an admin to connect it: {names}.",
    "lang.unsupported": "Replies are in English, Hindi or Hinglish, so this one is in English.",
    "warn.triggers_automation": "This starts an automation that messages the customer.",
    "refuse.triggers_paid_rule": "This would start an automation that sends a paid template, and Eddy doesn't start paid messages yet. You can do it yourself on the contact's page.",
    "card.needs_approver": "Only {names} can confirm spending that Eddy prepares. You can start it yourself on its page, or ask them.",
    "ai.identity": "I'm Eddy, the AI helper in Edwyz.",
    "value.not_available": "Not available yet",
    "card.too_fast": "Check the preview first",
    "cost.worst_case": "Could add up to {amount} this month (worst case)",
  };

  it("English matches the spec rows", () => {
    for (const [key, value] of Object.entries(SPEC_EN)) expect(CORE.en[key as keyof typeof CORE.en], key).toBe(value);
  });

  it("the disclosure says 90 days when the workspace keeps chats 90 days", () => {
    expect(t("en", "enable.body", { days: 90 })).toBe(
      "To answer your team, Eddy reads the workspace data each person is already allowed to see. What people type to Eddy, and that data, is sent to Anthropic to write the replies. Chats with Eddy are kept for 90 days. Eddy always asks before it messages customers, spends money or deletes anything.",
    );
  });

  it("Hindi and Hinglish match the spec rows", () => {
    const rows: [string, string, string][] = [
      ["composer.placeholder", "Edwyz के बारे में Eddy से कुछ भी पूछें", "Edwyz ke baare mein Eddy se kuch bhi poochhiye"],
      ["working", "काम चल रहा है…", "Kaam chal raha hai…"],
      ["btn.undo", "वापस लें", "Undo kariye"],
      ["off.platform", "Eddy अभी चालू नहीं है। Edwyz टीम इसे सेट कर रही है। ऐप की बाकी सब चीज़ें चल रही हैं, और आपकी सेटअप लिस्ट नीचे है।", "Eddy abhi chalu nahi hai. Edwyz team ise set kar rahi hai. App ki baaki sab cheezein chal rahi hain, aur aapki setup list neeche hai."],
      ["refusal", "इसमें मदद नहीं हो पाएगी। चैट, कॉन्टैक्ट, टेम्पलेट, ब्रॉडकास्ट या सेटअप से जुड़ा कुछ भी पूछें।", "Isme madad nahi ho payegi. Chats, contacts, templates, broadcasts ya setup se juda kuch bhi poochhiye."],
      ["cost.free_window", "कोई WhatsApp चार्ज नहीं (24 घंटे की विंडो के अंदर)", "Koi WhatsApp charge nahi (24-hour window ke andar)"],
      ["cost.unknown", "अभी पता नहीं", "Abhi pata nahi"],
      ["card.unknown", "पक्का पता नहीं चल पाया कि यह हुआ या नहीं। जाँच चल रही है, और अपने आप दोबारा कोशिश नहीं की जाएगी।", "Pakka pata nahi chal paaya ki yeh hua ya nahi. Check chal raha hai, aur apne aap dobara try nahi hoga."],
      ["done.tag", "हो गया। मैंने {name} पर {tag} टैग लगा दिया है।", "Ho gaya. Maine {name} par {tag} tag laga diya hai."],
      ["undo.conflict", "इसके बाद किसी ने इसे बदल दिया, इसलिए इसे वापस नहीं लिया गया।", "Iske baad kisi ne ise badal diya, isliye ise undo nahi kiya gaya."],
      ["demo.refused", "यह डेमो वर्कस्पेस है, इसलिए Meta या ग्राहकों को कुछ नहीं भेजा जाता।", "Yeh demo workspace hai, isliye Meta ya customers ko kuch nahi bheja jaata."],
      ["ai.identity", "मैं Eddy हूँ, Edwyz का AI हेल्पर।", "Main Eddy hoon, Edwyz ka AI helper."],
      ["customer.label", "ग्राहक का मैसेज", "Customer ka message"],
      ["start.inbox.summarize", "इस चैट का सार बताइए", "Is chat ka summary dijiye"],
      ["start.broadcasts.cost", "इसका खर्च कितना होगा?", "Kitna kharcha aayega?"],
      ["start.dashboard.attention", "आज क्या देखना है?", "Aaj kya dekhna hai?"],
    ];
    for (const [key, hi, hinglish] of rows) {
      expect(CORE.hi[key as keyof typeof CORE.hi], `hi ${key}`).toBe(hi);
      expect(CORE.hinglish[key as keyof typeof CORE.hinglish], `hinglish ${key}`).toBe(hinglish);
    }
  });
});

describe("coverage of the v1 tools, cards, warnings and states (4.6, 6.4, 6.5, 6.11)", () => {
  const LOOKUPS = ["get_workspace_status", "get_attention", "list_conversations", "get_conversation", "search_contacts", "get_contact", "list_templates", "get_template", "list_broadcasts", "get_broadcast", "estimate_broadcast", "list_segments", "get_report_summary", "list_leads", "get_lead", "list_team", "get_activity", "list_automations", "test_automation_rule", "list_notices", "list_approvals", "get_spending", "explain_error", "search_help", "preview_audience"];
  const INTENTS = ["open_page", "draft_reply", "connect_whatsapp", "connect_facebook"];
  const UNDOABLE = ["tag_contacts", "tag_conversations", "assign_conversation", "set_conversation_status", "update_contact", "set_contact_owner_stage", "create_contact", "move_conversation_to_team", "stop_bot_on_conversation", "create_quick_reply", "set_my_availability", "undo_last_action", "create_template_draft", "create_broadcast_draft", "create_segment", "pause_broadcast", "disable_automation"];
  const CARDS = ["send_text_reply", "record_opt_out", "add_internal_note", "revoke_approval_link", "block_conversation", "submit_template", "delete_template", "delete_contact", "record_opt_in", "cancel_broadcast", "delete_segment", "enable_automation", "invite_teammate", "stop_spending", "decline_spend_request"];

  it("every v1 tool has an activity label in all three languages", () => {
    for (const tool of [...LOOKUPS, ...INTENTS, ...UNDOABLE, ...CARDS]) expect(hasKey(`status.${tool}`), tool).toBe(true);
  });

  it("every intent and undoable tool has a done row; every card tool has a title, a verb, a running and a done line", () => {
    for (const tool of [...INTENTS, ...UNDOABLE]) expect(hasKey(`done.${tool}`), tool).toBe(true);
    for (const tool of CARDS) for (const part of ["title", "confirm", "running", "done"]) expect(hasKey(`card.${tool}.${part}`), `${tool}.${part}`).toBe(true);
  });

  it("every warning, card state, Eddy state and fact label the cards use has copy", () => {
    const warnings: Warning[] = ["irreversible", "external_meta", "arms_automation", "differs_from_open_chat", "contains_link_or_number", "large_audience", "partial_coverage", "outside_hours", "no_marketing_opt_in", "window_closes_soon", "needs_approval", "lead_conversion", "changes_access", "triggers_automation"];
    for (const w of warnings) expect(hasKey(`warn.${w}`), w).toBe(true);
    const states: (CardState | "undone" | "refused")[] = ["pending", "running", "done", "failed", "changed", "expired", "cancelled", "unknown", "needs_approver", "awaiting_approval", "spend_frozen", "spend_not_set_up", "spend_refused", "demo", "not_connected", "reconnect", "undone", "refused"];
    for (const s of states) expect(hasKey(`card.state.${s}`), s).toBe(true);
    for (const s of [...EDDY_AVAILABILITY_ORDER, "working"]) expect(hasKey(`eddy.state.${s}`), s).toBe(true);
    for (const f of ["to", "message", "template", "category", "status", "language", "when", "from"]) expect(hasKey(`fact.${f}`), f).toBe(true);
  });

  it("every refusal code of the action layer has a sentence, except the ones a card renders from its own state", () => {
    const ownState = new Set(["expired", "changed", "outcome_unknown", "undo_expired", "undo_changed", "demo", "reconnect", "not_connected", "not_connected_agent", "needs_approver", "spend_frozen"]);
    for (const code of Object.keys(ACTION_COPY)) if (!ownState.has(code)) expect(hasKey(`refuse.${code}`), code).toBe(true);
    for (const code of ["signed_out", "workspace_locked", "forbidden", "not_found", "too_large", "rate_limited", "invalid", "internal"]) expect(hasKey(`refuse.${code}`), code).toBe(true);
  });

  it("the off states and the decision-6 Turn on Eddy card say what Eddy does, what it costs, and who can switch it on", () => {
    for (const key of ["off.platform", "off.platform_paused", "off.workspace.agent", "locked.admin", "locked.agent", "allowance.used", "allowance.used_today", "user_capped", "turnon.title", "turnon.what", "turnon.cost", "turnon.consent", "turnon.ask_owner", "btn.turn_on"]) expect(hasKey(key), key).toBe(true);
    const cost = t("en", "turnon.cost", { perTurn: EDDY_DEFAULTS.maxCreditsPerTurn, perDay: EDDY_DEFAULTS.maxCreditsPerUserDay });
    expect(cost).toContain("AI credits");
    expect(cost).toContain("30 credits");
    expect(cost).toContain("40 credits");
    expect(t("en", "turnon.ask_owner", { names: "Omar" })).toBe("Only the owner can turn on Eddy. Ask the owner: Omar.");
    expect(t("hi", "turnon.ask_owner", { names: "Omar" })).toContain("Omar");
    expect(t("hinglish", "off.workspace.agent", { names: "Omar" })).toBe("Is workspace ke liye Eddy chalu nahi hai. Workspace ke owner se kahiye: Omar.");
  });

  it("starter chips (6.10) exist for every page in every language, and the Go to buttons point at /app pages", () => {
    for (const keys of Object.values(STARTER_CHIP_KEYS)) for (const key of keys) expect(hasKey(key), key).toBe(true);
    for (const g of Object.values(GOTO_KEYS)) {
      expect(hasKey(g.key)).toBe(true);
      expect(g.path.startsWith("/app")).toBe(true);
    }
    expect(starterPageOf("inbox.chat")).toBe("inbox.chat");
    expect(starterPageOf("broadcasts.detail")).toBe("broadcasts");
    expect(starterPageOf("settings.spending")).toBe("settings.spending");
    expect(starterPageOf(undefined)).toBe("dashboard");
    expect(starterChips("hi", "broadcasts.list")[0]).toEqual({ key: "start.broadcasts.cost", label: "इसका खर्च कितना होगा?", query: "इसका खर्च कितना होगा?" });
    expect(starterChips("hinglish", "dashboard").map((c) => c.label)).toContain("Aaj kya dekhna hai?");
  });
});

describe("Phase 0 spend copy (1.4, 6.5, 6.12)", () => {
  it("Eddy lists exactly the codes copy.ts defines", () => {
    expect([...SPEND_CODES].sort()).toEqual([...SPEND_COPY_CODES].sort());
  });

  const INR = (rupees: number) => ({ minor: BigInt(rupees * 100), currency: "INR" });
  const fmt = (a: { minor: bigint; currency: string }) => formatMinor(a.minor, a.currency);
  const retryAt = new Date("2026-10-28T10:10:00Z");
  const resetsOn = new Date("2026-11-01T00:00:00+05:30");
  const varsFor = (p: SpendCopyParams): SpendVars => ({
    ...(p.left ? { left: fmt(p.left as { minor: bigint; currency: string }) } : {}),
    ...(p.needs ? { needs: fmt(p.needs as { minor: bigint; currency: string }) } : {}),
    ...(p.cost ? { cost: fmt(p.cost as { minor: bigint; currency: string }) } : {}),
    ...(p.daily ? { daily: fmt(p.daily as { minor: bigint; currency: string }) } : {}),
    ...(p.monthly ? { monthly: fmt(p.monthly as { minor: bigint; currency: string }) } : {}),
    ...(p.accountCurrency ? { accountCurrency: p.accountCurrency } : {}),
    ...(p.limitCurrency ? { limitCurrency: p.limitCurrency } : {}),
    ...(p.retryAt ? { time: formatCopyTime(p.retryAt) ?? undefined } : {}),
    ...(p.resetsOn && p.period !== "day" ? { date: formatCopyDate(p.resetsOn) ?? undefined } : {}),
    ...(p.minutes !== undefined ? { minutes: p.minutes } : {}),
    ...(p.period ? { period: p.period } : {}),
  });

  const CASES: [string, SpendCopyParams][] = [
    ["spend.daily_limit", {}],
    ["spend.daily_limit", { left: INR(500) }],
    ["spend.daily_limit", { left: INR(500), needs: INR(3500) }],
    ["spend.daily_limit", { needs: INR(3500) }],
    ["spend.monthly_limit", {}],
    ["spend.monthly_limit", { left: INR(102340), needs: INR(250000) }],
    ["spend.no_limit", {}],
    ["spend.frozen", {}],
    ["spend.platform_frozen", {}],
    ["spend.end_date_required", {}],
    ["spend.currency", {}],
    ["spend.currency", { accountCurrency: "USD", limitCurrency: "INR" }],
    ["spend.not_spending_account", {}],
    ["spend.probation", {}],
    ["spend.probation", { daily: INR(1000), monthly: INR(10000) }],
    ["spend.meta_cap_too_low", {}],
    ["spend.meta_cap_too_low", { minutes: 45 }],
    ["spend.meta_rate", {}],
    ["spend.meta_rate", { retryAt }],
    ["spend.broadcast", {}],
    ["spend.broadcast", { period: "day" }],
    ["spend.broadcast", { cost: INR(1430), left: INR(900) }],
    ["spend.broadcast", { cost: INR(1430), left: INR(900), period: "day" }],
    ["spend.messaging_limit", {}],
    ["spend.messaging_limit", { resetsOn }],
    ["spend.messaging_limit", { period: "day" }],
    ["ai_quota", {}],
    ["ai_quota", { resetsOn }],
    ["ai_quota", { period: "day" }],
    ["spend.busy", {}],
    ["spend.only_owner_raise", {}],
    ["spend.version", {}],
    ["spend.demo", {}],
  ];

  it("covers every code with at least one case", () => {
    expect(new Set(CASES.map(([c]) => c))).toEqual(new Set(SPEND_COPY_CODES));
  });

  it.each(CASES)("English %s is byte-identical to copy.ts (%o)", (code, params) => {
    expect(spendMessage("en", code as (typeof SPEND_CODES)[number], varsFor(params))).toBe(spendCopy(code as (typeof SPEND_COPY_CODES)[number], params));
  });

  it.each(CASES)("Hindi and Hinglish %s are complete sentences in their own script (%o)", (code, params) => {
    const hi = spendMessage("hi", code as (typeof SPEND_CODES)[number], varsFor(params));
    const hinglish = spendMessage("hinglish", code as (typeof SPEND_CODES)[number], varsFor(params));
    for (const text of [hi, hinglish]) {
      expect(text).not.toMatch(/\{[A-Za-z]/);
      expect(text.length).toBeGreaterThan(10);
    }
    expect(/\p{Script=Devanagari}/u.test(hi)).toBe(true);
    expect(/\p{Script=Devanagari}/u.test(hinglish)).toBe(false);
    expect(hi).not.toBe(spendCopy(code as (typeof SPEND_COPY_CODES)[number], params));
  });
});

describe("t(), makeTranslator() and run-time keys", () => {
  it("interpolates, keeps a missing variable visible, and splits a template into parts", () => {
    expect(t("en", "card.send_text.title", { name: "Ramesh" })).toBe("Send this reply to Ramesh?");
    expect(t("en", "card.send_text.title")).toBe("Send this reply to {name}?");
    expect(interpolate("{a} and {b}", { a: 1, b: null })).toBe("1 and {b}");
    expect(templateParts("Send {x} now")).toEqual([
      { kind: "text", text: "Send " },
      { kind: "var", name: "x" },
      { kind: "text", text: " now" },
    ]);
  });

  it("an unknown language falls back to English", () => {
    expect(t("xx" as "en", "launcher")).toBe("Ask Eddy");
  });

  it("area catalogues added under src/lib/eddy/copy/ work without editing the core", () => {
    const area = defineCatalogue({ en: { "area.hello": "Hello {name}" }, hi: { "area.hello": "नमस्ते {name}" }, hinglish: { "area.hello": "Namaste {name}" } });
    const tr = makeTranslator(CORE, area);
    expect(tr("hi", "area.hello", { name: "Riya" })).toBe("नमस्ते Riya");
    expect(tr("en", "launcher")).toBe("Ask Eddy");
    // The merged translator takes the keys of both catalogues and nothing else (checked by tsc).
    // @ts-expect-error a key in neither catalogue is a type error
    expect(tr("en", "area.missing")).toBe("area.missing");
    expect(hasKey("area.hello")).toBe(false);
    registerCatalogue(area);
    expect(hasKey("area.hello")).toBe(true);
    expect(translateKey("hinglish", "area.hello", { name: "Riya" })).toBe("Namaste Riya");
  });

  it("a key the server sends that the catalogue does not know renders the fallback, never the raw key", () => {
    expect(translateKey("en", "card.nonexistent.title")).toBe("Done.");
    expect(translateKey("hi", "card.nonexistent.title", {}, "X")).toBe("X");
  });
});
