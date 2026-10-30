export type EscalationKind = "human_request" | "frustration";
export type EscalationSignal = { kind: EscalationKind; source: "keyword" | "custom" | "ai" };

/** Lower case, NFKC, and a second copy without accents so "atención" and "atencion" both match. */
function forms(text: string): string[] {
  const base = text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const plain = base.normalize("NFD").replace(/\p{M}/gu, "");
  return plain === base ? [base] : [base, plain];
}

const W = (words: string) => `(?<![\\p{L}\\p{N}_])(?:${words})(?![\\p{L}\\p{N}_])`;
const rx = (source: string) => new RegExp(source, "u");

/**
 * Phrases that clearly ask for a person. They escalate wherever they appear, because nobody types them as an answer to a question.
 * Written per language (English, Spanish, French, German, Portuguese, Italian, Hindi in Latin and Devanagari script, Arabic).
 */
const HUMAN_REQUEST: RegExp[] = [
  rx(`${W("talk|speak|chat|connect|transfer|escalate")}[a-z]*\\s+(?:me\\s+)?(?:to|with|through)\\s+(?:a\\s+|an\\s+|the\\s+|your\\s+|our\\s+|some\\s*one\\s+|any\\s*one\\s+)?(?:human|person|people|agent|representative|rep|manager|supervisor|operator|someone|somebody|anyone|real|live|staff|team|support)`),
  rx(W("real person|real human|live agent|live person|human agent|human being|a human|an human|actual person|customer care|customer service|customer support|support team|support agent|speak to somebody|talk to somebody|speak to someone|talk to someone")),
  rx(W("hablar con (?:un |una |el |la )?(?:humano|persona|agente|asesor|alguien|representante|encargado|gerente|supervisor|operador)|persona real|agente humano|atencion al cliente|servicio al cliente|quiero un humano|necesito un humano|pasame con|comunicame con")),
  rx(W("parler (?:a |avec )(?:un |une |le |la )?(?:humain|personne|agent|conseiller|conseillere|quelqu'un|responsable|vrai)|vrai(?:e)? personne|agent humain|service client|je veux un humain|passez-moi|mettez-moi en relation")),
  rx(W("mit (?:einem |einer |dem )?(?:mensch|menschen|mitarbeiter|mitarbeiterin|berater|beraterin|jemandem|kundenservice|echten|echter)\\w* (?:sprechen|reden|verbinden)|echter mensch|echte person|kundenservice|kundendienst|ich will einen menschen|ich moechte einen menschen|ich mochte einen menschen|mensch bitte|menschlichen mitarbeiter")),
  rx(W("falar com (?:um |uma |o |a )?(?:humano|pessoa|atendente|alguem|gerente|supervisor|representante)|pessoa real|atendente humano|atendimento humano|quero um atendente|quero falar com")),
  rx(W("parlare con (?:un |una |l')?(?:umano|persona|operatore|operatrice|qualcuno|responsabile)|persona reale|operatore umano|assistenza clienti|voglio un operatore|servizio clienti")),
  rx(W("insaan|insan|kisi se baat|kisi insaan|agent se baat|human se baat|manager se baat|customer care|baat karni hai|baat karna hai|real person se")),
  /(?:इंसान|किसी से बात|एजेंट से|ग्राहक सेवा|कस्टमर केयर|प्रतिनिधि से|मैनेजर से)/u,
  /(?:موظف خدمة|شخص حقيقي|ممثل خدمة العملاء|اتحدث مع|أريد التحدث|بشري|خدمة العملاء)/u,
];

/** Single words that mean "a person" but only count as a request when that is the whole point of a short message. */
const WEAK_WORDS = [
  "agent", "human", "person", "representative", "operator", "manager", "supervisor", "someone", "support", "staff",
  "humano", "agente", "asesor", "persona", "representante", "operador", "gerente", "alguien", "soporte",
  "humain", "conseiller", "personne", "responsable", "quelqu'un",
  "mensch", "mitarbeiter", "berater", "kundenservice", "jemand",
  "atendente", "pessoa", "gerente", "alguem",
  "operatore", "umano", "qualcuno",
  "insaan", "insan", "banda", "आदमी", "इंसान", "एजेंट",
];

const FRUSTRATION: RegExp[] = [
  rx(W("useless|not helpful|no help|unhelpful|waste of time|worst|terrible|awful|ridiculous|this is stupid|stupid bot|dumb bot|fed up|sick of|frustrated|frustrating|annoying|annoyed|angry|furious|unacceptable|complaint|complain|scam|fraud|rubbish|garbage|you do not understand|you don't understand|you dont understand|not understanding|doesn't understand|doesnt understand|does not understand|stop it|wtf|damn|crap|bullshit|shit|fuck\\w*|bastard|idiot")),
  rx(W("inutil|no sirve|no me entiendes|no entiende|pesimo|horrible|perdida de tiempo|harto|harta|estoy cansado|queja|fraude|estafa|mierda|basura|ridiculo|inaceptable|no ayuda|no me ayudas|que mal servicio|mal servicio")),
  rx(W("nul|nulle|inutile|ca ne sert a rien|vous ne comprenez pas|tu ne comprends pas|perte de temps|marre|reclamation|arnaque|merde|ridicule|inacceptable|vous ne m'aidez pas|ne m'aide pas|mauvais service|j'en ai assez|pas utile")),
  rx(W("nutzlos|unbrauchbar|du verstehst nicht|sie verstehen nicht|zeitverschwendung|reicht mir|beschwerde|betrug|scheisse|scheiße|schrott|laecherlich|unverschaemt|inakzeptabel|schlechter service|hilft nicht|keine hilfe|ich habe genug|nervig")),
  rx(W("inutil|pessimo|nao entende|nao me entende|nao ajuda|perda de tempo|reclamacao|golpe|merda|ridiculo|inaceitavel|servico ruim|atendimento ruim|cansado disso|estou farto")),
  rx(W("inutile|non capisci|non capite|perdita di tempo|reclamo|truffa|merda|ridicolo|inaccettabile|servizio pessimo|non mi aiuta|sono stufo")),
  rx(W("bekar|bakwas|faltu|time waste|waste of time|pareshan|shikayat|bekaar|bahut bura|ghatiya|samajh nahi|kuch samajh nahi|tang aa gaya")),
  /(?:बेकार|बकवास|फालतू|शिकायत|परेशान|घटिया)/u,
  /(?:سيء|غير مفيد|مضيعة للوقت|شكوى|احتيال)/u,
];

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;
const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function shouting(text: string): boolean {
  const letters = [...text].filter((c) => /\p{L}/u.test(c));
  if (letters.length < 12) return false;
  const upper = letters.filter((c) => c !== c.toLowerCase() && c === c.toUpperCase()).length;
  return upper / letters.length >= 0.8;
}

export type DetectOptions = {
  /** Words the business added in the bot settings; any of them escalates. */
  keywords?: string[];
  /** Also react to single words ("agent"), frustration and shouting. Pass true when the reply did not fit the question. */
  loose?: boolean;
  /** Also react to frustration words and shouting, but not to single words. Pass true for answers to questions that accept any text. */
  frustration?: boolean;
};

/** Keyword heuristics only: no network, no cost. Returns null when the text shows no sign of needing a person. */
export function detectEscalation(text: string, options: DetectOptions = {}): EscalationSignal | null {
  const raw = text.trim().slice(0, 500);
  if (!raw) return null;
  const variants = forms(raw);

  for (const word of options.keywords ?? []) {
    const k = forms(word.trim())[0];
    if (k && variants.some((v) => new RegExp(W(escapeRx(k)), "u").test(v))) return { kind: "human_request", source: "custom" };
  }
  if (variants.some((v) => HUMAN_REQUEST.some((re) => re.test(v)))) return { kind: "human_request", source: "keyword" };
  if (!options.loose && !options.frustration) return null;

  if (options.loose && variants.some((v) => wordCount(v) <= 3 && WEAK_WORDS.some((w) => new RegExp(W(escapeRx(w)), "u").test(v)))) return { kind: "human_request", source: "keyword" };
  if (variants.some((v) => FRUSTRATION.some((re) => re.test(v))) || shouting(raw)) return { kind: "frustration", source: "keyword" };
  return null;
}

