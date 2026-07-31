/**
 * Pipeline-aware voice routing inspired by PAVO.
 *
 * The safety-relevant point is intentional: when a turn is uncertain or contains
 * critical entities, RxRelay upgrades the ASR + reasoning pipeline together. It
 * never solves a shaky transcript merely by routing it to a stronger LLM.
 */

const SAFE_STOP_PATTERNS = [
  [/chest pain|difficulty breathing|overdose|passed out|unconscious|suicid/i, "urgent medical situation"],
  [/should I take|how much.*take|dosage|side effects|diagnose|medical advice/i, "clinical advice request"],
  [/transfer.*prescription|change.*prescription|new prescription/i, "prescription change request"],
  [/do you have.*(adderall|opioid|controlled)|controlled.*inventory|narcotic.*stock/i, "controlled-medication inventory request"],
  [/my social security|credit card|bank account/i, "sensitive identity information"],
];

const CRITICAL_ENTITY_PATTERNS = [
  /prior auth|prior authorization|insurance|coverage|claim|copay/i,
  /pharmacy|clinic|prescriber|doctor/i,
  /mg\b|milligram|refill|medication|prescription/i,
  /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b|\b\d{4,}\b/,
];

const PARTNER_ACTION_PATTERNS = /call.*pharmacy|call.*clinic|call.*insurance|check.*status|prior auth|ready.*pickup/i;

export const TIER_LABELS = {
  fast: {
    label: "Fast intake",
    pipeline: "Fast ASR → compact reasoning → voice",
    modelClass: "low-latency",
  },
  balanced: {
    label: "Balanced coordination",
    pipeline: "Reliable ASR → tool-aware reasoning → voice",
    modelClass: "standard",
  },
  verified: {
    label: "Verified coordination",
    pipeline: "High-accuracy ASR → structured reasoning → evidence verifier",
    modelClass: "high-assurance",
  },
  safe_stop: {
    label: "Safety stop",
    pipeline: "No autonomous action → safe script → human handoff",
    modelClass: "guarded",
  },
};

export function routeTurn({ transcript = "", asrConfidence = 0.93, noiseLevel = 0.1, intentConfidence = 0.9, historyDepth = 0 }) {
  const normalized = String(transcript).trim();
  const signals = {
    asrConfidence: Number(asrConfidence),
    noiseLevel: Number(noiseLevel),
    intentConfidence: Number(intentConfidence),
    historyDepth: Number(historyDepth),
    hasCriticalEntity: CRITICAL_ENTITY_PATTERNS.some((pattern) => pattern.test(normalized)),
    requestsPartnerAction: PARTNER_ACTION_PATTERNS.test(normalized),
  };

  for (const [pattern, reason] of SAFE_STOP_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        tier: "safe_stop",
        reason,
        signals,
        guardrail: "No medical advice, prescription changes, inventory disclosure, or autonomous outreach.",
      };
    }
  }

  const transcriptionRisk = signals.asrConfidence < 0.84 || signals.noiseLevel > 0.48;
  const ambiguityRisk = signals.intentConfidence < 0.78;
  const evidenceRisk = signals.hasCriticalEntity || signals.requestsPartnerAction || signals.historyDepth > 5;

  if (transcriptionRisk || (ambiguityRisk && evidenceRisk)) {
    return {
      tier: "verified",
      reason: transcriptionRisk
        ? "low-confidence audio; upgrade ASR and require confirmation"
        : "ambiguous, evidence-bearing coordination request",
      signals,
      guardrail: "Confirm critical names, dates, and outcomes before any coordination action.",
    };
  }

  if (evidenceRisk || signals.historyDepth > 2) {
    return {
      tier: "balanced",
      reason: "coordination context requires reliable tool-aware routing",
      signals,
      guardrail: "Record only permitted, minimum-necessary coordination facts.",
    };
  }

  return {
    tier: "fast",
    reason: "low-risk conversational turn",
    signals,
    guardrail: "No protected action is available on this tier.",
  };
}

export function scriptedVoiceReply(route) {
  if (route.tier === "safe_stop") {
    return "I can help coordinate a non-clinical follow-up, but I can’t give medical advice or change a prescription. For urgent symptoms, please contact emergency services or your care team now. I’m connecting this case to a human reviewer.";
  }
  if (route.tier === "verified") {
    return "I want to get the details right. I’ll confirm the pharmacy status and keep your case open until there is evidence of the next step.";
  }
  if (route.tier === "balanced") {
    return "I can coordinate a status follow-up. Before I contact anyone, do I have your permission to use the details you provided for this case?";
  }
  return "I can help check the status of a prescription-access case. Would you like to start with the pharmacy or clinic?";
}
