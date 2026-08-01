/**
 * Conversational dialogue layer for inbound voice.
 * Feels like a real coordinator: empathy, memory, multi-context turns —
 * while still advancing the proof-gated access task.
 */

export function sayVoiceAttrs() {
  const voice = process.env.TEXML_VOICE || "Polly.Joanna-Neural";
  const speed = process.env.TEXML_VOICE_SPEED || "0.92";
  return ` voice="${voice}" voiceSpeed="${speed}"`;
}

/** Short greeting — phone callers hang up on menu dumps. */
export function openPrompt() {
  return [
    "Hi, this is Maya with RxRelay.",
    "I help with prescription status — pharmacy delays, prior auth, and pickup readiness.",
    "I can't give medical advice or change a prescription.",
    "What's going on with your medication?",
  ].join(" ");
}

export function noInputPrompt() {
  return "Sorry, I didn't catch that. What's going on with your prescription?";
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
  const repairs = [
    [/\bprior off\b/gi, "prior auth"],
    [/\bprior authori[sz]ation\b/gi, "prior authorization"],
    [/\bp\.?\s*a\.?\b/gi, "PA"],
    [/\bsee vs\b/gi, "CVS"],
    [/\bc v s\b/gi, "CVS"],
    [/\bwall greens\b/gi, "Walgreens"],
    [/\bwal greens\b/gi, "Walgreens"],
    [/\brite aid\b/gi, "Rite Aid"],
    [/\bpick up\b/gi, "pickup"],
    [/\bpick-up\b/gi, "pickup"],
    [/\bmeds\b/gi, "meds"],
    [/\bi consent\b/gi, "I consent"],
  ];
  for (const [pattern, replacement] of repairs) t = t.replace(pattern, replacement);
  return t;
}

/** Soft next-step nudge for the model — not spoken verbatim every turn. */
export function goalForStatus(statusKey, { consented = false } = {}) {
  if (!consented || statusKey === "intake") {
    return "Confirm they want status help (that counts as consent), then learn the pharmacy situation.";
  }
  if (statusKey === "ready") {
    return "Start a pharmacy status check when they want progress — or when they clearly describe being stuck.";
  }
  if (statusKey === "coordinating") {
    return "Capture what the pharmacy said — PA hold, insurance, or ready — without inventing outcomes.";
  }
  if (statusKey === "waiting_clinic") {
    return "Learn whether the clinic/doctor submitted the prior authorization.";
  }
  if (statusKey === "waiting_pharmacy") {
    return "Learn whether the pharmacy confirmed ready for pickup.";
  }
  if (statusKey === "awaiting_update" || statusKey === "resolved") {
    return "Confirm completion briefly and close warmly.";
  }
  if (statusKey === "human_review") {
    return "Reassure them a human owns the case; do not automate further.";
  }
  return "Listen, clarify, and advance evidence only when facts arrive.";
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
 * Status-aware intent detection for natural phone speech.
 * Order matters: specific outcomes before generic "check/status".
 */
export function detectConversationalIntent(transcript = "", statusKey = "intake") {
  const t = normalizeTranscript(transcript).toLowerCase();

  if (/\b(human|agent|representative|real person|operator|escalate|talk to (a |someone|a person)|speak (to|with) (a )?(person|human|someone)|transfer me)\b/.test(t)) {
    return "escalate";
  }
  if (/\b(i'?m (so )?(frustrated|stressed|scared|worried|upset|overwhelmed)|this is ridiculous|nobody (is )?helping|i'?ve been calling|fed up|losing (my )?mind)\b/.test(t)) {
    return "vent";
  }
  if (/\b(what can you (do|help with)|what are my (options|choices)|how does this work|who are you|what do you do)\b/.test(t)) {
    return "ask_options";
  }
  if (/\b(summarize|summary|where (are|is) (we|my case)|recap|catch me up|what happened so far)\b/.test(t)) {
    return "summarize";
  }
  if (/\b(weather|sports|joke|who won|password|social security|credit card)\b/.test(t)) {
    return "off_topic";
  }
  // Outcome intents — allow even when phrased inside a longer story
  if (/\b(clinic (submitted|sent|filed|did)|pa (was )?(submitted|filed|sent)|authorization (was )?(submitted|filed)|doctor (sent|filed|took care|submitted)|my (doctor|clinic|prescriber) (already )?(sent|filed|submitted)|they filed (the )?(pa|prior)|doc(tor)? (took|handled) (it|care of it))\b/.test(t)) {
    return "clinic_submission";
  }
  if (/\b(ready for pickup|ready to pick ?up|prescription is ready|meds? (are|is) ready|i can pick (it )?up|said (it'?s|it is) ready|it'?s ready|they (said|say) (it'?s |it is )?ready)\b/.test(t)) {
    return "pharmacy_ready";
  }
  if (/\b(prior auth|prior authorization|needs? (a )?pa|blocker|insurance (needs|required|wants|holding|won'?t)|pa needed|waiting on (insurance|pa|the pa)|on hold|denied|can'?t fill|won'?t fill|need(s)? (the )?doctor)\b/.test(t)) {
    return "pharmacy_blocker";
  }
  if (/\b(still waiting|no update|nothing yet|not yet|no word|haven'?t heard)\b/.test(t)) {
    return "still_waiting";
  }
  if (statusKey === "ready" || statusKey === "intake" || !statusKey) {
    // Pure consent legalese includes the words "status" / "follow-up" — don't treat that as "start now".
    const pureConsent = /\bi\s+consent\b|\bi\s+give\s+(?:you\s+)?permission\b|\byou\s+have\s+my\s+permission\b/i.test(t)
      && !/\b(check|please help|help me|can you help|stuck|been waiting|find out|look into|what'?s going on|chase|track)\b/i.test(t);
    if (!pureConsent && /\b(check|status|follow[\s-]?up|call (the )?pharmacy|coordinate|what'?s going on|find out|look into|any update|can you help|please help|help me|stuck|can'?t get my|been waiting|help me (with|get)|figure out|see what'?s (up|happening)|chase|track|help with (my )?(prescription|medication|meds|pharmacy))\b/.test(t)) {
      return "start_coordination";
    }
  }
  if (statusKey === "coordinating" && /\b(update|heard back|they said|pharmacy said)\b/.test(t)) {
    return "chat";
  }
  if (/\b(thank(s| you)|that('?s| is) all|goodbye|bye|i'?m good|that'?s it)\b/.test(t)) {
    return "thanks";
  }
  return "chat";
}

/**
 * Consent for demo-grade phone UX:
 * - Explicit "I consent…" still works
 * - Asking for help with a prescription / pharmacy status is treated as scoped yes
 *   (patients rarely recite legalese on a real call)
 */
export function consentFromTranscript(transcript = "") {
  const t = normalizeTranscript(transcript);
  const declines = /\b(i do not consent|i don't consent|no consent|do not (call|text|coordinate)|i decline|leave me alone|stop calling)\b/i.test(t);
  if (declines) return { granted: false, scoped: true };

  const saysConsent = /\b(i\s+consent|i\s+give\s+(?:you\s+)?permission|yes[,\s]+you\s+(?:may|can)|you\s+have\s+my\s+permission|go ahead|yes[,\s]+please(\s+(check|coordinate|follow|help))?|that'?s fine|that is fine|you can (check|call|coordinate|text|help)|sure[,.]?\s+(you can|go ahead|please)?|okay[,.]?\s+(you can|go ahead|please)?|i agree|sounds good|please do|yes please)\b/i.test(t);
  const scoped = /\b(pharmacy|status|coordinate|text|update|follow[\s-]?up|prescription|medication|meds?|refill|prior auth|access|help (me )?(with|on|get)|stuck|waiting)\b/i.test(t)
    || /\b(go ahead|yes[,\s]+please|i agree|sure|sounds good)\b/i.test(t);
  const softAsk = /\b(please help|can you help|i need help|help me|i need you to|could you|would you)\b/i.test(t)
    && /\b(pharmacy|prescription|medication|meds?|refill|prior auth|status|pickup)\b/i.test(t);
  const storyConsent = /\b(been waiting|can'?t (get|pick)|stuck (at|with|on)|pharmacy (has|won'?t|can'?t)|need (my|the) (meds?|medication|prescription))\b/i.test(t);

  return {
    granted: Boolean((saysConsent && scoped) || softAsk || (storyConsent && scoped)),
    scoped: Boolean(scoped || softAsk || storyConsent),
    saysConsent: Boolean(saysConsent),
    softAsk: Boolean(softAsk || storyConsent),
  };
}

function lastAssistantText(turns = []) {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i]?.role === "assistant" && turns[i]?.text) return String(turns[i].text);
  }
  return "";
}

/** Avoid repeating the same spoken line when intent/status didn't move. */
export function avoidRepeat(reply, conversationTurns = []) {
  const last = lastAssistantText(conversationTurns).trim();
  const next = String(reply || "").trim();
  if (!last || !next) return next;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const a = norm(last);
  const b = norm(next);
  if (a === b) return "Got it — I'm still with you. What else should I know?";
  if (a.length > 40 && b.includes(a.slice(0, Math.min(80, a.length)))) {
    return "Okay. What's the latest on your end?";
  }
  // Same opening clause reused
  const aOpen = a.split(/\s+/).slice(0, 8).join(" ");
  const bOpen = b.split(/\s+/).slice(0, 8).join(" ");
  if (aOpen && aOpen === bOpen && a !== b) {
    return next.replace(/^[^.]+\.\s*/, "").trim() || "Okay — go ahead.";
  }
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
} = {}) {
  if (humanReview) return humanHandoffPrompt();
  const pharmacy = notes.pharmacyName ? ` at ${notes.pharmacyName}` : "";
  const med = notes.medicationHint ? ` ${notes.medicationHint}` : "";

  if (action === "consent") {
    return `Thanks — I've got your okay for status follow-up and texts. Your case is ${caseId}. Tell me what's going on with the${med} prescription${pharmacy}.`;
  }
  if (action === "start_coordination") {
    return `Okay, I've started a pharmacy status check${pharmacy}. When you hear back, just tell me what they said — like if they need prior auth, or if it's ready.`;
  }
  if (action === "pharmacy_blocker") {
    return "Got it — prior authorization is on the record. Tell me when your doctor or clinic files it.";
  }
  if (action === "clinic_submission") {
    return "Thanks — clinic submission is recorded. Let me know when the pharmacy says it's ready for pickup.";
  }
  if (action === "pharmacy_ready") {
    return "Great news — readiness is recorded and I sent your status update. Anything else before we wrap up?";
  }
  if (action === "escalate") return humanHandoffPrompt();

  if (intent === "vent") {
    return consented
      ? "I hear you — that runaround is exhausting. What's the latest you heard from the pharmacy?"
      : "I hear you. I can take the status chase off your plate — want me to help with the pharmacy follow-up?";
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
    return "Happy to help. Just say you want me to check your pharmacy status, and I'll take it from there.";
  }
  if (statusKey === "ready") {
    return "Want me to start a pharmacy status check now?";
  }
  if (statusKey === "coordinating") {
    return "What did the pharmacy tell you?";
  }
  if (statusKey === "waiting_clinic") {
    return "Has your clinic submitted the prior auth yet?";
  }
  if (statusKey === "waiting_pharmacy") {
    return "Has the pharmacy said it's ready for pickup?";
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
