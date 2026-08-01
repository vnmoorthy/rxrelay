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

/** Rotating short scripts keyed by action / status. */
export const SCRIPT_VARIANTS = {
  consent: [
    (ctx) => `Thanks — I've got your okay for status follow-up. Your case is ${ctx.caseId}. What's going on with the${ctx.med} prescription${ctx.pharmacy}?`,
    (ctx) => `Consent noted for ${ctx.caseId}. Tell me about the${ctx.med} situation${ctx.pharmacy}.`,
    (ctx) => `You're covered for status help — case ${ctx.caseId}. What should I know about the${ctx.med} Rx${ctx.pharmacy}?`,
  ],
  start_coordination: [
    (ctx) => exemplarReplyFor("start_coordination")
      || `Okay, I've started a pharmacy status check${ctx.pharmacy}. When you hear back, tell me what they said — PA hold, insurance, or ready.`,
    (ctx) => `On it — coordinating${ctx.pharmacy} now. What did they say is holding things up?`,
    (ctx) => `Status check started${ctx.pharmacy}. Prior auth, insurance, or ready for pickup — whichever they told you.`,
  ],
  pharmacy_blocker: [
    () => exemplarReplyFor("pharmacy_blocker") || "Got it — prior authorization is on the record. Tell me when your doctor or clinic files it.",
    () => "PA hold recorded. Has your clinic submitted it yet, or still waiting?",
    () => "Understood — they're waiting on prior auth. Ping me when the doctor's office files it.",
  ],
  clinic_submission: [
    () => exemplarReplyFor("clinic_submission") || "Thanks — clinic submission is recorded. Let me know when the pharmacy says it's ready for pickup.",
    () => "Clinic filing noted. Has the pharmacy confirmed ready yet?",
    () => "Got the clinic step. Tell me when they say you can pick it up.",
  ],
  pharmacy_ready: [
    () => exemplarReplyFor("pharmacy_ready") || "Great news — readiness is recorded and I sent your status update. Anything else before we wrap up?",
    () => "You're all set — ready for pickup is confirmed and your update went out.",
    () => "Confirmed ready. Status update sent. You can hang up whenever you're done.",
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
