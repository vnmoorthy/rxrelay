/**
 * Conversational dialogue layer for inbound voice.
 * Speaks like a careful human coordinator: clear options, follow-ups,
 * and tolerance for natural phrasing — without inventing evidence.
 */

export function sayVoiceAttrs() {
  // Neural US English female — closest “Siri-like” voice available on TeXML
  // without a custom ElevenLabs key. Override with TEXML_VOICE / TEXML_VOICE_SPEED.
  const voice = process.env.TEXML_VOICE || "Polly.Joanna-Neural";
  const speed = process.env.TEXML_VOICE_SPEED || "0.95";
  return ` voice="${voice}" voiceSpeed="${speed}"`;
}

export function openPrompt() {
  return [
    "Hi, thanks for calling RxRelay.",
    "I help with prescription access status — things like pharmacy delays, prior authorization follow-ups, and pickup readiness.",
    "I do not give medical advice, change prescriptions, or check controlled-medication inventory.",
    "To continue, please say clearly: I consent to a pharmacy status follow-up and text updates.",
    "Or say: I do not consent, if you want a human instead.",
  ].join(" ");
}

export function noInputPrompt() {
  return "Sorry, I did not catch that. You can say: I consent to a pharmacy status follow-up and text updates. Or tell me what you need help with, like checking pharmacy status.";
}

export function humanHandoffPrompt() {
  return "Understood. I am transferring this to a human coordinator and will not take further automated action. Someone on the care team can continue from here.";
}

export function optionsForStatus(statusKey, { consented = false } = {}) {
  if (!consented || statusKey === "intake") {
    return "You can say you consent to a pharmacy status follow-up and text updates, ask what I can help with, or ask for a human.";
  }
  if (statusKey === "ready") {
    return "You can say: check my prescription status. Or tell me the pharmacy name, what you already heard, or ask for a human.";
  }
  if (statusKey === "coordinating") {
    return "What did the pharmacy say? For example: they need prior authorization, they are waiting on insurance, or they said it is already ready.";
  }
  if (statusKey === "waiting_clinic") {
    return "Has the clinic submitted the prior authorization? You can say the clinic submitted it, or that you still need help following up.";
  }
  if (statusKey === "waiting_pharmacy") {
    return "Has the pharmacy confirmed it is ready for pickup? You can say it is ready, still waiting, or ask me to keep the case open.";
  }
  if (statusKey === "awaiting_update" || statusKey === "resolved") {
    return "Your proof looks complete. You can ask me to summarize the case, or say thank you and hang up.";
  }
  if (statusKey === "human_review") {
    return "This case is with a human coordinator. I will not automate further steps.";
  }
  return "Tell me what happened next, or ask for a human.";
}

/** Broader natural-language intent detection for post-consent turns. */
export function detectConversationalIntent(transcript = "", statusKey = "intake") {
  const t = String(transcript || "").toLowerCase();

  if (/\b(human|agent|representative|person|real person|operator|escalate|talk to someone)\b/.test(t)) {
    return "escalate";
  }
  if (/\b(what can you (do|help)|help with|options|menu|what are my choices)\b/.test(t)) {
    return "ask_options";
  }
  if (/\b(summarize|summary|where (are|is) (we|my case)|status of (my )?case|what happened)\b/.test(t)) {
    return "summarize";
  }
  if (/\b(clinic (submitted|sent|filed|did)|pa submitted|authorization (was )?submitted|doctor (sent|filed)|my doctor took care|clinic follow[\s-]?up)\b/.test(t)) {
    return "clinic_submission";
  }
  if (/\b(ready for pickup|ready to pick up|prescription is ready|meds? (are|is) ready|i can pick (it )?up)\b/.test(t)) {
    return "pharmacy_ready";
  }
  if (/\b(prior auth|prior authorization|blocker|insurance (needs|required|wants)|pa needed|waiting on (insurance|pa)|denied|on hold)\b/.test(t)) {
    return "pharmacy_blocker";
  }
  if (/\b(check|status|follow[\s-]?up|call (the )?pharmacy|coordinate|what's going on|what is going on|find out|look into|still waiting|any update)\b/.test(t)) {
    return "start_coordination";
  }
  if (/\b(still waiting|no update|nothing yet|not yet)\b/.test(t) && statusKey === "waiting_pharmacy") {
    return "still_waiting";
  }
  if (/\b(thank(s| you)|that('?s| is) all|goodbye|bye)\b/.test(t)) {
    return "thanks";
  }
  return "chat";
}

export function consentFromTranscript(transcript = "") {
  const t = String(transcript || "");
  const declines = /\b(i do not consent|i don't consent|no consent|do not (call|text|coordinate)|i decline)\b/i.test(t);
  if (declines) return { granted: false, scoped: true };

  const saysConsent = /\b(i\s+consent|i\s+give\s+(?:you\s+)?permission|yes[,\s]+you\s+(?:may|can)|you\s+have\s+my\s+permission|go ahead|yes[,\s]+please\s+(check|coordinate|follow)|that's fine|that is fine|you can (check|call|coordinate|text))\b/i.test(t);
  const scoped = /\b(pharmacy|status|coordinate|text|update|follow[\s-]?up|prescription access)\b/i.test(t)
    || /\b(go ahead|yes[,\s]+please)\b/i.test(t);
  return { granted: saysConsent && scoped, scoped: Boolean(scoped), saysConsent: Boolean(saysConsent) };
}

export function scriptedConversationalReply({
  statusKey,
  consented,
  action = null,
  intent = "chat",
  caseId,
  humanReview = false,
} = {}) {
  if (humanReview) return humanHandoffPrompt();

  if (action === "consent") {
    return [
      "Thank you. Your consent is recorded for prescription access status follow-up and text updates only.",
      `Your case id is ${caseId}.`,
      "What would you like me to do next?",
      "You can say: check my prescription status.",
      "Or tell me anything you already heard from the pharmacy or clinic.",
    ].join(" ");
  }
  if (action === "start_coordination") {
    return [
      "Okay — I started a permitted pharmacy status follow-up for you.",
      "Your case stays open until we have a counterpart outcome and a patient update on the record.",
      "When you hear back, tell me what the pharmacy said.",
      "For the demo, you can say: the pharmacy said prior authorization is needed.",
    ].join(" ");
  }
  if (action === "pharmacy_blocker") {
    return [
      "Got it. I recorded the pharmacy outcome: prior authorization is needed.",
      "Next I need the clinic follow-up.",
      "You can say: the clinic submitted the prior authorization.",
      "Or ask me to keep waiting.",
    ].join(" ");
  }
  if (action === "clinic_submission") {
    return [
      "Perfect. I recorded that the clinic submitted the prior authorization.",
      "We are waiting for the pharmacy to confirm pickup readiness.",
      "You can say: the pharmacy says it is ready for pickup.",
    ].join(" ");
  }
  if (action === "pharmacy_ready") {
    return [
      "Great news. Pharmacy readiness is recorded, and a consented status update was sent.",
      "Your resolution proof is complete — consent, action, counterpart outcome, and patient update.",
      "Is there anything else, or shall we leave it there?",
    ].join(" ");
  }
  if (action === "escalate") return humanHandoffPrompt();

  if (intent === "ask_options") {
    return `Here is what I can help with right now. ${optionsForStatus(statusKey, { consented })}`;
  }
  if (intent === "summarize") {
    return `Your case ${caseId} is currently ${String(statusKey).replaceAll("_", " ")}. ${optionsForStatus(statusKey, { consented })}`;
  }
  if (intent === "thanks") {
    return "You are welcome. I will keep the evidence on the case. You can hang up whenever you are ready.";
  }
  if (intent === "still_waiting") {
    return "Understood — we will keep the case open. There is no resolution claim until the pharmacy confirms readiness and a patient update is recorded.";
  }
  if (!consented) {
    return [
      "I can help, but I need your explicit consent first.",
      "Please say: I consent to a pharmacy status follow-up and text updates.",
      "If you prefer a person, say: I want a human.",
    ].join(" ");
  }
  return [
    "I am listening.",
    optionsForStatus(statusKey, { consented }),
  ].join(" ");
}
