import { describe, expect, it } from "vitest";
import type { EddyLang } from "@/lib/eddy/contract";
import { customerLanguage, detectLanguage, hinglishHits, latinWords, replyScript, scriptCounts, stripForDetection, HINGLISH_LEXICON } from "@/lib/eddy/language";

/**
 * docs/EDDY-SPEC.md 5.7 and EDDY-10 acceptance 2: detectLanguage is at least 97% accurate on a labelled set of 300 member
 * messages (100 per language), including code-mixed messages and 1-2 word messages, which keep the previous language.
 * Each case is [text, expected, previous language (optional)].
 */
type Case = readonly [string, EddyLang, EddyLang?];

const ENGLISH: Case[] = [
  ["How many unread chats do I have?", "en"],
  ["Why did my message to Riya fail?", "en"],
  ["Pause the Diwali broadcast", "en"],
  ["Delete the old_offer template", "en"],
  ["How much will this broadcast cost?", "en"],
  ["Tell him the order reaches tomorrow", "en"],
  ["Show me chats that are unassigned", "en"],
  ["What needs my attention today?", "en"],
  ["Why was my template rejected?", "en"],
  ["Make a Diwali offer template for my saree shop", "en"],
  ["How did yesterday's broadcast do?", "en"],
  ["How much is left this month?", "en"],
  ["Stop all spending", "en"],
  ["Summarize this chat", "en"],
  ["Draft a polite reply", "en"],
  ["Can you tag Ramesh as vip?", "en"],
  ["Assign this chat to Priya please", "en"],
  ["Which contacts have not opted in to marketing?", "en"],
  ["What is the 24-hour window?", "en"],
  ["Is my number quality still green?", "en"],
  ["Connect my WhatsApp number", "en"],
  ["Invite my brother as an agent", "en"],
  ["What does error 131047 mean?", "en"],
  ["List my templates that are waiting for approval", "en"],
  ["Create a segment of customers from Delhi", "en"],
  ["How many people read the last campaign?", "en"],
  ["Mark this conversation as resolved", "en"],
  ["Who is online in my team right now?", "en"],
  ["Turn off the AI agent for this chat", "en"],
  ["Did the payment reminder go out to Anjali?", "en"],
  ["Please check why the broadcast to 1,240 contacts is stuck", "en"],
  ["What's my AI credit usage today?", "en"],
  ["Add a note that the customer wants a refund", "en"],
  ["Send the order update template to Suresh", "en"],
  ["Is there anything waiting for my approval?", "en"],
  ["Show failed messages from last week", "en"],
  ["Can I schedule a broadcast for Sunday morning?", "en"],
  ["How do I improve my quality rating?", "en"],
  ["Where do I set the spending limits?", "en"],
  ["Explain the difference between marketing and utility templates", "en"],
  ["Block this number, they keep sending spam", "en"],
  ["Create a quick reply for our store timings", "en"],
  ["What was the response time last week?", "en"],
  ["Remove the hot-lead tag from Kavita", "en"],
  ["Copy the rejected template into marketing", "en"],
  ["Who handled the most chats this month?", "en"],
  ["Our kurta sale starts on Friday, draft a template", "en"],
  ["Check https://example.com/offer before you write the template", "en"],
  ["Can customers reply to a broadcast?", "en"],
  ["Is the Shopify cart reminder turned on?", "en"],
  ["Show leads from the Facebook form", "en"],
  ["Why is the inbox so slow today?", "en"],
  ["Change my availability to away", "en"],
  ["Undo that", "en", "en"],
  ["Thanks", "en", "en"],
  ["ok", "en", "en"],
  ["yes", "en", "en"],
  ["Go ahead", "en", "en"],
  ["Cancel it", "en", "en"],
  ["Show more", "en", "en"],
  ["Not now", "en", "en"],
  ["Perfect, thanks", "en", "en"],
  ["haan", "en", "en"],
  ["Next step?", "en", "en"],
  ["100", "en", "en"],
  ["Explain please", "en", "en"],
  ["Send it", "en", "en"],
  ["Yes please", "en", "en"],
  ["What's next?", "en", "en"],
  ["Great", "en", "en"],
  ["Which template should I use for order updates?", "en"],
  ["How many contacts came from the Instagram ad?", "en"],
  ["Give me a list of customers who bought twice", "en"],
  ["Can you translate this reply for the customer?", "en"],
  ["The customer says the parcel is damaged, what should I reply?", "en"],
  ["Set up a welcome message for new chats", "en"],
  ["How long does Meta take to approve a template?", "en"],
  ["Turn on the chatbot for after-hours", "en"],
  ["Please show me the cost of yesterday's broadcast", "en"],
  ["Who changed the routing settings?", "en"],
  ["My display name was rejected, what now?", "en"],
  ["Do I need a payment method on WhatsApp?", "en"],
  ["Can you pause the main campaign until Monday?", "en"],
  ["Open the main menu settings", "en"],
  ["How much did we spend on ads in October?", "en"],
  ["Add Rahul to the sales team", "en"],
  ["Which chats have waited more than two hours?", "en"],
  ["Is the namaste template approved yet?", "en"],
  ["Show me the last 5 messages from Deepak", "en"],
  ["Please write a short thank you note for Diwali buyers", "en"],
  ["Who can delete templates in this workspace?", "en"],
  ["The bus timings changed, update the quick reply", "en"],
  ["Did anyone reply to Meena after 6 pm?", "en"],
  ["Tag everyone who asked about price today as hot lead", "en"],
  ["Can I export my contacts?", "en"],
  ["What happens when the monthly limit is used up?", "en"],
  ["Please stop the follow-up sequence for Arjun", "en"],
  ["Create a broadcast draft for the Holi sale", "en"],
  ["Is the AI agent replying to customers at night?", "en"],
  ["Show the approval requests from the ad assistant", "en"],
];

const HINDI: Case[] = [
  ["मेरा template approve हुआ?", "hi"],
  ["पिछले हफ़्ते कितनी नई चैट आईं?", "hi"],
  ["मेरा template reject क्यों हुआ?", "hi"],
  ["Riya को vip टैग कर दो", "hi"],
  ["Riya को मैसेज क्यों नहीं गया?", "hi"],
  ["इस ग्राहक को vip टैग कर दो", "hi"],
  ["इस चैट का सार बताइए", "hi"],
  ["इसका खर्च कितना होगा?", "hi"],
  ["आज क्या देखना है?", "hi"],
  ["इस महीने कितना बचा है?", "hi"],
  ["सारा खर्च रोक दो", "hi"],
  ["एक विनम्र जवाब लिखो", "hi"],
  ["दिवाली ऑफ़र का टेम्पलेट बनाइए", "hi"],
  ["कल वाले ब्रॉडकास्ट का क्या हुआ?", "hi"],
  ["कितने लोगों ने मैसेज पढ़ा?", "hi"],
  ["यह चैट प्रिया को दे दो", "hi"],
  ["मुझे बिना जवाब वाली चैट दिखाओ", "hi"],
  ["कौन से कॉन्टैक्ट ने मार्केटिंग के लिए हाँ नहीं कहा?", "hi"],
  ["24 घंटे की विंडो क्या होती है?", "hi"],
  ["मेरे नंबर की क्वालिटी कैसी है?", "hi"],
  ["WhatsApp नंबर कनेक्ट करना है", "hi"],
  ["मेरे भाई को टीम में जोड़ दो", "hi"],
  ["एरर 131047 का क्या मतलब है?", "hi"],
  ["अप्रूवल के लिए कौन से टेम्पलेट रुके हैं?", "hi"],
  ["दिल्ली वाले ग्राहकों का एक सेगमेंट बनाओ", "hi"],
  ["इस बातचीत को बंद कर दो", "hi"],
  ["अभी टीम में कौन ऑनलाइन है?", "hi"],
  ["इस चैट के लिए AI एजेंट बंद कर दो", "hi"],
  ["क्या अंजलि को पेमेंट रिमाइंडर गया?", "hi"],
  ["1,240 लोगों वाला ब्रॉडकास्ट क्यों अटका है?", "hi"],
  ["आज मेरे कितने AI क्रेडिट खर्च हुए?", "hi"],
  ["नोट लिखो कि ग्राहक को रिफ़ंड चाहिए", "hi"],
  ["सुरेश को ऑर्डर अपडेट वाला टेम्पलेट भेजो", "hi"],
  ["क्या कुछ मेरी मंज़ूरी के लिए रुका है?", "hi"],
  ["पिछले हफ़्ते के फ़ेल मैसेज दिखाओ", "hi"],
  ["रविवार सुबह के लिए ब्रॉडकास्ट तय कर सकते हैं?", "hi"],
  ["क्वालिटी रेटिंग कैसे सुधारें?", "hi"],
  ["खर्च की सीमा कहाँ सेट करें?", "hi"],
  ["मार्केटिंग और यूटिलिटी टेम्पलेट में क्या फ़र्क है?", "hi"],
  ["यह नंबर ब्लॉक कर दो, बहुत स्पैम भेजता है", "hi"],
  ["दुकान के समय के लिए क्विक रिप्लाई बनाओ", "hi"],
  ["पिछले हफ़्ते जवाब देने में कितना समय लगा?", "hi"],
  ["कविता से hot-lead टैग हटा दो", "hi"],
  ["रिजेक्ट हुए टेम्पलेट की मार्केटिंग में कॉपी बना दो", "hi"],
  ["इस महीने सबसे ज़्यादा चैट किसने संभालीं?", "hi"],
  ["शुक्रवार से कुर्ता सेल है, टेम्पलेट लिखो", "hi"],
  ["क्या ग्राहक ब्रॉडकास्ट का जवाब दे सकते हैं?", "hi"],
  ["फ़ेसबुक फ़ॉर्म वाले लीड दिखाओ", "hi"],
  ["आज इनबॉक्स इतना धीमा क्यों है?", "hi"],
  ["मेरी उपलब्धता बदल दो", "hi"],
  ["धन्यवाद", "hi", "en"],
  ["ठीक है", "hi", "en"],
  ["हाँ", "hi", "hinglish"],
  ["वापस लें", "hi", "hi"],
  ["भेज दो", "hi", "en"],
  ["रद्द करो", "hi", "hi"],
  ["और दिखाओ", "hi", "hi"],
  ["अभी नहीं", "hi", "hinglish"],
  ["बढ़िया, धन्यवाद", "hi", "hi"],
  ["अगला कदम?", "hi", "hi"],
  ["ok", "hi", "hi"],
  ["yes", "hi", "hi"],
  ["100", "hi", "hi"],
  ["Thanks", "hi", "hi"],
  ["haan", "hi", "hi"],
  ["समझाइए", "hi", "en"],
  ["हाँ जी", "hi", "hi"],
  ["नहीं", "hi", "en"],
  ["ऑर्डर अपडेट के लिए कौन सा टेम्पलेट ठीक रहेगा?", "hi"],
  ["Instagram ad से कितने कॉन्टैक्ट आए?", "hi"],
  ["दो बार खरीदने वाले ग्राहकों की लिस्ट दो", "hi"],
  ["ग्राहक कह रहा है पार्सल टूटा हुआ है, क्या जवाब दूँ?", "hi"],
  ["नई चैट के लिए स्वागत मैसेज सेट करो", "hi"],
  ["Meta टेम्पलेट अप्रूव करने में कितना समय लेता है?", "hi"],
  ["दुकान बंद होने के बाद chatbot चालू कर दो", "hi"],
  ["रूटिंग सेटिंग किसने बदली?", "hi"],
  ["मेरा display name रिजेक्ट हो गया, अब क्या करूँ?", "hi"],
  ["क्या WhatsApp पर पेमेंट मेथड चाहिए?", "hi"],
  ["सोमवार तक मुख्य कैंपेन रोक दो", "hi"],
  ["अक्टूबर में ऐड पर कितना खर्च हुआ?", "hi"],
  ["राहुल को सेल्स टीम में डालो", "hi"],
  ["किन चैट ने दो घंटे से ज़्यादा इंतज़ार किया?", "hi"],
  ["namaste टेम्पलेट अप्रूव हुआ क्या?", "hi"],
  ["दीपक के आख़िरी 5 मैसेज दिखाओ", "hi"],
  ["दिवाली खरीदारों के लिए छोटा सा धन्यवाद लिखो", "hi"],
  ["इस वर्कस्पेस में टेम्पलेट कौन डिलीट कर सकता है?", "hi"],
  ["बस का समय बदल गया, quick reply अपडेट करो", "hi"],
  ["शाम 6 बजे के बाद मीना को किसी ने जवाब दिया?", "hi"],
  ["आज जिन्होंने दाम पूछा उन्हें hot lead टैग करो", "hi"],
  ["मासिक सीमा खत्म होने पर क्या होता है?", "hi"],
  ["अर्जुन के लिए फ़ॉलो-अप बंद करो", "hi"],
  ["होली सेल के लिए ब्रॉडकास्ट ड्राफ़्ट बनाओ", "hi"],
  ["क्या AI एजेंट रात में ग्राहकों को जवाब दे रहा है?", "hi"],
  // Marathi and Nepali are also Devanagari: they get hi, the known limitation of 5.7 rule 6.
  ["माझा टेम्पलेट मंजूर झाला का?", "hi"],
  ["मेरो सन्देश किन गएन?", "hi"],
  ["ब्रॉडकास्ट का report भेजो", "hi"],
  ["इस contact का नंबर क्या है?", "hi"],
  ["template की category बदलनी है", "hi"],
  ["कुल कितने contacts हैं?", "hi"],
  ["ग्राहक का नाम बदल दो", "hi"],
];

const HINGLISH: Case[] = [
  ["isko sab opted-in logon ko bhej do", "hinglish"],
  ["isko bol do ki order kal tak pahunch jayega", "hinglish"],
  ["kal wale diwali offer ka kya hua? kitne logon ne padha?", "hinglish"],
  ["jo log aaj price puch rahe the unko hot-lead tag kar do", "hinglish"],
  ["AI agent ne aaj kya kiya?", "hinglish"],
  ["Is chat ka summary dijiye", "hinglish"],
  ["Kitna kharcha aayega?", "hinglish"],
  ["Aaj kya dekhna hai?", "hinglish"],
  ["mera template approve hua ya nahi?", "hinglish"],
  ["is mahine kitna bacha hai?", "hinglish"],
  ["saara kharcha rok do abhi", "hinglish"],
  ["ek polite reply likh do", "hinglish"],
  ["diwali offer ka template bana do", "hinglish"],
  ["kal wale broadcast ka kya hua?", "hinglish"],
  ["kitne logon ne message padha?", "hinglish"],
  ["yeh chat Priya ko de do", "hinglish"],
  ["mujhe bina reply wali chats dikhao", "hinglish"],
  ["kaun se contacts ne marketing ke liye haan nahi kaha?", "hinglish"],
  ["24 hour window kya hoti hai?", "hinglish"],
  ["mere number ki quality kaisi hai?", "hinglish"],
  ["WhatsApp number connect karna hai", "hinglish"],
  ["mere bhai ko team mein add kar do", "hinglish"],
  ["error 131047 ka kya matlab hai?", "hinglish"],
  ["approval ke liye kaun se templates ruke hain?", "hinglish"],
  ["Delhi wale customers ka ek segment bana do", "hinglish"],
  ["is conversation ko resolve kar do", "hinglish"],
  ["abhi team mein kaun online hai?", "hinglish"],
  ["is chat ke liye AI agent band kar do", "hinglish"],
  ["kya Anjali ko payment reminder gaya?", "hinglish"],
  ["1,240 logon wala broadcast kyun atka hai?", "hinglish"],
  ["aaj mere kitne AI credits kharch hue?", "hinglish"],
  ["note likho ki customer ko refund chahiye", "hinglish"],
  ["Suresh ko order update wala template bhejo", "hinglish"],
  ["kya kuch meri approval ke liye ruka hai?", "hinglish"],
  ["pichle hafte ke failed messages dikhao", "hinglish"],
  ["Sunday subah ke liye broadcast schedule kar sakte hain kya?", "hinglish"],
  ["quality rating kaise sudhare?", "hinglish"],
  ["spending limit kahan set karte hain?", "hinglish"],
  ["marketing aur utility template mein kya farak hai?", "hinglish"],
  ["yeh number block kar do, bahut spam bhejta hai", "hinglish"],
  ["dukaan ke time ke liye quick reply bana do", "hinglish"],
  ["pichle hafte reply karne mein kitna time laga?", "hinglish"],
  ["Kavita se hot-lead tag hata do", "hinglish"],
  ["reject hue template ki marketing mein copy bana do", "hinglish"],
  ["is mahine sabse zyada chats kisne sambhali?", "hinglish"],
  ["Friday se kurta sale hai, template likho", "hinglish"],
  ["kya customers broadcast ka reply kar sakte hain?", "hinglish"],
  ["Facebook form wale leads dikhao", "hinglish"],
  ["aaj inbox itna slow kyun hai?", "hinglish"],
  ["meri availability away kar do", "hinglish"],
  ["haan", "hinglish", "hinglish"],
  ["ok ji", "hinglish", "hinglish"],
  ["theek hai", "hinglish", "hinglish"],
  ["bhej do", "hinglish", "hinglish"],
  ["Undo kariye", "hinglish", "hinglish"],
  ["cancel karo", "hinglish", "hinglish"],
  ["aur dikhao", "hinglish", "hinglish"],
  ["abhi nahi", "hinglish", "hinglish"],
  ["accha, thanks", "hinglish", "hinglish"],
  ["ok", "hinglish", "hinglish"],
  ["yes", "hinglish", "hinglish"],
  ["100", "hinglish", "hinglish"],
  ["samjhaiye", "hinglish", "hinglish"],
  ["haan ji", "hinglish", "hinglish"],
  ["nahi", "hinglish", "hinglish"],
  ["template approve hua?", "hinglish", "hinglish"],
  ["order update ke liye kaun sa template sahi rahega?", "hinglish"],
  ["Instagram ad se kitne contacts aaye?", "hinglish"],
  ["do baar kharidne wale customers ki list do", "hinglish"],
  ["customer bol raha hai parcel toot gaya, kya reply karun?", "hinglish"],
  ["nayi chats ke liye welcome message set kar do", "hinglish"],
  ["Meta template approve karne mein kitna time leta hai?", "hinglish"],
  ["dukaan band hone ke baad chatbot chalu kar do", "hinglish"],
  ["routing settings kisne badli?", "hinglish"],
  ["mera display name reject ho gaya, ab kya karun?", "hinglish"],
  ["kya WhatsApp par payment method chahiye?", "hinglish"],
  ["Monday tak main campaign rok do", "hinglish"],
  ["October mein ads par kitna kharcha hua?", "hinglish"],
  ["Rahul ko sales team mein daalo", "hinglish"],
  ["kin chats ne do ghante se zyada wait kiya?", "hinglish"],
  ["namaste template approve hua kya?", "hinglish"],
  ["Deepak ke last 5 messages dikhao", "hinglish"],
  ["Diwali buyers ke liye chhota sa thank you likh do", "hinglish"],
  ["is workspace mein template kaun delete kar sakta hai?", "hinglish"],
  ["bus ka time badal gaya, quick reply update kar do", "hinglish"],
  ["shaam 6 baje ke baad Meena ko kisi ne reply kiya?", "hinglish"],
  ["monthly limit khatam hone par kya hota hai?", "hinglish"],
  ["Arjun ke liye follow-up band kar do", "hinglish"],
  ["Holi sale ke liye broadcast draft bana do", "hinglish"],
  ["kya AI agent raat mein customers ko reply kar raha hai?", "hinglish"],
  ["bhai yeh broadcast kab jayega?", "hinglish"],
  ["main kya karun, template baar baar reject ho raha hai", "hinglish"],
  ["sabko offer bhejna hai par kharcha kam rakhna hai", "hinglish"],
  ["mujhe samajh nahi aa raha ki quality red kyun hai", "hinglish"],
  ["customer bahut pareshan hai, kisi insaan se baat karni hai", "hinglish"],
  ["abhi ke abhi sab ads band karo", "hinglish"],
  ["kitne contacts ne opt out kiya hai?", "hinglish"],
  ["Ramesh ka last message kya tha?", "hinglish"],
  ["is template mein discount wali line hata do", "hinglish"],
  ["kal se naya price lagega, sabko bata do", "hinglish"],
];

const ALL: { text: string; expected: EddyLang; prev: EddyLang | null; set: string }[] = [
  ...ENGLISH.map(([text, expected, prev]) => ({ text, expected, prev: prev ?? null, set: "en" })),
  ...HINDI.map(([text, expected, prev]) => ({ text, expected, prev: prev ?? null, set: "hi" })),
  ...HINGLISH.map(([text, expected, prev]) => ({ text, expected, prev: prev ?? null, set: "hinglish" })),
];

describe("the labelled set (5.7 accuracy bar)", () => {
  it("has 300 messages: 100 per language, with code-mixed and 1-2 word messages", () => {
    expect(ENGLISH).toHaveLength(100);
    expect(HINDI).toHaveLength(100);
    expect(HINGLISH).toHaveLength(100);
    const short = ALL.filter((c) => c.text.trim().split(/\s+/).length <= 2);
    expect(short.length).toBeGreaterThanOrEqual(45);
    const codeMixedHindi = HINDI.filter(([t]) => /[A-Za-z]{3,}/.test(t));
    expect(codeMixedHindi.length).toBeGreaterThanOrEqual(15);
  });

  it("is at least 97% accurate overall and in each language", () => {
    const misses = ALL.filter((c) => detectLanguage(c.text, c.prev, "auto").lang !== c.expected);
    const accuracy = 1 - misses.length / ALL.length;
    expect(accuracy, `misses:\n${misses.map((m) => `${m.set}: ${m.text} -> ${detectLanguage(m.text, m.prev, "auto").lang}`).join("\n")}`).toBeGreaterThanOrEqual(0.97);
    for (const set of ["en", "hi", "hinglish"]) {
      const inSet = ALL.filter((c) => c.set === set);
      const wrong = misses.filter((c) => c.set === set).length;
      expect(1 - wrong / inSet.length, `${set} accuracy`).toBeGreaterThanOrEqual(0.95);
    }
  });
});

describe("the rules of 5.7", () => {
  it("rule 1: a saved preference other than auto wins", () => {
    expect(detectLanguage("How many chats?", null, "hi")).toMatchObject({ lang: "hi", confidence: "high", reason: "pref" });
    expect(detectLanguage("मेरा template approve हुआ?", "hi", "en").lang).toBe("en");
    expect(detectLanguage("kitna kharcha aayega", null, "hinglish").lang).toBe("hinglish");
    // A preference also wins over an unsupported script (the member chose it).
    expect(detectLanguage("என் டெம்ப்ளேட் நிலை என்ன?", null, "hi")).toMatchObject({ lang: "hi", unsupported: false });
  });

  it("rule 2: code spans, URLs, emails, numbers, mentions and template names are stripped", () => {
    const s = stripForDetection("Send `kya hai` to @kal https://kal.example/kya me@kya.in 12,345 diwali_kya_offer", ["promo"]);
    expect(s).not.toMatch(/kya|kal|12/);
    expect(stripForDetection("send hai_kya and promo kar", ["promo"])).not.toMatch(/promo|hai_kya/);
    // A template named with Hindi words does not make an English message Hinglish.
    expect(detectLanguage("Send kya_hai_offer and abhi_nahi to everyone tonight", null, "auto").lang).toBe("en");
    expect(detectLanguage("Is the haan ji template approved yet?", null, "auto", { templateNames: ["haan ji"] }).lang).toBe("en");
  });

  it("rule 3: 30% Devanagari letters is Hindi, with Latin product words inside", () => {
    expect(detectLanguage("मेरा template approve हुआ?", "en", "auto")).toMatchObject({ lang: "hi", confidence: "high" });
    const counts = scriptCounts("मेरा template");
    expect(counts.devanagari).toBe(4);
    expect(counts.latin).toBe(8);
  });

  it("rule 4: needs 2 hits and 20% of the words; English collisions do not count", () => {
    expect(hinglishHits(latinWords("to me he band par the do in us is"))).toBe(0);
    expect(hinglishHits(latinWords("main menu"))).toBe(0);
    expect(hinglishHits(latinWords("main kya karun"))).toBe(3);
    expect(hinglishHits(latinWords("bana do"))).toBe(2);
    expect(hinglishHits(latinWords("what do you need"))).toBe(0);
    expect(detectLanguage("Send the broadcast to me in the main menu and do it", null, "auto").lang).toBe("en");
    // One hit in a long English message is still English.
    expect(detectLanguage("Please send the new kurta catalogue to all wholesale buyers before Friday evening, ji", null, "auto").lang).toBe("en");
    expect(HINGLISH_LEXICON.size).toBeGreaterThanOrEqual(180);
  });

  it("rule 5: messages of 2 words or fewer keep the previous language with low confidence", () => {
    for (const prev of ["en", "hi", "hinglish"] as const) {
      for (const text of ["ok", "yes", "haan", "100", "send it", "thanks ji"]) expect(detectLanguage(text, prev, "auto"), `${text} after ${prev}`).toMatchObject({ lang: prev, confidence: "low" });
    }
    // With no previous language a short message falls back to its own words.
    expect(detectLanguage("ok", null, "auto").lang).toBe("en");
    expect(detectLanguage("haan ji", null, "auto").lang).toBe("hinglish");
    // A short Devanagari message follows its script.
    expect(detectLanguage("धन्यवाद", "en", "auto")).toMatchObject({ lang: "hi", confidence: "high" });
  });

  it("rule 6: another script gets English with the unsupported line; Marathi and Nepali get Hindi", () => {
    for (const text of ["என் டெம்ப்ளேட் நிலை என்ன?", "আমার মেসেজ কেন যায়নি?", "મારો ટેમ્પલેટ મંજૂર થયો?", "میرا پیغام کیوں نہیں گیا؟", "ਮੇਰਾ ਸੁਨੇਹਾ ਕਿਉਂ ਨਹੀਂ ਗਿਆ?"]) {
      expect(detectLanguage(text, "hinglish", "auto"), text).toMatchObject({ lang: "en", unsupported: true, reason: "other_script" });
    }
    expect(detectLanguage("माझा टेम्पलेट मंजूर झाला का?", null, "auto")).toMatchObject({ lang: "hi", unsupported: false });
    expect(detectLanguage("How many chats?", null, "auto").unsupported).toBe(false);
  });

  it("an empty or emoji-only message keeps the previous language", () => {
    expect(detectLanguage("", "hi", "auto")).toMatchObject({ lang: "hi", reason: "empty" });
    expect(detectLanguage("   ", null, "auto").lang).toBe("en");
    expect(detectLanguage("1,240 ₹2,500", "hinglish", "auto").lang).toBe("hinglish");
  });

  it("reply scripts", () => {
    expect(replyScript("hi")).toBe("Devanagari");
    expect(replyScript("hinglish")).toBe("Latin");
    expect(replyScript("en")).toBe("Latin");
  });
});

describe("customerLanguage over the last 5 inbound messages (5.7, 2.4)", () => {
  it("follows the majority of the last 5 messages", () => {
    expect(customerLanguage(["Hello", "Is the shop open today?", "What time do you close?"])).toBe("en");
    expect(customerLanguage(["नमस्ते", "मेरा ऑर्डर कब आएगा?", "कृपया जल्दी बताइए"])).toBe("hi");
    expect(customerLanguage(["bhaiya order kab aayega?", "kal tak mil jayega kya?", "jaldi bata do"])).toBe("hinglish");
  });

  it("looks only at the newest 5 messages", () => {
    const old = ["Hello", "Thanks for the update", "Can I change the size?", "Please confirm the address", "Where is my order?"];
    const recent = ["मेरा ऑर्डर कब आएगा?", "कृपया जल्दी बताइए", "पैसे कट गए हैं", "रिफ़ंड चाहिए", "जवाब दीजिए"];
    expect(customerLanguage([...old, ...recent])).toBe("hi");
    expect(customerLanguage([...recent].reverse().concat([...old].reverse()), { newestFirst: true })).toBe("hi");
  });

  it("is English with no messages, and counts an unsupported script as English", () => {
    expect(customerLanguage([])).toBe("en");
    expect(customerLanguage(["என் ஆர்டர் எங்கே?"])).toBe("en");
  });

  it("short replies keep the customer's language", () => {
    expect(customerLanguage(["mera order kab aayega bhaiya?", "ok", "haan"])).toBe("hinglish");
  });
});
