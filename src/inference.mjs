import { scriptedVoiceReply, TIER_LABELS } from "./pavo.mjs";

const SYSTEM_PROMPT = `You are RxRelay, a consent-first voice coordinator for prescription access.
You are powered by PAVO-style pipeline-aware routing: when speech is uncertain, transcription and reasoning upgrade together because a stronger language model cannot repair a misheard authorization number (PAVO coupling cliff, OpenReview zrneoIxlFx).

You may coordinate non-clinical status follow-ups only after explicit consent. You do not provide medical advice, dosing, diagnosis, coverage determinations, prescribing, prescription changes/transfers, or controlled-medication inventory. You do not claim a case is resolved without recorded counterpart evidence and a patient update.

Keep the spoken reply warm, short (1-3 sentences), and specific. If the user requests a prohibited action or reports urgent symptoms, direct them to urgent help or their care team and say a human coordinator will review the case. When the route is verified, ask one clarifying confirmation for any critical name, date, or authorization reference before acting.`;

function responseText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
  for (const output of payload.output || []) {
    for (const content of output.content || []) {
      if (typeof content.text === "string" && content.text.trim()) return content.text.trim();
    }
  }
  return "";
}

export class PavoInferenceEngine {
  constructor({ fetchImpl = fetch } = {}) {
    this.fetch = fetchImpl;
  }

  configuredFor(route) {
    if (route.tier === "safe_stop") return false;
    const model = this.modelFor(route);
    return Boolean(process.env.PAVO_OPENAI_BASE_URL && process.env.PAVO_OPENAI_API_KEY && model);
  }

  modelFor(route) {
    // Joint upgrade: verified/coupling-risk turns always use the strong model.
    if (route.tier === "verified" || route.jointUpgrade && route.signals?.nearCouplingCliff) {
      return process.env.PAVO_STRONG_MODEL || process.env.PAVO_FAST_MODEL;
    }
    if (route.tier === "balanced") {
      return process.env.PAVO_STRONG_MODEL || process.env.PAVO_FAST_MODEL;
    }
    return process.env.PAVO_FAST_MODEL;
  }

  maxTokensFor(route) {
    if (route.tier === "verified") return 220;
    if (route.tier === "balanced") return 180;
    return 120;
  }

  async respond({ transcript, route, caseBrief, consentRecorded = false, statusKey = "intake" }) {
    const fallback = scriptedVoiceReply(route, { consentRecorded, statusKey });
    if (!this.configuredFor(route)) {
      return { text: fallback, source: "local-safe-fallback", model: null, pipeline: TIER_LABELS[route.tier] };
    }
    const endpoint = `${process.env.PAVO_OPENAI_BASE_URL.replace(/\/$/, "")}/responses`;
    const labels = TIER_LABELS[route.tier] || TIER_LABELS.fast;
    const demand = route.signals?.demand ?? null;
    const input = [
      SYSTEM_PROMPT,
      "",
      `Caller said: ${transcript}`,
      `Case context: ${caseBrief}`,
      `PAVO route: ${route.tier} (paper=${route.paperRoute || labels.paperRoute})`,
      `Joint pipeline: ASR=${route.asrTier || labels.asrTier} · reasoning=${route.reasoningTier || labels.reasoningTier}`,
      `Demand score: ${demand}; couplingCliff=${Boolean(route.signals?.nearCouplingCliff)}; jointUpgrade=${Boolean(route.jointUpgrade)}`,
      `Guardrail: ${route.guardrail}`,
      `Citation: ${route.citation || "PAVO OpenReview zrneoIxlFx"}`,
      "Reply for spoken playback only. Do not mention JSON or internal ids.",
    ].join("\n");
    try {
      const response = await this.fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.PAVO_OPENAI_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.modelFor(route),
          input,
          max_output_tokens: this.maxTokensFor(route),
        }),
      });
      if (!response.ok) throw new Error(`Responses API returned ${response.status}`);
      const text = responseText(await response.json());
      return {
        text: text || fallback,
        source: text ? "openai-compatible" : "local-safe-fallback",
        model: this.modelFor(route),
        pipeline: labels,
      };
    } catch (error) {
      return {
        text: fallback,
        source: "local-safe-fallback",
        model: this.modelFor(route),
        pipeline: labels,
        warning: error.message,
      };
    }
  }
}
