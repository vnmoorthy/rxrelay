/**
 * Conversational dialogue layer for inbound voice.
 * Feels like a real coordinator: empathy, memory, multi-context turns —
 * while still advancing the proof-gated access task.
 */

import {
  allAsrRepairs,
  STATUS_QUESTION_PATTERNS,
  pickVariant,
  scoreIntent,
  lexiconIntentHint,
  lexiconConsentParse,
} from "./voice-lexicon.mjs";

export function sayVoiceAttrs() {
  const voice = process.env.TEXML_VOICE || "Polly.Joanna-Neural";
  const speed = process.env.TEXML_VOICE_SPEED || "0.92";
  return ` voice="${voice}" voiceSpeed="${speed}"`;
}

/** Short greeting — phone callers hang up on menu dumps. */
export function openPrompt() {
  return [
    "Hi, this is Maya with RxRelay.",
    "I help with pharmacy status and prior auth — I can't give medical advice.",
    "What's going on with your medication?",
  ].join(" ");
}

export function noInputPrompt() {
  return "Sorry, I didn't catch that. What's going on with your prescription?";
}

/**
 * Gate STT before intent/state advances.
 * Empty, filler, punctuation-only, or very low-confidence audio must not move the proof trail.
 */
export function isUsableSpeech(transcript = "", asrConfidence = 1) {
  const text = normalizeTranscript(transcript);
  if (!text) return { ok: false, reason: "empty", text: "" };

  const confidence = Number(asrConfidence);
  if (Number.isFinite(confidence) && confidence > 0 && confidence < 0.45) {
    return { ok: false, reason: "low_confidence", text };
  }

  if (/^[^a-z0-9]+$/i.test(text)) return { ok: false, reason: "noise", text };

  const compact = text.toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
  const fillerTok = String.raw`um+|uh+|hm+|hmm+|ah+|oh+|mhm+|mm+|huh|what|sorry|okay|ok|yeah|yep|yup|nah|nope`;
  const fillerOnly = new RegExp(`^(${fillerTok})(\\s+(${fillerTok}))*$`, "i");
  if (fillerOnly.test(compact)) return { ok: false, reason: "filler", text };

  const words = compact.split(/\s+/).filter(Boolean);
  if (words.length === 1 && words[0].length <= 2) return { ok: false, reason: "too_short", text };

  const content = /\b(help|please|pharmacy|prescription|medication|meds?|refill|prior|auth|pa|ready|pickup|doctor|clinic|insurance|cvs|walgreens|stuck|waiting|consent|metformin|filed|submitted|check|status|human|agent)\b/i;
  if (words.length <= 1 && !content.test(compact) && !/\b(hi|hello|hey|thanks|thank)\b/i.test(compact)) {
    return { ok: false, reason: "too_short", text };
  }

  return { ok: true, reason: "ok", text };
}

export function humanHandoffPrompt() {
  return "Of course. I'm connecting you with a human coordinator now, and I won't take any more automated steps.";
}

/**
 * Normalize common ASR mishears so intent matching stays reliable on phone audio.
 * (No model fine-tune needed — TeXML STT + phrase repair is the right layer.)
 */
export function normalizeTranscript(transcript = "") {
  let t = String(transcript || "").replace(/\s+/g, " ").trim();
  for (const [pattern, replacement] of allAsrRepairs()) t = t.replace(pattern, replacement);
  return t;
}

/** Soft next-step nudge for the model — not spoken verbatim every turn. */
export function goalForStatus(statusKey, { consented = false } = {}) {
  if (!consented || statusKey === "intake") {
    return "If they want help with pharmacy/prescription status, treat that as consent, acknowledge, and move on. Ask at most one clarifying fact. Do NOT re-ask consent once recorded.";
  }
  if (statusKey === "ready") {
    return "Acknowledge their situation and start a pharmacy status check when they want progress or clearly describe being stuck. Ask only what the pharmacy said next — one question max.";
  }
  if (statusKey === "coordinating") {
    return "Acknowledge, then capture what the pharmacy said (PA hold, insurance, or ready) — one question only if needed. Do not invent outcomes.";
  }
  if (statusKey === "waiting_clinic") {
    return "Acknowledge the PA hold. Ask once whether the clinic/doctor filed it — skip if they already answered.";
  }
  if (statusKey === "waiting_pharmacy") {
    return "Acknowledge clinic filing. Ask once whether the pharmacy confirmed ready for pickup — skip if they already answered.";
  }
  if (statusKey === "awaiting_update" || statusKey === "resolved") {
    return "Confirm completion warmly (pickup ready + update sent). Do not restart the status trail.";
  }
  if (statusKey === "human_review") {
    return "Reassure them a human owns the case; do not automate further.";
  }
  return "Acknowledge, act on facts, ask one next fact only when needed.";
}

export function optionsForStatus(statusKey, { consented = false } = {}) {
  return goalForStatus(statusKey, { consented });
}

export function extractCallerNotes(transcript = "") {
  const t = String(transcript);
  const notes = {};
  const pharmacy = t.match(/\b(?:at|from|with)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\s+(?:pharmacy|drugstore)\b/)
    || t.match(/\b(CVS|Walgreens|Rite Aid|Costco|Walmart)\b/i)
    || t.match(/\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\s+pharmacy\b/i);
  if (pharmacy) notes.pharmacyName = pharmacy[1].replace(/\bpharmacy\b/i, "").trim();
  const med = t.match(/\b(?:for|on|of)\s+(?:my\s+)?([a-z][a-z0-9-]{2,})\b/i);
  if (med && !/status|pharmacy|clinic|insurance|prescription|medication|update|follow|pickup|doctor/.test(med[1])) {
    notes.medicationHint = med[1];
  }
  const days = t.match(/\b(\d+)\s+days?\b/i);
  if (days) notes.waitDays = Number(days[1]);
  return notes;
}

/**
 * Regex cascade for high-precision intents (order matters).
 * Lexicon scorer can override when confidence is high and regex is chat.
 */
function detectIntentRegex(transcript = "", statusKey = "intake") {
  const t = normalizeTranscript(transcript).toLowerCase();

  if (/\b(human|agent|representative|real person|operator|escalate|talk to (a |someone|a person)|speak (to|with) (a )?(person|human|someone)|transfer me|get me (a )?(person|human))\b/.test(t)) {
    return "escalate";
  }
  if (/\b(i'?m (so )?(frustrated|stressed|scared|worried|upset|overwhelmed|exhausted)|this is ridiculous|nobody (is )?helping|i'?ve been calling|fed up|losing (my )?mind|going in circles|runaround|sick of calling)\b/.test(t)) {
    return "vent";
  }
  if (/\b(what can you (do|help with)|what are my (options|choices)|how does this work|who are you|what do you do)\b/.test(t)) {
    return "ask_options";
  }
  if (/\b(summarize|summary|where (are|is) (we|my case)|recap|catch me up|what happened so far|status of my case)\b/.test(t)) {
    return "summarize";
  }
  if (/\b(weather|sports|joke|who won|password|social security|credit card)\b/.test(t)) {
    return "off_topic";
  }
  if (/\b(clinic (submitted|sent|filed|did)|pa (was )?(submitted|filed|sent)|authorization (was )?(submitted|filed)|doctor (sent|filed|took care|submitted)|my (doctor|clinic|prescriber) (already )?(sent|filed|submitted)|they filed (the )?(pa|prior)|doc(tor)? (took|handled) (it|care of it)|office (submitted|filed)|filed (the )?(pa|prior))\b/.test(t)) {
    return "clinic_submission";
  }
  if (/\b(ready for pickup|ready to pick ?up|prescription is ready|meds? (are|is) ready|i can pick (it )?up|said (it'?s|it is) ready|it'?s ready|they (said|say) (it'?s |it is )?ready|confirmed ready|filled and ready|ready at the pharmacy)\b/.test(t)) {
    return "pharmacy_ready";
  }
  if (/\b(prior auth|prior authorization|needs? (a )?pa|blocker|insurance (needs|required|wants|holding|won'?t)|pa needed|waiting on (insurance|pa|the pa)|on hold|denied|can'?t fill|won'?t fill|need(s)? (the )?doctor|holding (it|things) up|before they can fill)\b/.test(t)) {
    return "pharmacy_blocker";
  }
  if (/\b(still waiting|no update|nothing yet|not yet|no word|haven'?t heard|still nothing|no news)\b/.test(t)) {
    return "still_waiting";
  }
  if (statusKey === "ready" || statusKey === "intake" || !statusKey) {
    const pureConsent = /\bi\s+consent\b|\bi\s+give\s+(?:you\s+)?permission\b|\byou\s+have\s+my\s+permission\b/i.test(t)
      && !/\b(check|please help|help me|can you help|stuck|been waiting|find out|look into|what'?s going on|chase|track)\b/i.test(t);
    if (!pureConsent && /\b(check|status|follow[\s-]?up|call (the )?pharmacy|coordinate|what'?s going on|find out|look into|any update|can you help|please help|help me|stuck|can'?t get my|been waiting|help me (with|get)|figure out|see what'?s (up|happening)|chase|track|help with (my )?(prescription|medication|meds|pharmacy)|been stuck)\b/.test(t)) {
      return "start_coordination";
    }
  }
  if (statusKey === "coordinating" && /\b(update|heard back|they said|pharmacy said)\b/.test(t)) {
    return "chat";
  }
  if (/\b(thank(s| you)|that('?s| is) all|goodbye|bye|i'?m good|that'?s it|all set)\b/.test(t)) {
    return "thanks";
  }
  return "chat";
}

/**
 * Status-aware intent detection: regex cascade + JSON lexicon hint + scorer.
 */
export function detectConversationalIntent(transcript = "", statusKey = "intake") {
  const spoken = normalizeTranscript(transcript);
  const regexIntent = detectIntentRegex(spoken, statusKey);
  if (regexIntent !== "chat") return regexIntent;

  const hint = lexiconIntentHint(spoken, statusKey);
  if (hint) return hint;

  const scored = scoreIntent(spoken);
  if (scored.confidence >= 0.45 && scored.intent !== "chat") return scored.intent;
  return "chat";
}

/**
 * Consent for demo-grade phone UX:
 * - Explicit "I consent…" still works
 * - Asking for help with a prescription / pharmacy status is treated as scoped yes
 */
export function consentFromTranscript(transcript = "") {
  const t = normalizeTranscript(transcript);
  const fromLexicon = lexiconConsentParse(t);
  if (fromLexicon.granted) return fromLexicon;

  const declines = /\b(i do not consent|i don't consent|no consent|do not (call|text|coordinate)|i decline|leave me alone|stop calling)\b/i.test(t);
  if (declines) return { granted: false, scoped: true };

  const saysConsent = /\b(i\s+consent|i\s+give\s+(?:you\s+)?permission|yes[,\s]+you\s+(?:may|can)|you\s+have\s+my\s+permission|go ahead|yes[,\s]+please(\s+(check|coordinate|follow|help))?|that'?s fine|that is fine|you can (check|call|coordinate|text|help)|sure[,.]?\s+(you can|go ahead|please)?|okay[,.]?\s+(you can|go ahead|please)?|i agree|sounds good|please do|yes please)\b/i.test(t);
  const scoped = /\b(pharmacy|status|coordinate|text|update|follow[\s-]?up|prescription|medication|meds?|refill|prior auth|access|help (me )?(with|on|get)|stuck|waiting)\b/i.test(t)
    || /\b(go ahead|yes[,\s]+please|i agree|sure|sounds good)\b/i.test(t);
  const softAsk = /\b(please help|can you help|can you check|could you check|please check|i need help|help me|i need you to|could you|would you|look into)\b/i.test(t)
    && /\b(pharmacy|prescription|medication|meds?|refill|prior auth|status|pickup)\b/i.test(t);
  const storyConsent = /\b(been waiting|been stuck|can'?t (get|pick)|stuck (at|with|on)|pharmacy (has|won'?t|can'?t)|need (my|the) (meds?|medication|prescription))\b/i.test(t);

  return {
    granted: Boolean((saysConsent && scoped) || softAsk || (storyConsent && scoped)),
    scoped: Boolean(scoped || softAsk || storyConsent),
    saysConsent: Boolean(saysConsent),
    softAsk: Boolean(softAsk || storyConsent),
  };
}

function assistantTurns(turns = []) {
  return turns.filter((turn) => turn?.role === "assistant" && turn?.text);
}

function lastAssistantText(turns = []) {
  const list = assistantTurns(turns);
  return list.length ? String(list[list.length - 1].text) : "";
}

/** Last N assistant spoken lines (newest last). */
export function lastAssistantLines(turns = [], n = 2) {
  return assistantTurns(turns).slice(-n).map((turn) => String(turn.text));
}

function normSpeech(s = "") {
  return String(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Avoid repeating an *identical* spoken line only — keep good LLM paraphrases. */
export function avoidRepeat(reply, conversationTurns = []) {
  const recent = lastAssistantLines(conversationTurns, 2).map(normSpeech).filter(Boolean);
  const next = String(reply || "").trim();
  if (!recent.length || !next) return next;
  const b = normSpeech(next);
  if (recent.includes(b)) {
    return "Got it — I'm still with you. What else should I know?";
  }
  return next;
}

/**
 * Strip / rewrite replies that re-ask for consent or the same status question.
 */
export function enforceMemoryGuards(reply, {
  consented = false,
  statusKey = "intake",
  conversationTurns = [],
  askedStatusQuestions = {},
} = {}) {
  let text = String(reply || "").trim();
  if (!text) return text;

  if (consented) {
    // Never re-ask for consent / permission once granted
    if (/\b(do you consent|say:?\s*i consent|please (say|confirm) (you )?consent|consent to (a )?pharmacy|want me to (get your|record) (consent|permission)|need your (consent|permission))\b/i.test(text)) {
      text = statusKey === "ready" || statusKey === "intake"
        ? pickVariant("ready", conversationTurns.length) || "Want me to start a pharmacy status check now?"
        : "Consent is already on file. What's the latest update?";
    }
  }

  const pattern = STATUS_QUESTION_PATTERNS[statusKey]
    || (consented ? null : STATUS_QUESTION_PATTERNS.ask_consent);
  const alreadyAsked = askedStatusQuestions?.[statusKey]
    || (!consented && askedStatusQuestions?.ask_consent);
  if (pattern && alreadyAsked && pattern.test(text)) {
    const alts = {
      ready: "I'm ready when you are — just say if you want the pharmacy check started.",
      coordinating: "I'm listening for whatever the pharmacy told you.",
      waiting_clinic: "Whenever you hear from the clinic on the PA, tell me.",
      waiting_pharmacy: "I'll wait for the ready-for-pickup confirmation from you.",
      ask_consent: "Whenever you're ready, say you want a pharmacy status check.",
    };
    text = alts[statusKey] || alts.ask_consent || "Okay — go ahead whenever you're ready.";
  }

  return avoidRepeat(text, conversationTurns);
}

/** Track which status questions Maya has already asked. */
export function markAskedStatusQuestion(reply, statusKey, asked = {}) {
  const next = { ...asked };
  const pattern = STATUS_QUESTION_PATTERNS[statusKey];
  if (pattern && pattern.test(String(reply || ""))) next[statusKey] = true;
  if (STATUS_QUESTION_PATTERNS.ask_consent.test(String(reply || ""))) next.ask_consent = true;
  return next;
}

export function scriptedConversationalReply({
  statusKey,
  consented,
  action = null,
  intent = "chat",
  caseId,
  humanReview = false,
  notes = {},
  conversationTurns = [],
  askedStatusQuestions = {},
} = {}) {
  if (humanReview) return humanHandoffPrompt();
  const turnIndex = conversationTurns.length;
  const ctx = {
    caseId,
    pharmacy: notes.pharmacyName ? ` at ${notes.pharmacyName}` : "",
    med: notes.medicationHint ? ` ${notes.medicationHint}` : "",
  };

  if (action === "consent") {
    return pickVariant("consent", turnIndex, ctx);
  }
  if (action === "start_coordination") {
    return pickVariant("start_coordination", turnIndex, ctx);
  }
  if (action === "pharmacy_blocker") {
    return pickVariant("pharmacy_blocker", turnIndex, ctx);
  }
  if (action === "clinic_submission") {
    return pickVariant("clinic_submission", turnIndex, ctx);
  }
  if (action === "pharmacy_ready") {
    return pickVariant("pharmacy_ready", turnIndex, ctx);
  }
  if (action === "escalate") return humanHandoffPrompt();

  if (intent === "vent") {
    return consented
      ? pickVariant("vent", turnIndex, ctx)
      : pickVariant("vent_no_consent", turnIndex, ctx);
  }
  if (intent === "off_topic") {
    return "I can't help with that — I'm focused on prescription status. Where do things stand with the pharmacy?";
  }
  if (intent === "ask_options") {
    return "I coordinate prescription status: pharmacy delays, prior auth follow-ups, and pickup readiness. What would help most right now?";
  }
  if (intent === "summarize") {
    return `Case ${caseId} is ${String(statusKey).replaceAll("_", " ")}. What should we tackle next?`;
  }
  if (intent === "thanks") {
    return "You're welcome. You can hang up anytime, or keep talking if something else comes up.";
  }
  if (intent === "still_waiting") {
    return "Understood — we'll keep it open. I won't mark it resolved until the pharmacy confirms ready. Anything else to note?";
  }
  if (!consented) {
    return enforceMemoryGuards(
      pickVariant("ask_consent", turnIndex, ctx),
      { consented: false, statusKey, conversationTurns, askedStatusQuestions },
    );
  }
  if (statusKey === "ready") {
    return enforceMemoryGuards(
      pickVariant("ready", turnIndex, ctx),
      { consented, statusKey, conversationTurns, askedStatusQuestions },
    );
  }
  if (statusKey === "coordinating") {
    return enforceMemoryGuards(
      pickVariant("coordinating", turnIndex, ctx),
      { consented, statusKey, conversationTurns, askedStatusQuestions },
    );
  }
  if (statusKey === "waiting_clinic") {
    return enforceMemoryGuards(
      pickVariant("waiting_clinic", turnIndex, ctx),
      { consented, statusKey, conversationTurns, askedStatusQuestions },
    );
  }
  if (statusKey === "waiting_pharmacy") {
    return enforceMemoryGuards(
      pickVariant("waiting_pharmacy", turnIndex, ctx),
      { consented, statusKey, conversationTurns, askedStatusQuestions },
    );
  }
  return avoidRepeat("I'm listening — go ahead.", conversationTurns);
}

export function recentTranscriptDigest(turns = [], limit = 8) {
  return turns.slice(-limit).map((turn, index) => {
    const who = turn.role === "assistant" ? "Maya" : "Caller";
    return `${index + 1}. ${who}: ${turn.text}`;
  }).join("\n");
}

export function lastSpokenLine(turns = []) {
  return lastAssistantText(turns);
}
