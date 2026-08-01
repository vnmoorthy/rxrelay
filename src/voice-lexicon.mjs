/**
 * Runtime helpers built on src/voice-training/lexicon.json.
 * Keeps script variants, status-question memory, and lightweight intent scoring
 * dependency-light for the live TeXML path.
 */
import {
  loadVoiceLexicon,
  lexiconAsrRepairs,
  fewShotPromptBlock,
  lexiconIntentHint,
  lexiconConsentParse,
  exemplarReplyFor,
} from "./voice-training/index.mjs";

export {
  loadVoiceLexicon,
  lexiconAsrRepairs,
  fewShotPromptBlock,
  lexiconIntentHint,
  lexiconConsentParse,
  exemplarReplyFor,
};

/** Combined ASR repairs: JSON lexicon first (longer phrases), then local extras. */
export function allAsrRepairs() {
  return lexiconAsrRepairs();
}

/** Status questions Maya should not re-ask once already spoken. */
export const STATUS_QUESTION_PATTERNS = {
  ready: /want me to start|kick off the pharmacy|start coordinating|pharmacy status check now/i,
  coordinating: /what did the pharmacy|any word from the pharmacy|what are they saying/i,
  waiting_clinic: /clinic submitted|doctor'?s office on the pa|clinic file/i,
  waiting_pharmacy: /ready for pickup|ready to pick|come get it/i,
  ask_consent: /want me to (help|check|start)|say (you want|yes)|pharmacy status check/i,
};

/**
 * Rotating short scripts keyed by action / status.
 * Action acks are first-person "I've done X / I'm doing Y" — Maya just DID
 * the work, so she says so and asks one forward-moving question.
 * ctx.pharmacy is a suffix like " at CVS"; ctx.pharmacyName is the bare name.
 */
export const SCRIPT_VARIANTS = {
  consent: [
    (ctx) => `Thanks — I've recorded your okay and opened case ${ctx.caseId}. What has ${ctx.pharmacyName || "the pharmacy"} told you so far?`,
    (ctx) => `You're covered — consent is on file for ${ctx.caseId}. What did ${ctx.pharmacyName || "the pharmacy"} say?`,
    (ctx) => `Consent noted for ${ctx.caseId}. What's the latest from ${ctx.pharmacyName || "the pharmacy"}?`,
  ],
  start_coordination: [
    (ctx) => `Got it — I've got your okay and I'm checking status with ${ctx.pharmacyName || "the pharmacy"}${ctx.med ? ` on your${ctx.med}` : ""} now. What did they tell you?`,
    (ctx) => `On it — I've opened your case and I'm on the${ctx.pharmacy} status now. What did they say is holding it up?`,
    (ctx) => `I'm checking with ${ctx.pharmacyName || "the pharmacy"} right now. Prior auth, insurance, or ready — whichever they told you.`,
  ],
  pharmacy_blocker: [
    (ctx) => `I've logged that ${ctx.pharmacyName || "the pharmacy"} needs prior auth, and noted we're waiting on your clinic. Has your doctor filed it yet?`,
    () => "PA hold is on the record — I've marked us waiting on your clinic. Has your doctor filed it yet?",
    () => "I've recorded the prior auth hold. Tell me the moment your doctor's office files it.",
  ],
  clinic_submission: [
    () => "Perfect — I've recorded that the clinic filed the PA, and I'm pushing it back to the pharmacy for fill confirmation. Tell me when they say it's ready.",
    (ctx) => `Clinic filing recorded. I'm following up with ${ctx.pharmacyName || "the pharmacy"} for fill confirmation — tell me when they say it's ready.`,
    () => "I've logged the clinic's PA submission and flagged the pharmacy for fill confirmation. Let me know when it's ready.",
  ],
  pharmacy_ready: [
    (ctx) => `Great news — I've confirmed it's ready for pickup and sent your status update. You can pick it up${ctx.pharmacy || " at the pharmacy"} today — call them for the exact window. You're all set.`,
    (ctx) => `I've marked it ready and your text update just went out. Same-day pickup${ctx.pharmacy} — call them for the exact window. You're all set.`,
    () => "Done — pickup readiness is confirmed and your status update is sent. It's usually same-day once marked ready. You're all set.",
  ],
  vent: [
    () => exemplarReplyFor("vent") || "I hear you — that runaround is exhausting. What's the latest from the pharmacy?",
    () => "Totally fair to be frustrated. What did they tell you most recently?",
    () => "I'm with you. Let's cut the back-and-forth — what did the pharmacy say?",
  ],
  vent_no_consent: [
    () => "I hear you. I can take the status chase off your plate — want me to help with the pharmacy follow-up?",
    () => "That sounds rough. Say the word and I'll start a pharmacy status check for you.",
  ],
  ready: [
    () => "Want me to start a pharmacy status check now?",
    () => "I can kick off the pharmacy follow-up whenever you're ready.",
    () => "Shall I start coordinating with the pharmacy?",
  ],
  coordinating: [
    () => "What did the pharmacy tell you?",
    () => "Any word from the pharmacy yet — PA, insurance, or ready?",
    () => "What are they saying is next?",
  ],
  waiting_clinic: [
    () => "Has your clinic submitted the prior auth yet?",
    () => "Any update from your doctor's office on the PA?",
    () => "Did the clinic file it, or still waiting?",
  ],
  waiting_pharmacy: [
    () => "Has the pharmacy said it's ready for pickup?",
    () => "Any confirmation it's ready to pick up?",
    () => "Did they say you can come get it yet?",
  ],
  ask_consent: [
    () => "Happy to help. Just say you want me to check your pharmacy status, and I'll take it from there.",
    () => "I can chase pharmacy status for you — want me to start?",
    () => "Say yes to a pharmacy status check and I'll open your case.",
  ],
};

export function pickVariant(key, turnIndex = 0, ctx = {}) {
  const list = SCRIPT_VARIANTS[key];
  if (!list?.length) return null;
  const fn = list[Math.abs(turnIndex) % list.length];
  return typeof fn === "function" ? fn(ctx) : fn;
}

/**
 * Lightweight scorer over JSON intent phrase banks.
 * Fast, dependency-free — complements regex cascade.
 */
export function scoreIntent(transcript = "") {
  const t = String(transcript || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return { intent: "chat", score: 0, confidence: 0 };
  // Pure consent legalese must not score as start_coordination via status/follow-up words.
  const pureConsent = /\bi\s+consent\b|\bi\s+give\s+(?:you\s+)?permission\b|\byou\s+have\s+my\s+permission\b/i.test(t)
    && !/\b(check|please help|help me|can you help|can you check|stuck|been waiting|find out|look into|what'?s going on|chase|track)\b/i.test(t);
  const phrases = loadVoiceLexicon().intentPhrases || {};
  let best = { intent: "chat", score: 0 };
  const weights = {
    escalate: 10,
    vent: 6,
    ask_options: 5,
    summarize: 5,
    off_topic: 8,
    clinic_submission: 9,
    pharmacy_ready: 9,
    pharmacy_blocker: 8,
    still_waiting: 5,
    start_coordination: 7,
    thanks: 4,
  };
  for (const [intent, list] of Object.entries(phrases)) {
    if (pureConsent && intent === "start_coordination") continue;
    let hits = 0;
    let weightSum = 0;
    for (const phrase of list || []) {
      if (t.includes(String(phrase).toLowerCase())) {
        hits += 1;
        weightSum += String(phrase).split(/\s+/).length;
      }
    }
    if (!hits) continue;
    const score = hits * (weights[intent] || 5) + weightSum * 0.35;
    if (score > best.score) best = { intent, score, hits };
  }
  const confidence = Math.min(1, best.score / 14);
  if (best.score < 4) return { intent: "chat", score: best.score, confidence: 0 };
  return { intent: best.intent, score: best.score, confidence };
}

export function formatFewShotBlock(limit = 8) {
  return fewShotPromptBlock(limit) || "";
}
