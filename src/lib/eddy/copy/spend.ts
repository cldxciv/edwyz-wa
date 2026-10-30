/**
 * The words of Eddy's v1 spend front desk (docs/EDDY-SPEC.md 4.6 spend rows, 4.10, EDDY-06), in English, Hindi and Hinglish:
 * the values the stop_spending and decline_spend_request cards show (the card's labels are core keys such as fact.level and
 * fact.note). The English of the stop cards is Phase 0's own dialog copy (docs/SPEND-CONTROLS-SPEC.md 8.1, KillSwitch.tsx),
 * word for word, so a stop through Eddy reads exactly like a stop on the Spending page.
 *
 * The server fills these in for the member's language when it builds a card, so the browser needs nothing new. Importing
 * this module also registers it with translateKey(). Rules (tests/eddy-i18n.test.ts): the same keys and {placeholders} in
 * all three languages, Hindi with Latin only from the allowlist, Hinglish without Devanagari, no gendered first person, no
 * links, no emojis, no exclamation marks.
 */
import { CORE, defineCatalogue, makeTranslator, registerCatalogue } from "../i18n";

const en = {
  "spend_desk.level.all": "All spending",
  "spend_desk.level.assistants": "Spending assistants only",
  "spend_desk.stop.all.body": "We'll pause every ad Edwyz started and hold automatic WhatsApp messages and AI replies. Messages your team types still go out. Only the owner can turn spending back on.",
  "spend_desk.stop.assistants.body": "Assistants won't start ads, raise budgets or send messages until the owner turns them back on. Your team can keep working as usual.",
  "spend_desk.request.expires_in": "Declined automatically in {hours} hours if nobody answers",
  "spend_desk.request.expires_hour": "Declined automatically within an hour if nobody answers",
  "spend_desk.request.no_estimate": "No worst case could be worked out",
  "spend_desk.assistant.ads_optimizer": "Ad assistant",
  "spend_desk.assistant.ads_launcher": "Campaign assistant",
  "spend_desk.assistant.broadcast_planner": "Broadcast assistant",
  "spend_desk.assistant.lead_followup": "Follow-up assistant",
} as const;

export type SpendDeskKey = keyof typeof en;

const hi: Record<SpendDeskKey, string> = {
  "spend_desk.level.all": "सारा खर्च",
  "spend_desk.level.assistants": "सिर्फ़ खर्च करने वाले असिस्टेंट",
  "spend_desk.stop.all.body": "Edwyz से शुरू हुए सभी विज्ञापन रोक दिए जाएँगे, और अपने आप जाने वाले WhatsApp मैसेज और AI जवाब रोक लिए जाएँगे। आपकी टीम जो मैसेज लिखती है, वे जाते रहेंगे। खर्च फिर से सिर्फ़ मालिक चालू कर सकते हैं।",
  "spend_desk.stop.assistants.body": "जब तक मालिक इन्हें फिर से चालू नहीं करते, असिस्टेंट न विज्ञापन शुरू करेंगे, न बजट बढ़ाएँगे, न मैसेज भेजेंगे। आपकी टीम हमेशा की तरह काम करती रह सकती है।",
  "spend_desk.request.expires_in": "किसी ने जवाब नहीं दिया तो {hours} घंटे में अपने आप मना हो जाएगी",
  "spend_desk.request.expires_hour": "किसी ने जवाब नहीं दिया तो एक घंटे के अंदर अपने आप मना हो जाएगी",
  "spend_desk.request.no_estimate": "ज़्यादा से ज़्यादा खर्च का अंदाज़ा नहीं लग पाया",
  "spend_desk.assistant.ads_optimizer": "विज्ञापन असिस्टेंट",
  "spend_desk.assistant.ads_launcher": "कैंपेन असिस्टेंट",
  "spend_desk.assistant.broadcast_planner": "ब्रॉडकास्ट असिस्टेंट",
  "spend_desk.assistant.lead_followup": "फ़ॉलो-अप असिस्टेंट",
};

const hinglish: Record<SpendDeskKey, string> = {
  "spend_desk.level.all": "Saara kharcha",
  "spend_desk.level.assistants": "Sirf kharcha karne wale assistants",
  "spend_desk.stop.all.body": "Edwyz se shuru hue saare ads rok diye jayenge, aur apne aap jaane wale WhatsApp messages aur AI replies rok liye jayenge. Aapki team jo messages likhti hai, woh jaate rahenge. Kharcha phir se sirf owner chalu kar sakte hain.",
  "spend_desk.stop.assistants.body": "Jab tak owner inhe phir se chalu nahi karte, assistants na ads shuru karenge, na budget badhayenge, na messages bhejenge. Aapki team hamesha ki tarah kaam karti reh sakti hai.",
  "spend_desk.request.expires_in": "Kisi ne jawab nahi diya to {hours} ghante mein apne aap decline ho jayegi",
  "spend_desk.request.expires_hour": "Kisi ne jawab nahi diya to ek ghante ke andar apne aap decline ho jayegi",
  "spend_desk.request.no_estimate": "Zyada se zyada kharche ka andaaza nahi lag paaya",
  "spend_desk.assistant.ads_optimizer": "Ad assistant",
  "spend_desk.assistant.ads_launcher": "Campaign assistant",
  "spend_desk.assistant.broadcast_planner": "Broadcast assistant",
  "spend_desk.assistant.lead_followup": "Follow-up assistant",
};

export const catalogue = defineCatalogue<SpendDeskKey>({ en, hi, hinglish });
registerCatalogue(catalogue);

/** Core keys plus the spend front desk's keys. */
export const tSpend = makeTranslator(CORE, catalogue);

/** The assistant's name in the member's language, or Phase 0's English label for one this file does not know. */
export function assistantName(lang: Parameters<typeof tSpend>[0], assistantKey: string, fallback: string): string {
  const key = `spend_desk.assistant.${assistantKey}`;
  return key in en ? tSpend(lang, key as SpendDeskKey) : fallback;
}
