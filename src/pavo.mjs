/**
 * Pipeline-aware voice routing inspired by PAVO
 * (Pipeline-Aware Voice Orchestration with Demand-Conditioned Inference Routing)
 * https://openreview.net/forum?id=zrneoIxlFx · https://github.com/vnmoorthy/pavo-bench
 *
 * PAVO's core empirical claim: upstream ASR quality bounds what a downstream
 * LLM can recover. A sharper model cannot repair a misheard authorization
 * number once the transcript has already fallen over the coupling cliff.
 *
 * RxRelay therefore selects ASR + reasoning *together* from a demand score,
 * never independently. Safe-stop is evaluated before any demand math.
 */

const SAFE_STOP_PATTERNS = [
  [/chest pain|difficulty breathing|overdose|passed out|unconscious|suicid|can't breathe|cannot breathe/i, "urgent medical situation"],
  [/should I take|how much.*take|dosage|side effects|diagnose|medical advice|is it safe to/i, "clinical advice request"],
  [/transfer.*prescription|change.*prescription|new prescription|increase.*(dose|medication)/i, "prescription change request"],
  [/do you have.*(adderall|opioid|controlled)|controlled.*inventory|narcotic.*stock/i, "controlled-medication inventory request"],
  [/my social security|credit card|bank account|routing number/i, "sensitive identity information"],
];

const CRITICAL_ENTITY_PATTERNS = [
  /prior auth|prior authorization|authorization number|reference number/i,
  /insurance|coverage|claim|copay|deductible/i,
  /pharmacy|clinic|prescriber|doctor|pharmacist/i,
  /mg\b|milligram|refill|medication|prescription/i,
  /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b|\b[A-Z]{0,3}\d{4,}\b/,
];

const PARTNER_ACTION_PATTERNS = /call.*pharmacy|call.*clinic|call.*insurance|check.*status|follow[\s-]?up|prior auth|ready.*pickup|coordinate/i;

/** Approximate WER proxy from ASR confidence — used for coupling-cliff logic. */
export function estimateWer(asrConfidence = 0.93) {
  const c = Math.min(1, Math.max(0, Number(asrConfidence) || 0));
  return Math.max(0, Math.min(0.4, (1 - c) * 1.15));
}

/**
 * Demand score in [0,1]. Higher = more pipeline investment required.
 * Mirrors PAVO's turn-complexity / demand conditioning idea.
 */
export function computeDemand({
  transcript = "",
  asrConfidence = 0.93,
  noiseLevel = 0.1,
  intentConfidence = 0.9,
  historyDepth = 0,
} = {}) {
  const text = String(transcript).trim();
  const wer = estimateWer(asrConfidence);
  const noise = Math.min(1, Math.max(0, Number(noiseLevel) || 0));
  const intent = Math.min(1, Math.max(0, Number(intentConfidence) || 0));
  const hasCriticalEntity = CRITICAL_ENTITY_PATTERNS.some((pattern) => pattern.test(text));
  const requestsPartnerAction = PARTNER_ACTION_PATTERNS.test(text);
  const lengthFactor = Math.min(1, text.split(/\s+/).filter(Boolean).length / 28);
  const historyFactor = Math.min(1, Number(historyDepth) / 10);

  // Coupling cliff: paper shows sharp factual-quality drop as WER rises.
  // Treat WER ≳ 2% as entering the cliff zone for critical entities.
  const nearCouplingCliff = wer >= 0.02 && (hasCriticalEntity || requestsPartnerAction);

  const demand = Math.min(
    1,
    0.18 * lengthFactor
      + 0.28 * (1 - intent)
      + 0.22 * noise
      + 0.32 * Math.min(1, wer / 0.12)
      + (hasCriticalEntity ? 0.22 : 0)
      + (requestsPartnerAction ? 0.18 : 0)
      + 0.12 * historyFactor
      + (nearCouplingCliff ? 0.2 : 0),
  );

  return {
    demand: Number(demand.toFixed(3)),
    wer: Number(wer.toFixed(4)),
    nearCouplingCliff,
    hasCriticalEntity,
    requestsPartnerAction,
    noise,
    intentConfidence: intent,
    asrConfidence: Number(asrConfidence),
    historyDepth: Number(historyDepth),
  };
}

export const TIER_LABELS = {
  fast: {
    label: "Fast intake",
    pipeline: "Edge-fast ASR → compact reasoning → voice",
    asrTier: "edge_fast",
    reasoningTier: "compact",
    modelClass: "low-latency",
    paperRoute: "ondevice_fast",
  },
  balanced: {
    label: "Balanced coordination",
    pipeline: "Hybrid ASR → tool-aware reasoning → voice",
    asrTier: "hybrid_balanced",
    reasoningTier: "tool_aware",
    modelClass: "standard",
    paperRoute: "hybrid_balanced",
  },
  verified: {
    label: "Verified coordination",
    pipeline: "Cloud-premium ASR → strong reasoning → structured verifier",
    asrTier: "cloud_premium",
    reasoningTier: "strong_verified",
    modelClass: "high-assurance",
    paperRoute: "cloud_premium",
  },
  safe_stop: {
    label: "Safety stop",
    pipeline: "No autonomous action → safe script → human handoff",
    asrTier: "cloud_premium",
    reasoningTier: "none",
    modelClass: "guarded",
    paperRoute: "hard_constraint_mask",
  },
};

/**
 * Select one joint pipeline route. ASR and reasoning always move together —
 * the PAVO coupling constraint.
 */
export function routeTurn(input = {}) {
  const signals = computeDemand(input);
  const normalized = String(input.transcript || "").trim();

  for (const [pattern, reason] of SAFE_STOP_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        tier: "safe_stop",
        reason,
        signals,
        asrTier: TIER_LABELS.safe_stop.asrTier,
        reasoningTier: TIER_LABELS.safe_stop.reasoningTier,
        paperRoute: TIER_LABELS.safe_stop.paperRoute,
        jointUpgrade: false,
        guardrail: "No medical advice, prescription changes, inventory disclosure, or autonomous outreach.",
        citation: "PAVO hard-constraint masking — unsafe turns are not routed to action models.",
      };
    }
  }

  const transcriptionRisk = signals.asrConfidence < 0.84 || signals.noise > 0.48 || signals.wer >= 0.08;
  const ambiguityRisk = signals.intentConfidence < 0.78;
  const evidenceRisk = signals.hasCriticalEntity || signals.requestsPartnerAction || signals.historyDepth > 5;
  const couplingRisk = signals.nearCouplingCliff || (transcriptionRisk && evidenceRisk);

  if (couplingRisk || transcriptionRisk || (ambiguityRisk && evidenceRisk) || signals.demand >= 0.62) {
    return {
      tier: "verified",
      reason: couplingRisk
        ? "near ASR↔LLM coupling cliff; jointly upgrade transcription and reasoning"
        : transcriptionRisk
          ? "low-confidence audio; upgrade ASR and require confirmation"
          : "high-demand evidence-bearing coordination turn",
      signals,
      asrTier: TIER_LABELS.verified.asrTier,
      reasoningTier: TIER_LABELS.verified.reasoningTier,
      paperRoute: TIER_LABELS.verified.paperRoute,
      jointUpgrade: true,
      guardrail: "Confirm critical names, dates, numbers, and outcomes before any coordination action.",
      citation: "PAVO coupling cliff — downstream LLMs cannot recover facts lost to upstream ASR error.",
    };
  }

  if (evidenceRisk || signals.demand >= 0.34 || signals.historyDepth > 2) {
    return {
      tier: "balanced",
      reason: "coordination demand requires hybrid ASR + tool-aware reasoning",
      signals,
      asrTier: TIER_LABELS.balanced.asrTier,
      reasoningTier: TIER_LABELS.balanced.reasoningTier,
      paperRoute: TIER_LABELS.balanced.paperRoute,
      jointUpgrade: true,
      guardrail: "Record only permitted, minimum-necessary coordination facts.",
      citation: "PAVO hybrid_balanced route — spend quality where turn demand warrants it.",
    };
  }

  return {
    tier: "fast",
    reason: "low-demand conversational turn; edge-fast pipeline is coupling-safe",
    signals,
    asrTier: TIER_LABELS.fast.asrTier,
    reasoningTier: TIER_LABELS.fast.reasoningTier,
    paperRoute: TIER_LABELS.fast.paperRoute,
    jointUpgrade: false,
    guardrail: "No protected action is available on this tier.",
    citation: "PAVO ondevice_fast — avoid over-provisioning cloud routes on easy turns.",
  };
}

export function scriptedVoiceReply(route, { consentRecorded = false, statusKey = "intake" } = {}) {
  if (route.tier === "safe_stop") {
    return "I can help coordinate a non-clinical follow-up, but I can’t give medical advice or change a prescription. For urgent symptoms, please contact emergency services or your care team now. I’m connecting this case to a human reviewer.";
  }
  if (route.tier === "verified") {
    if (route.signals?.nearCouplingCliff) {
      return "The audio details sound critical, so I’m confirming carefully before acting. Please repeat any pharmacy name, date, or authorization reference you want me to use.";
    }
    return "I want to get the details right. I’ll confirm the pharmacy status and keep your case open until there is evidence of the next step.";
  }
  if (!consentRecorded) {
    return "I can coordinate a prescription-access status follow-up. Please say: I consent to a pharmacy status follow-up and text updates.";
  }
  if (statusKey === "ready" || statusKey === "intake") {
    return "Consent is on the record. Say check my prescription status and I will start a permitted pharmacy follow-up.";
  }
  if (route.tier === "balanced") {
    return "I’m coordinating your status follow-up and will only mark progress when counterpart evidence is recorded.";
  }
  return "I’m here for your prescription-access case. What status update should I pursue next?";
}

/** Lightweight intent tags used by the voice case engine after consent. */
export function detectVoiceIntent(transcript = "") {
  const t = String(transcript);
  if (/\b(human|agent|representative|person|escalate)\b/i.test(t)) {
    return "escalate";
  }
  if (/\b(clinic (submitted|sent|filed)|pa submitted|authorization submitted|doctor sent|clinic follow[\s-]?up)\b/i.test(t)) {
    return "clinic_submission";
  }
  if (/\b(ready for pickup|ready to pick up|prescription is ready|meds are ready)\b/i.test(t)) {
    return "pharmacy_ready";
  }
  if (/\b(prior auth|prior authorization|blocker|insurance (needs|required)|pa needed)\b/i.test(t)
    && !/\bclinic\b/i.test(t)) {
    return "pharmacy_blocker";
  }
  if (/\b(check|status|follow[\s-]?up|call (the )?pharmacy|coordinate|what's going on|what is going on)\b/i.test(t)) {
    return "start_coordination";
  }
  return "chat";
}
