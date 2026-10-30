/**
 * Catalogue keys the v1 action definitions add (docs/EDDY-SPEC.md 6.4, 6.5, 6.12; src/lib/actions/defs). The core catalogue
 * (en.ts, hi.ts, hinglish.ts) already holds every tool's status line, done line and card title; this file adds what only a
 * definition needs: titles of the cards that small changes become (more than 10 subjects, or a change that starts an
 * automation, 4.2a), fact labels, role options, and the automation facts invoke.ts adds (`card.fact.automation.<sends>`).
 *
 * Importing this module registers it with translateKey() (registerCatalogue), so any page that renders Eddy's cards imports
 * it once. Rules (tests/eddy-i18n.test.ts): the same keys and {placeholders} in all three languages, Hindi with Latin only
 * from the allowlist, Hinglish without Devanagari, no gendered first person, no links, no emojis, no exclamation marks.
 */
import { CORE, defineCatalogue, makeTranslator, registerCatalogue } from "../i18n";

const en = {
  "card.tag_conversations.title": "Change tags on {count} chats?",
  "card.tag_conversations.confirm": "Change tags",
  "card.tag_conversations.done": "Chat tags updated.",
  "card.tag_contacts.title": "Change tags on {count} contacts?",
  "card.tag_contacts.confirm": "Change tags",
  "card.tag_contacts.done": "Tags updated.",
  "card.set_conversation_status.title": "Mark the chat with {name} as {status}?",
  "card.set_conversation_status.confirm": "Change status",
  "card.set_conversation_status.done": "Chat status changed.",
  "card.update_contact.title": "Update {name}?",
  "card.update_contact.confirm": "Save changes",
  "card.update_contact.done": "Contact updated.",
  "card.create_contact.title": "Add {name} as a contact?",
  "card.create_contact.confirm": "Add contact",
  "card.create_contact.done": "Contact added.",
  "card.set_my_availability.title": "Set yourself away? {count} of your open chats can move to teammates.",
  "card.set_my_availability.confirm": "Set me away",
  "card.set_my_availability.done": "You're set as away. Chats that move to teammates stay with them.",
  "defs.fact.tags_added": "Add tags",
  "defs.fact.tags_removed": "Remove tags",
  "defs.fact.phone": "Phone",
  "defs.fact.contacts": "Contacts",
  "defs.fact.name": "Name",
  "defs.fact.attribute": "Field",
  "defs.fact.chats": "Chats",
  "defs.fact.not_sent_yet": "Not sent yet",
  "defs.fact.open_chats": "Your open chats",
  "defs.role.agent": "Team member",
  "defs.role.admin": "Admin",
  "card.fact.automation.text": "Starts a rule that sends a text reply",
  "card.fact.automation.material": "Starts a rule that sends a saved reply",
  "card.fact.automation.chatbot": "Starts a rule that runs a chatbot",
  "card.fact.automation.template": "Sends a template",
  "card.fact.automation.ai_agent": "Starts the AI agent",
  "card.fact.automation.lead_sequence": "Starts a lead follow-up",
} as const;

type DefsKey = keyof typeof en;

const hi: Record<DefsKey, string> = {
  "card.tag_conversations.title": "{count} चैट के टैग बदलें?",
  "card.tag_conversations.confirm": "टैग बदलें",
  "card.tag_conversations.done": "चैट के टैग बदल दिए गए।",
  "card.tag_contacts.title": "{count} कॉन्टैक्ट के टैग बदलें?",
  "card.tag_contacts.confirm": "टैग बदलें",
  "card.tag_contacts.done": "टैग बदल दिए गए।",
  "card.set_conversation_status.title": "{name} के साथ चैट को {status} करें?",
  "card.set_conversation_status.confirm": "स्टेटस बदलें",
  "card.set_conversation_status.done": "चैट का स्टेटस बदल दिया गया।",
  "card.update_contact.title": "{name} की जानकारी बदलें?",
  "card.update_contact.confirm": "बदलाव सेव करें",
  "card.update_contact.done": "कॉन्टैक्ट की जानकारी बदल दी गई।",
  "card.create_contact.title": "{name} को कॉन्टैक्ट में जोड़ें?",
  "card.create_contact.confirm": "कॉन्टैक्ट जोड़ें",
  "card.create_contact.done": "कॉन्टैक्ट जोड़ दिया गया।",
  "card.set_my_availability.title": "अभी दूर दिखना है? आपकी {count} खुली चैट टीम के दूसरे लोगों को जा सकती हैं।",
  "card.set_my_availability.confirm": "मुझे दूर दिखाएँ",
  "card.set_my_availability.done": "आपको दूर दिखाया जा रहा है। जो चैट टीम के दूसरे लोगों को गई हैं, वे उन्हीं के पास रहेंगी।",
  "defs.fact.tags_added": "जोड़े जाने वाले टैग",
  "defs.fact.tags_removed": "हटाए जाने वाले टैग",
  "defs.fact.phone": "फ़ोन",
  "defs.fact.contacts": "कॉन्टैक्ट",
  "defs.fact.name": "नाम",
  "defs.fact.attribute": "फ़ील्ड",
  "defs.fact.chats": "चैट",
  "defs.fact.not_sent_yet": "अभी तक नहीं भेजे गए",
  "defs.fact.open_chats": "आपकी खुली चैट",
  "defs.role.agent": "टीम सदस्य",
  "defs.role.admin": "एडमिन",
  "card.fact.automation.text": "एक नियम शुरू होगा जो टेक्स्ट जवाब भेजता है",
  "card.fact.automation.material": "एक नियम शुरू होगा जो सेव किया हुआ जवाब भेजता है",
  "card.fact.automation.chatbot": "एक नियम शुरू होगा जो चैटबॉट चलाता है",
  "card.fact.automation.template": "टेम्पलेट भेजता है",
  "card.fact.automation.ai_agent": "AI एजेंट शुरू करता है",
  "card.fact.automation.lead_sequence": "लीड फ़ॉलो-अप शुरू करता है",
};

const hinglish: Record<DefsKey, string> = {
  "card.tag_conversations.title": "{count} chats ke tags badlein?",
  "card.tag_conversations.confirm": "Tags badlein",
  "card.tag_conversations.done": "Chat ke tags badal diye gaye.",
  "card.tag_contacts.title": "{count} contacts ke tags badlein?",
  "card.tag_contacts.confirm": "Tags badlein",
  "card.tag_contacts.done": "Tags badal diye gaye.",
  "card.set_conversation_status.title": "{name} ke saath chat ko {status} karein?",
  "card.set_conversation_status.confirm": "Status badlein",
  "card.set_conversation_status.done": "Chat ka status badal diya gaya.",
  "card.update_contact.title": "{name} ki jaankari badlein?",
  "card.update_contact.confirm": "Badlav save karein",
  "card.update_contact.done": "Contact ki jaankari badal di gayi.",
  "card.create_contact.title": "{name} ko contact mein jodein?",
  "card.create_contact.confirm": "Contact jodein",
  "card.create_contact.done": "Contact jod diya gaya.",
  "card.set_my_availability.title": "Abhi away dikhna hai? Aapki {count} open chats team ke dusre logon ko ja sakti hain.",
  "card.set_my_availability.confirm": "Mujhe away dikhayein",
  "card.set_my_availability.done": "Aapko away dikhaya ja raha hai. Jo chats team ke dusre logon ko gayi hain, woh unhi ke paas rahengi.",
  "defs.fact.tags_added": "Jodne wale tags",
  "defs.fact.tags_removed": "Hatane wale tags",
  "defs.fact.phone": "Phone",
  "defs.fact.contacts": "Contacts",
  "defs.fact.name": "Naam",
  "defs.fact.attribute": "Field",
  "defs.fact.chats": "Chats",
  "defs.fact.not_sent_yet": "Abhi tak nahi bheje gaye",
  "defs.fact.open_chats": "Aapki open chats",
  "defs.role.agent": "Team member",
  "defs.role.admin": "Admin",
  "card.fact.automation.text": "Ek rule start hoga jo text reply bhejta hai",
  "card.fact.automation.material": "Ek rule start hoga jo saved reply bhejta hai",
  "card.fact.automation.chatbot": "Ek rule start hoga jo chatbot chalata hai",
  "card.fact.automation.template": "Template bhejta hai",
  "card.fact.automation.ai_agent": "AI agent start karta hai",
  "card.fact.automation.lead_sequence": "Lead follow-up start karta hai",
};

export const catalogue = defineCatalogue<DefsKey>({ en, hi, hinglish });
registerCatalogue(catalogue);

/** Core keys plus the definitions' keys. */
export const tDefs = makeTranslator(CORE, catalogue);
