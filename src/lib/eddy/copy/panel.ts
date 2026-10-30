/**
 * Eddy's panel and shell copy (docs/EDDY-SPEC.md 6.1 to 6.3, 6.6, 6.11, 6.13, 7.6, 12.1a decision 6): the panel menu, the
 * context chip, the composer, paste warnings, the off-state setup list, the "Turn on Eddy" card and the owner's switch in
 * Settings > AI tools. The core keys (launcher, btn.*, off.*, enable.*, turnon.*, notice.first_use) stay in en.ts; this
 * area file only adds what the panel needs on top, under the `panel.` prefix.
 *
 * Same rules as the core catalogue (tests/eddy-i18n.test.ts scans this file too): identical keys and {placeholders} in all
 * three languages; Hindi uses Latin letters only for Eddy, WhatsApp, Meta, Edwyz, Anthropic, Facebook and AI (key names such
 * as Enter and Ctrl are written in Devanagari); Hinglish has no Devanagari; Eddy's first person never marks a gender; no
 * emojis, no exclamation marks, no links.
 *
 * Native-speaker review: pending, together with the core catalogue (6.12).
 */
import { defineCatalogue, makeTranslator, registerCatalogue } from "../i18n";

const en = {
  // ===== Header and menu (6.2, 6.3) =====
  "panel.close": "Close Eddy",
  "panel.menu": "Eddy menu",
  "panel.menu.language": "Language",
  "panel.menu.team": "Team activity",
  "panel.menu.usage": "My usage",
  "panel.menu.delete": "Delete my Eddy history",
  "panel.menu.settings": "Eddy settings",
  "panel.lang.auto": "Same as my message",
  "panel.lang.en": "English",
  "panel.lang.hi": "Hindi",
  "panel.lang.hinglish": "Hinglish",
  "panel.lang.saved": "Language saved.",
  "panel.lang.failed": "The language couldn't be saved. Try again.",
  "panel.team.query": "What did the automations do today?",
  "panel.usage.me": "You've used {used} of {limit} Eddy credits today.",
  "panel.usage.month": "This workspace has used {used} of {limit} AI credits this month.",
  "panel.usage.month_open": "This workspace has used {used} AI credits this month.",
  "panel.usage.note": "Eddy and the AI agent share the workspace's AI limit.",
  "panel.delete.ask": "Delete your Eddy chats now? A record of actions you confirmed is kept for {days} days.",
  "panel.delete.yes": "Delete history",
  "panel.delete.done": "Your chats are deleted now. A record of actions you confirmed is kept for {days} days.",
  "panel.delete.failed": "Your Eddy history couldn't be deleted. Try again.",
  "panel.new_chat.done": "New chat started.",
  "panel.log": "Conversation with Eddy",
  "panel.loading": "Loading Eddy…",

  // ===== Context chip (6.3) =====
  "panel.context.using": "Using: {what}",
  "panel.context.using_named": "Using: {what} · {name}",
  "panel.context.remove": "Don't use {what} in the next message",
  "panel.context.chat": "this chat",
  "panel.context.contact": "this contact",
  "panel.context.lead": "this lead",
  "panel.context.broadcast": "this broadcast",
  "panel.context.template": "this template",
  "panel.context.segment": "this segment",
  "panel.context.notice": "this notice",
  "panel.context.message": "this message",
  "panel.context.page": "this page",

  // ===== Composer (6.2, 6.3) =====
  "panel.composer.label": "Message to Eddy",
  "panel.composer.count": "{count} of {max} characters",
  "panel.composer.enter": "Enter sends, Shift+Enter adds a line.",
  "panel.composer.mod_enter": "Ctrl+Enter sends, Enter adds a line.",
  "panel.composer.send": "Send to Eddy",
  "panel.composer.stop": "Stop Eddy's reply",
  "panel.composer.restored": "Your unsent message is back in the box.",
  "panel.paste.card": "This looks like a card number. Eddy never needs one, so remove it before you send.",
  "panel.paste.otp": "This looks like a one-time code. Never share a code, not even with Eddy.",
  "panel.ref.explain": "Explain this",
  "panel.launcher.working": "Ask Eddy, still working on your last message",

  // ===== Turn on Eddy (12.1a decision 6) =====
  "panel.enable.failed": "Eddy couldn't be turned on. Try again.",
  "panel.enable.done": "Eddy is on for this workspace.",

  // ===== Off states: plain buttons that need no AI (6.11) =====
  "panel.setup.title": "Your setup list",
  "panel.setup.progress": "{done} of {total} done",
  "panel.setup.loading": "Loading your setup list…",
  "panel.setup.failed": "Your setup list couldn't be loaded.",
  "panel.setup.complete": "Your setup is complete.",
  "panel.on_screen": "Already on screen",
  "panel.goto": "Go to a page",

  // ===== Settings > AI tools: the owner's switch (12.1a decision 6) =====
  "panel.settings.title": "Eddy, the AI helper",
  "panel.settings.switch": "Eddy for this workspace",
  "panel.settings.on": "On",
  "panel.settings.off": "Off",
  "panel.settings.is_on": "Eddy is on for this workspace.",
  "panel.settings.is_off": "Eddy is off for this workspace.",
  "panel.settings.turn_off_note": "Turning Eddy off stops new chats at once. Previews already on screen can still be confirmed or cancelled.",
  "panel.settings.saved_off": "Eddy is off. Nothing more is sent to Anthropic from this workspace.",
  "panel.settings.failed": "That didn't save. Try again.",
  "panel.settings.loading": "Loading Eddy settings…",
  "panel.settings.load_failed": "Eddy settings couldn't be loaded.",
} as const;

export type PanelKey = keyof typeof en;
type PanelCopy = { readonly [K in PanelKey]: string };

const hi: PanelCopy = {
  "panel.close": "Eddy बंद करें",
  "panel.menu": "Eddy मेन्यू",
  "panel.menu.language": "भाषा",
  "panel.menu.team": "टीम की गतिविधि",
  "panel.menu.usage": "मेरा इस्तेमाल",
  "panel.menu.delete": "मेरी Eddy हिस्ट्री डिलीट करें",
  "panel.menu.settings": "Eddy सेटिंग्स",
  "panel.lang.auto": "मेरे मैसेज जैसी",
  "panel.lang.en": "अंग्रेज़ी",
  "panel.lang.hi": "हिंदी",
  "panel.lang.hinglish": "हिंग्लिश",
  "panel.lang.saved": "भाषा सेव हो गई।",
  "panel.lang.failed": "भाषा सेव नहीं हो पाई। फिर से कोशिश करें।",
  "panel.team.query": "आज ऑटोमेशन ने क्या किया?",
  "panel.usage.me": "आज आपने {limit} में से {used} Eddy क्रेडिट इस्तेमाल किए हैं।",
  "panel.usage.month": "इस महीने इस वर्कस्पेस ने {limit} में से {used} AI क्रेडिट इस्तेमाल किए हैं।",
  "panel.usage.month_open": "इस महीने इस वर्कस्पेस ने {used} AI क्रेडिट इस्तेमाल किए हैं।",
  "panel.usage.note": "Eddy और AI एजेंट, वर्कस्पेस की एक ही AI लिमिट इस्तेमाल करते हैं।",
  "panel.delete.ask": "अपनी Eddy बातचीत अभी डिलीट करें? आपकी कन्फ़र्म की गई कार्रवाइयों का रिकॉर्ड {days} दिन तक रखा जाता है।",
  "panel.delete.yes": "हिस्ट्री डिलीट करें",
  "panel.delete.done": "आपकी बातचीत अभी डिलीट कर दी गई है। आपकी कन्फ़र्म की गई कार्रवाइयों का रिकॉर्ड {days} दिन तक रखा जाता है।",
  "panel.delete.failed": "आपकी Eddy हिस्ट्री डिलीट नहीं हो पाई। फिर से कोशिश करें।",
  "panel.new_chat.done": "नई बातचीत शुरू हो गई।",
  "panel.log": "Eddy के साथ बातचीत",
  "panel.loading": "Eddy लोड हो रहा है…",

  "panel.context.using": "इस्तेमाल हो रहा है: {what}",
  "panel.context.using_named": "इस्तेमाल हो रहा है: {what} · {name}",
  "panel.context.remove": "अगले मैसेज में {what} इस्तेमाल न करें",
  "panel.context.chat": "यह चैट",
  "panel.context.contact": "यह कॉन्टैक्ट",
  "panel.context.lead": "यह लीड",
  "panel.context.broadcast": "यह ब्रॉडकास्ट",
  "panel.context.template": "यह टेम्पलेट",
  "panel.context.segment": "यह सेगमेंट",
  "panel.context.notice": "यह सूचना",
  "panel.context.message": "यह मैसेज",
  "panel.context.page": "यह पेज",

  "panel.composer.label": "Eddy के लिए मैसेज",
  "panel.composer.count": "{max} में से {count} अक्षर",
  "panel.composer.enter": "एंटर से भेजें, शिफ़्ट+एंटर से नई लाइन।",
  "panel.composer.mod_enter": "कंट्रोल+एंटर से भेजें, एंटर से नई लाइन।",
  "panel.composer.send": "Eddy को भेजें",
  "panel.composer.stop": "Eddy का जवाब रोकें",
  "panel.composer.restored": "आपका बिना भेजा मैसेज वापस बॉक्स में है।",
  "panel.paste.card": "यह कार्ड नंबर जैसा लग रहा है। Eddy को इसकी कभी ज़रूरत नहीं होती, इसलिए भेजने से पहले इसे हटा दें।",
  "panel.paste.otp": "यह वन-टाइम कोड जैसा लग रहा है। कोई भी कोड किसी से साझा न करें, Eddy से भी नहीं।",
  "panel.ref.explain": "इसे समझाइए",
  "panel.launcher.working": "Eddy से पूछें, पिछले मैसेज पर अभी काम चल रहा है",

  "panel.enable.failed": "Eddy चालू नहीं हो पाया। फिर से कोशिश करें।",
  "panel.enable.done": "इस वर्कस्पेस के लिए Eddy चालू है।",

  "panel.setup.title": "आपकी सेटअप लिस्ट",
  "panel.setup.progress": "{total} में से {done} पूरे",
  "panel.setup.loading": "आपकी सेटअप लिस्ट लोड हो रही है…",
  "panel.setup.failed": "आपकी सेटअप लिस्ट लोड नहीं हो पाई।",
  "panel.setup.complete": "आपका सेटअप पूरा हो गया है।",
  "panel.on_screen": "स्क्रीन पर पहले से मौजूद",
  "panel.goto": "किसी पेज पर जाएँ",

  "panel.settings.title": "Eddy, AI हेल्पर",
  "panel.settings.switch": "इस वर्कस्पेस के लिए Eddy",
  "panel.settings.on": "चालू",
  "panel.settings.off": "बंद",
  "panel.settings.is_on": "इस वर्कस्पेस के लिए Eddy चालू है।",
  "panel.settings.is_off": "इस वर्कस्पेस के लिए Eddy बंद है।",
  "panel.settings.turn_off_note": "Eddy बंद करने पर नई बातचीत तुरंत रुक जाती है। स्क्रीन पर मौजूद प्रीव्यू अब भी कन्फ़र्म या रद्द किए जा सकते हैं।",
  "panel.settings.saved_off": "Eddy बंद है। इस वर्कस्पेस से अब Anthropic को कुछ नहीं भेजा जाता।",
  "panel.settings.failed": "यह सेव नहीं हो पाया। फिर से कोशिश करें।",
  "panel.settings.loading": "Eddy सेटिंग्स लोड हो रही हैं…",
  "panel.settings.load_failed": "Eddy सेटिंग्स लोड नहीं हो पाईं।",
};

const hinglish: PanelCopy = {
  "panel.close": "Eddy band kariye",
  "panel.menu": "Eddy menu",
  "panel.menu.language": "Bhasha",
  "panel.menu.team": "Team activity",
  "panel.menu.usage": "Mera usage",
  "panel.menu.delete": "Meri Eddy history delete kariye",
  "panel.menu.settings": "Eddy settings",
  "panel.lang.auto": "Mere message jaisi",
  "panel.lang.en": "English",
  "panel.lang.hi": "Hindi",
  "panel.lang.hinglish": "Hinglish",
  "panel.lang.saved": "Bhasha save ho gayi.",
  "panel.lang.failed": "Bhasha save nahi ho payi. Phir se try kariye.",
  "panel.team.query": "Aaj automations ne kya kiya?",
  "panel.usage.me": "Aaj aapne {limit} mein se {used} Eddy credits use kiye hain.",
  "panel.usage.month": "Is mahine is workspace ne {limit} mein se {used} AI credits use kiye hain.",
  "panel.usage.month_open": "Is mahine is workspace ne {used} AI credits use kiye hain.",
  "panel.usage.note": "Eddy aur AI agent workspace ki ek hi AI limit use karte hain.",
  "panel.delete.ask": "Apni Eddy baatcheet abhi delete karein? Aapke confirm kiye gaye actions ka record {days} din tak rakha jaata hai.",
  "panel.delete.yes": "History delete kariye",
  "panel.delete.done": "Aapki baatcheet abhi delete kar di gayi hai. Aapke confirm kiye gaye actions ka record {days} din tak rakha jaata hai.",
  "panel.delete.failed": "Aapki Eddy history delete nahi ho payi. Phir se try kariye.",
  "panel.new_chat.done": "Nayi baatcheet shuru ho gayi.",
  "panel.log": "Eddy ke saath baatcheet",
  "panel.loading": "Eddy load ho raha hai…",

  "panel.context.using": "Use ho raha hai: {what}",
  "panel.context.using_named": "Use ho raha hai: {what} · {name}",
  "panel.context.remove": "Agle message mein {what} use mat kariye",
  "panel.context.chat": "yeh chat",
  "panel.context.contact": "yeh contact",
  "panel.context.lead": "yeh lead",
  "panel.context.broadcast": "yeh broadcast",
  "panel.context.template": "yeh template",
  "panel.context.segment": "yeh segment",
  "panel.context.notice": "yeh notice",
  "panel.context.message": "yeh message",
  "panel.context.page": "yeh page",

  "panel.composer.label": "Eddy ke liye message",
  "panel.composer.count": "{max} mein se {count} characters",
  "panel.composer.enter": "Enter se bhejiye, Shift+Enter se nayi line.",
  "panel.composer.mod_enter": "Ctrl+Enter se bhejiye, Enter se nayi line.",
  "panel.composer.send": "Eddy ko bhejiye",
  "panel.composer.stop": "Eddy ka jawab rokiye",
  "panel.composer.restored": "Aapka bina bheja message wapas box mein hai.",
  "panel.paste.card": "Yeh card number jaisa lag raha hai. Eddy ko iski kabhi zaroorat nahi hoti, isliye bhejne se pehle ise hata dijiye.",
  "panel.paste.otp": "Yeh one-time code jaisa lag raha hai. Koi bhi code kisi ke saath share mat kariye, Eddy ke saath bhi nahi.",
  "panel.ref.explain": "Ise samjhaiye",
  "panel.launcher.working": "Eddy se poochhiye, pichhle message par abhi kaam chal raha hai",

  "panel.enable.failed": "Eddy chalu nahi ho paya. Phir se try kariye.",
  "panel.enable.done": "Is workspace ke liye Eddy chalu hai.",

  "panel.setup.title": "Aapki setup list",
  "panel.setup.progress": "{total} mein se {done} poore",
  "panel.setup.loading": "Aapki setup list load ho rahi hai…",
  "panel.setup.failed": "Aapki setup list load nahi ho payi.",
  "panel.setup.complete": "Aapka setup poora ho gaya hai.",
  "panel.on_screen": "Screen par pehle se maujood",
  "panel.goto": "Kisi page par jaiye",

  "panel.settings.title": "Eddy, AI helper",
  "panel.settings.switch": "Is workspace ke liye Eddy",
  "panel.settings.on": "Chalu",
  "panel.settings.off": "Band",
  "panel.settings.is_on": "Is workspace ke liye Eddy chalu hai.",
  "panel.settings.is_off": "Is workspace ke liye Eddy band hai.",
  "panel.settings.turn_off_note": "Eddy band karne par nayi baatcheet turant ruk jaati hai. Screen par maujood previews ab bhi confirm ya cancel kiye ja sakte hain.",
  "panel.settings.saved_off": "Eddy band hai. Is workspace se ab Anthropic ko kuch nahi bheja jaata.",
  "panel.settings.failed": "Yeh save nahi ho paya. Phir se try kariye.",
  "panel.settings.loading": "Eddy settings load ho rahi hain…",
  "panel.settings.load_failed": "Eddy settings load nahi ho payin.",
};

/** The panel's area catalogue (scanned by tests/eddy-i18n.test.ts with the core). */
export const catalogue = defineCatalogue<PanelKey>({ en, hi, hinglish });
registerCatalogue(catalogue);

/** Translator over the panel keys only; core keys keep using `t` from ../i18n. */
export const tp = makeTranslator(catalogue);
