import { LEGAL } from "@/lib/legal";
import type { IconName } from "./icons";

/*
 * Landing page copy. Every claim here was checked against the code and docs on 2026-10-29: what is live is described as
 * live, Eddy and the spending limits are marked New, and the Instagram and Facebook Page ads and the Android app are marked
 * Coming soon (docs/IG-PAGE-ADS-SPEC.md, docs/PLAY-STORE.md: nothing is on Google Play yet). No testimonials, logos, user
 * counts, ratings, awards or prices: we have none to report, and prices live only on /pricing (src/components/site/pricing.ts).
 */

export const NAV_LINKS = [
  { href: "/#features", label: "Features" },
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" },
] as const;

export const SIGN_IN = { href: "/login", label: "Sign in" } as const;
export const START_TRIAL = { href: "/signup", label: "Start free trial" } as const;

/** The in-page sections of the landing page. The header and footer link to some of these as /#id. */
export const SECTION = {
  howItWorks: "how-it-works",
  features: "features",
  eddy: "eddy",
  spending: "spending",
  comingSoon: "coming-soon",
  developers: "developers",
  security: "security",
  faq: "faq",
} as const;

export type SectionId = (typeof SECTION)[keyof typeof SECTION];

/** "new" is live and recently added; "soon" is not available yet. */
export type Status = "new" | "soon";

export const STATUS_LABEL: Record<Status, string> = { new: "New", soon: "Coming soon" };

export type Highlight = { icon: IconName; text: string };

export const HIGHLIGHTS: Highlight[] = [
  { icon: "verified", text: "Built on the official WhatsApp Business Platform" },
  { icon: "database", text: "Your number and your data stay yours" },
  { icon: "gauge", text: "Spending limits you set for messages, AI and ads" },
];

export const STEPS = [
  {
    title: "Connect your number",
    body: "Create your workspace, then link your WhatsApp Business number through Meta's own sign-up window. It takes about 5 minutes, and we never see your Facebook password.",
  },
  {
    title: "Bring your team",
    body: "Invite teammates as admins or team members. Assign chats, leave private notes and share quick replies, so everyone knows who is answering.",
  },
  {
    title: "Automate the routine",
    body: "Add rules, chatbots and an AI agent for the questions you answer every day, and send broadcasts to people who opted in. Your team steps in when it matters.",
  },
] as const;

export type Feature = { icon: IconName; title: string; body: string };
export type FeatureGroup = { id: string; outcome: string; summary: string; features: Feature[] };

export const FEATURE_GROUPS: FeatureGroup[] = [
  {
    id: "talk",
    outcome: "Talk to customers",
    summary: "Every conversation in one place, answered by the right person.",
    features: [
      {
        icon: "inbox",
        title: "Shared team inbox",
        body: "Everyone replies from the same WhatsApp number. Assign chats, leave private notes, use quick replies and update many chats at once.",
      },
      {
        icon: "template",
        title: "Message templates",
        body: "Write the messages WhatsApp requires for starting a conversation, send them to Meta for approval and follow their status in one list.",
      },
      {
        icon: "megaphone",
        title: "Broadcasts with clear results",
        body: "Send an approved message to contacts who opted in. See the estimated cost first, then who received and read it, and why a message failed, in plain words.",
      },
      {
        icon: "users",
        title: "Contacts and segments",
        body: "Import a spreadsheet, add tags and details, and group contacts into segments with filters, ready for your next broadcast.",
      },
    ],
  },
  {
    id: "automate",
    outcome: "Automate the busy work",
    summary: "Let routine questions answer themselves, and keep your team for the rest.",
    features: [
      {
        icon: "bolt",
        title: "Automation rules",
        body: "When something happens, do something: tag, assign, send a message or notify another tool.",
      },
      {
        icon: "bot",
        title: "Chatbots with a visual builder",
        body: "Build a question-and-answer flow without code. Ask, branch, tag, assign to a person or hand the chat over.",
      },
      {
        icon: "sparkle",
        title: "AI agent that knows your business",
        body: "It answers only from the knowledge you add, in the language the customer writes in, and hands the chat to your team when it cannot answer.",
      },
      {
        icon: "cart",
        title: "Shopify abandoned-cart recovery",
        body: "Connect your Shopify store and remind shoppers who left items in their cart with an approved WhatsApp message.",
      },
    ],
  },
  {
    id: "manage",
    outcome: "Run your team and see results",
    summary: "Clear roles, fair routing and numbers you can act on.",
    features: [
      {
        icon: "shield",
        title: "Roles and teams",
        body: "Invite people as admins or team members, and group them into teams that each handle their own chats.",
      },
      {
        icon: "route",
        title: "Fair chat routing",
        body: "Share new chats across your team by turns or by workload, and respect working hours.",
      },
      {
        icon: "chart",
        title: "Reports",
        body: "Conversations, response times, broadcasts and team activity over the dates you choose, ready to export.",
      },
      {
        icon: "code",
        title: "API, webhooks and MCP",
        body: "Connect your own systems and AI tools with scoped API keys, signed webhooks and an MCP server.",
      },
    ],
  },
];

export type EddyTurn = {
  from: "you" | "eddy";
  text: string;
  /** Shown under Eddy's message as an illustrated button. */
  undo?: boolean;
  /** Eddy's preview card for an action that messages a customer. */
  card?: { title: string; quote: string; actions: string[]; note: string };
};

export type EddyExample = { label: string; lang: "hi-Latn" | "en"; turns: EddyTurn[] };

export const EDDY_POINTS: Feature[] = [
  {
    icon: "globe",
    title: "English, Hindi or Hinglish",
    body: "Ask in your own words. Eddy answers in the language and script you write in.",
  },
  {
    icon: "check",
    title: "Does the clicking for you",
    body: "Look-ups and reports happen at once. Small changes like tags come with Undo.",
  },
  {
    icon: "lock",
    title: "Asks before it acts",
    body: "Anything that messages customers, spends money or deletes something waits for your tap on a preview card.",
  },
  {
    icon: "users",
    title: "Only what you may do",
    body: "Eddy works with your role's permissions, checked on our server for every action.",
  },
];

/** Illustrative only: names and numbers are made up. The flows match what Eddy does (docs/EDDY-SPEC.md 1.1 and 1.5). */
export const EDDY_EXAMPLES: EddyExample[] = [
  {
    label: "Hinglish",
    lang: "hi-Latn",
    turns: [
      { from: "you", text: "Aaj kitni chats ka reply baaki hai?" },
      { from: "eddy", text: "7 chats aapke reply ka wait kar rahi hain. Sabse purani 2 ghante pehle aayi thi. Inpe 'urgent' tag laga doon?" },
      { from: "you", text: "Haan, laga do." },
      { from: "eddy", text: "Ho gaya. 7 chats par 'urgent' tag laga diya.", undo: true },
    ],
  },
  {
    label: "English",
    lang: "en",
    turns: [
      { from: "you", text: "Tell Ravi his order ships tomorrow." },
      {
        from: "eddy",
        text: "Here is the reply. Check it before it goes.",
        card: {
          title: "Send this reply to Ravi?",
          quote: "Hi Ravi, your order ships tomorrow. We will share the tracking link as soon as it is on its way.",
          actions: ["Send", "Edit", "Cancel"],
          note: "Nothing is sent until you tap Send.",
        },
      },
    ],
  },
];

export const SPEND_POINTS: Feature[] = [
  {
    icon: "gauge",
    title: "Monthly and daily limits",
    body: "Set limits for ads, WhatsApp messages and AI. Every automatic message, AI reply and ad change is checked against them before it happens, and a broadcast's estimated cost is checked before it starts.",
  },
  {
    icon: "bell",
    title: "Approvals for bigger steps",
    body: "Requests and suggestions to spend more wait for an owner or admin to approve them, and are declined automatically if nobody answers in time.",
  },
  {
    icon: "shield",
    title: "Automatic safety stops",
    body: "Spending is paused or held when a limit is used up, when spending suddenly jumps, or when your WhatsApp quality rating drops.",
  },
  {
    icon: "stop",
    title: "One button to stop everything",
    body: "Stop all spending at any time. Lowering a limit or stopping is never blocked and never waits for an approval.",
  },
  {
    icon: "wallet",
    title: "Your money stays with you",
    body: "Meta bills you directly for ads and WhatsApp messages. Edwyz WA never holds your ad or messaging money.",
  },
  {
    icon: "eye",
    title: "Everyone can see the limits",
    body: "Every member sees the Spending limits page. The owner sets the limits, and admins can lower them or stop spending.",
  },
];

/** Illustration of the Spending limits page. Status words are the ones the page uses; no amounts, so nothing reads as a price. */
export const SPEND_PREVIEW: { label: string; status: string; tone: "good" | "warn"; percent: number }[] = [
  { label: "WhatsApp messages", status: "Within limits", tone: "good", percent: 35 },
  { label: "AI", status: "Near the limit", tone: "warn", percent: 82 },
  { label: "Ads", status: "Within limits", tone: "good", percent: 20 },
];

export const COMING_SOON: Feature[] = [
  {
    icon: "play",
    title: "Boost a reel or post",
    body: "Pick a post or reel from your Facebook Page or Instagram account and boost it, with an end date and a daily budget.",
  },
  {
    icon: "template",
    title: "Lead forms",
    body: "Build an instant form for your ad, collect leads and follow them up on WhatsApp.",
  },
  {
    icon: "chat",
    title: "Click-to-WhatsApp from Instagram",
    body: "Ads that open a WhatsApp chat with your business, straight into your shared inbox.",
  },
  {
    icon: "phone",
    title: "Android app on Google Play",
    body: "Your inbox and workspace as an app on your Android phone.",
  },
];

export const DEVELOPER_POINTS: Feature[] = [
  {
    icon: "code",
    title: "REST API",
    body: "JSON endpoints for contacts, messages, templates and broadcasts, described in an OpenAPI 3.1 document.",
  },
  {
    icon: "bolt",
    title: "Signed webhooks",
    body: "Events for new messages and delivery updates, signed so you can verify them and retried when your server is down.",
  },
  {
    icon: "sparkle",
    title: "MCP server",
    body: "Connect Claude or another MCP client to read chats and contacts and draft or send replies, within the scopes of its key.",
  },
  {
    icon: "lock",
    title: "Scoped API keys",
    body: "Give each key only the access it needs, and revoke it at any time.",
  },
];

export type Fact = { icon: IconName; title: string; body: string };

export const SECURITY_FACTS: Fact[] = [
  { icon: "lock", title: "Connection tokens are encrypted", body: "The keys that connect your WhatsApp and Meta accounts are encrypted before they are stored and are never shown back in the app." },
  { icon: "shield", title: "Each workspace is separate", body: "Every record belongs to one workspace and every request is checked against it, so other customers cannot see your contacts or messages." },
  { icon: "database", title: "You own your data", body: "Your contacts and conversations are yours. You can export your reports, and you can ask us to delete your workspace data at any time." },
  { icon: "verified", title: "The official WhatsApp Business Platform", body: "We use Meta's own Cloud API and sign-up flow, not unofficial methods that break WhatsApp's rules." },
  { icon: "lock", title: "Passwords are never kept as plain text", body: "Passwords are stored only as salted one-way hashes, so we cannot read them." },
  { icon: "users", title: "AI works within your permissions", body: "Eddy can only do what the signed-in person is allowed to do, and the AI agent answers only from the knowledge you give it." },
];

export type Faq = { q: string; a: string; link?: { href: string; label: string } };

export const FAQS: Faq[] = [
  {
    q: "How does pricing work, and is there a free trial?",
    a: "Start with a free trial: you do not need a card, and the pricing page shows how long it lasts. The same page lists the plans and their limits once prices are published; until then, write to us for a quote. When the trial ends, your workspace becomes read-only until you choose a plan: you can still see your contacts and conversations, but sending stops.",
    link: { href: "/pricing", label: "See pricing" },
  },
  {
    q: "What does WhatsApp cost, and who do I pay?",
    a: "Meta charges for the messages your business sends, depending on the type of message and the country of the person receiving it. You pay Meta directly, with the payment method you add in WhatsApp Manager. That charge is separate from your Edwyz WA plan, and we do not collect it.",
  },
  {
    q: "What do I need to get started?",
    a: "The Facebook login that manages your business, a phone number that can receive a text message or call to confirm it is yours, and about 5 minutes. The number must not be tied to another WhatsApp provider, and a number on the WhatsApp Business Platform follows Meta's rules, so read Meta's guidance before connecting one you also use in the regular WhatsApp app. Before you can message customers, Meta also needs a payment method on your WhatsApp account.",
  },
  {
    q: "Which languages does it work in?",
    a: "The app itself is in English. Eddy, the in-app helper, understands English, Hindi and Hinglish and replies in the language and script you write in. The AI agent replies to customers in the language they write in, unless you choose a fixed language. Message templates can be written in English, Hindi and several other languages.",
  },
  {
    q: "Do I need permission before I message people?",
    a: "Yes. WhatsApp requires people to opt in before you send them marketing messages. Edwyz WA records opt-in on each contact, only sends broadcasts to contacts who opted in, and honours a STOP reply. You are responsible for collecting consent in the first place.",
  },
  {
    q: "Does the AI do things on its own?",
    a: "Only what you set up. The AI agent sends no replies until you switch it on, and it hands the chat to your team when it cannot answer. Eddy is off until the workspace owner switches it on, and it asks you to confirm before anything that messages customers, spends money or deletes something.",
  },
  {
    q: "Which countries do you support?",
    a: "Edwyz WA is run from India and plans are priced in rupees. We have not published a list of supported countries. What you can do in each country depends on Meta, so if your customers are outside India, write to us before you sign up.",
  },
  {
    q: "How do I delete my data?",
    a: `You can delete a contact, with their conversations, from the Contacts page. To delete your workspace data or your account, use the data deletion page or email us. We aim to respond within ${LEGAL.requestResponseDays} days. Billing records are kept for as long as tax law requires.`,
    link: { href: "/data-deletion", label: "Data deletion" },
  },
];
