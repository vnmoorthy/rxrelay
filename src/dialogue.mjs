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

export function openPrompt() {
  return [
    "Hi, this is Maya with RxRelay — thanks for calling.",
    "I can help with everyday questions and planning, and I specialize in prescription access status — pharmacy delays, prior authorization follow-ups, and pickup readiness.",
    "I can't give medical advice or change a prescription, and I never pretend I called or texted someone unless it actually happened.",
    "Tell me what's on your mind in your own words.",
    "If you want status coordination and texts, say you consent to a pharmacy status follow-up and text updates.",
  ].join(" ");
}

export function noInputPrompt() {
  return "Sorry, I missed that. Take your time — tell me what happened with your prescription, or say you consent to a pharmacy status follow-up and text updates.";
}

export function humanHandoffPrompt() {
  return "Of course. I'm connecting you with a human coordinator now, and I won't take any more automated steps. They'll pick up from the notes on your case.";
}

/** Soft next-step nudge — not a rigid menu dump every turn. */
export function goalForStatus(statusKey, { consented = false } = {}) {
  if (!consented || statusKey === "intake") {
    return "Earn scoped consent for status follow-up and texts, or escalate to a human if they prefer.";
  }
  if (statusKey === "ready") {
    return "Learn what they need, then start a permitted pharmacy status check when they want progress.";
  }
  if (statusKey === "coordinating") {
    return "Capture what the pharmacy said — blocker, insurance hold, or ready — without inventing outcomes.";
  }
  if (statusKey === "waiting_clinic") {
    return "Learn whether the clinic submitted the prior authorization, or keep the case waiting.";
  }
  if (statusKey === "waiting_pharmacy") {
    return "Learn whether the pharmacy confirmed ready for pickup, or keep waiting honestly.";
  }
  if (statusKey === "awaiting_update" || statusKey === "resolved") {
    return "Confirm completion, offer a short summary, and close warmly.";
  }
  if (statusKey === "human_review") {
    return "Reassure them a human owns the case; do not automate further.";
  }
  return "Listen, clarify, and advance the evidence trail only when facts arrive.";
}

export function optionsForStatus(statusKey, { consented = false } = {}) {
  return goalForStatus(statusKey, { consented });
}

export function extractCallerNotes(transcript = "") {
  const t = String(transcript);
  const notes = {};
  const pharmacy = t.match(/\b(?:at|from|with)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\s+(?:pharmacy|drugstore)\b/)
    || t.match(/\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\s+pharmacy\b/i);
  if (pharmacy) notes.pharmacyName = pharmacy[1].replace(/\bpharmacy\b/i, "").trim();
  const med = t.match(/\b(?:for|on)\s+(?:my\s+)?([a-z][a-z0-9-]{2,})\b/i);
  if (med && !/status|pharmacy|clinic|insurance|prescription|medication|update|follow/.test(med[1])) {
    notes.medicationHint = med[1];
  }
  const days = t.match(/\b(\d+)\s+days?\b/i);
  if (days) notes.waitDays = Number(days[1]);
  return notes;
}

/**
 * Status-aware intent detection for complex, natural speech.
 * Order matters: specific outcomes before generic "check/status".
 */
export function detectConversationalIntent(transcript = "", statusKey = "intake") {
  const t = String(transcript || "").toLowerCase();

  if (/\b(human|agent|representative|real person|operator|escalate|talk to (a |someone|a person)|speak to (a )?person)\b/.test(t)) {
    return "escalate";
  }
  if (/\b(i'?m (so )?(frustrated|stressed|scared|worried|upset|overwhelmed)|this is ridiculous|nobody (is )?helping|i'?ve been calling)\b/.test(t)) {
    return "vent";
  }
  if (/\b(what can you (do|help)|help with|options|what are my choices|how does this work|who are you)\b/.test(t)) {
    return "ask_options";
  }
  if (/\b(summarize|summary|where (are|is) (we|my case)|recap|catch me up|what happened so far)\b/.test(t)) {
    return "summarize";
  }
  if (/\b(weather|sports|joke|who won|password|social security|credit card)\b/.test(t)) {
    return "off_topic";
  }
  // Outcome intents — allow even when phrased inside a longer story
  if (/\b(clinic (submitted|sent|filed|did)|pa (was )?submitted|authorization (was )?submitted|doctor (sent|filed|took care)|my (doctor|clinic) (already )?(sent|filed)|they filed (the )?(pa|prior))\b/.test(t)) {
    return "clinic_submission";
  }
  if (/\b(ready for pickup|ready to pick up|prescription is ready|meds? (are|is) ready|i can pick (it )?up|said (it'?s|it is) ready)\b/.test(t)) {
    return "pharmacy_ready";
  }
  if (/\b(prior auth|prior authorization|needs? (a )?pa|blocker|insurance (needs|required|wants|holding)|pa needed|waiting on (insurance|pa|the pa)|on hold|denied)\b/.test(t)) {
    return "pharmacy_blocker";
  }
  if (/\b(still waiting|no update|nothing yet|not yet|no word|haven'?t heard)\b/.test(t)) {
    return "still_waiting";
  }
  if (statusKey === "ready" || statusKey === "intake" || !statusKey) {
    if (/\b(check|status|follow[\s-]?up|call (the )?pharmacy|coordinate|what'?s going on|find out|look into|any update|can you help|stuck|can'?t get my)\b/.test(t)) {
      return "start_coordination";
    }
  }
  if (statusKey === "coordinating" && /\b(update|heard back|they said|pharmacy said)\b/.test(t)) {
    return "chat"; // let model clarify which outcome
  }
  if (/\b(thank(s| you)|that('?s| is) all|goodbye|bye|i'?m good)\b/.test(t)) {
    return "thanks";
  }
  return "chat";
}

export function consentFromTranscript(transcript = "") {
  const t = String(transcript || "");
  const declines = /\b(i do not consent|i don't consent|no consent|do not (call|text|coordinate)|i decline|leave me alone)\b/i.test(t);
  if (declines) return { granted: false, scoped: true };

  const saysConsent = /\b(i\s+consent|i\s+give\s+(?:you\s+)?permission|yes[,\s]+you\s+(?:may|can)|you\s+have\s+my\s+permission|go ahead|yes[,\s]+please\s+(check|coordinate|follow)|that'?s fine|that is fine|you can (check|call|coordinate|text)|sure[,.]?\s+(you can|go ahead)|okay[,.]?\s+(you can|go ahead)|i agree)\b/i.test(t);
  const scoped = /\b(pharmacy|status|coordinate|text|update|follow[\s-]?up|prescription access|help (me )?(with|on))\b/i.test(t)
    || /\b(go ahead|yes[,\s]+please|i agree|sure)\b/i.test(t);
  const softAsk = /\b(please help|can you help|i need help)\b/i.test(t) && /\b(pharmacy|prescription|medication|refill|prior auth)\b/i.test(t);
  return {
    granted: Boolean(saysConsent && scoped),
    scoped: Boolean(scoped || softAsk),
    saysConsent: Boolean(saysConsent),
    softAsk: Boolean(softAsk),
  };
}

export function scriptedConversationalReply({
  statusKey,
  consented,
  action = null,
  intent = "chat",
  caseId,
  humanReview = false,
  notes = {},
} = {}) {
  if (humanReview) return humanHandoffPrompt();
  const pharmacy = notes.pharmacyName ? ` at ${notes.pharmacyName}` : "";

  if (action === "consent") {
    return `Thank you — I've got your consent for status follow-up and text updates only. Your case is ${caseId}. What's been going on with the prescription${pharmacy}? I can start a pharmacy status check whenever you want.`;
  }
  if (action === "start_coordination") {
    return `Okay, I've started a permitted pharmacy status follow-up${pharmacy}. I'll keep this case open until we have a real counterpart outcome and a patient update. When you hear back, just tell me in your own words what they said — for example if they need prior authorization, or if it's already ready.`;
  }
  if (action === "pharmacy_blocker") {
    return "Got it — I've recorded that the pharmacy needs prior authorization. Next we need to know when the clinic submits that follow-up. You can tell me when they file it, or we can leave the case waiting.";
  }
  if (action === "clinic_submission") {
    return "Thanks — I've recorded that the clinic submitted the prior authorization. Now we're waiting on the pharmacy to confirm it's ready for pickup. Tell me when you hear that, even casually.";
  }
  if (action === "pharmacy_ready") {
    return "That's great — pharmacy readiness is on the record and I sent a consented status update. Your resolution proof is complete. Anything else you want me to note before we wrap up?";
  }
  if (action === "escalate") return humanHandoffPrompt();

  if (intent === "vent") {
    return `I hear you — that back-and-forth is exhausting, and you shouldn't have to be the switchboard. ${consented ? "I'm here to own the status follow-up with you." : "If you want my help, say you consent to a pharmacy status follow-up and text updates, and we'll take the next step together."} What's the latest you heard?`;
  }
  if (intent === "off_topic") {
    return "I can't help with that one — I'm focused on prescription access status. Want to tell me where things stand with the pharmacy or clinic?";
  }
  if (intent === "ask_options") {
    return `I'm Maya with RxRelay. I coordinate non-clinical prescription access status — pharmacy delays, prior auth follow-ups, pickup readiness — and I only close a case when the evidence is real. ${goalForStatus(statusKey, { consented })} What would help most right now?`;
  }
  if (intent === "summarize") {
    return `Here's where we are on case ${caseId}: status is ${String(statusKey).replaceAll("_", " ")}. ${goalForStatus(statusKey, { consented })} What should we tackle next?`;
  }
  if (intent === "thanks") {
    return "You're welcome. I'll keep the evidence on your case. You can hang up whenever you're ready — or keep talking if something else comes up.";
  }
  if (intent === "still_waiting") {
    return "Understood — we'll keep the case open. I won't pretend it's resolved until the pharmacy confirms readiness and a patient update is recorded. Want me to note anything else you heard in the meantime?";
  }
  if (!consented) {
    return "I'm with you. Before I coordinate with anyone, I need your okay — please say you consent to a pharmacy status follow-up and text updates. Or ask for a human if you'd rather.";
  }
  return `I'm listening. ${goalForStatus(statusKey, { consented })}`;
}

export function recentTranscriptDigest(turns = [], limit = 6) {
  return turns.slice(-limit).map((turn, index) => {
    const who = turn.role === "assistant" ? "Maya" : "Caller";
    return `${index + 1}. ${who}: ${turn.text}`;
  }).join("\n");
}
