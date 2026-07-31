import { scriptedVoiceReply, TIER_LABELS } from "./pavo.mjs";

const SYSTEM_PROMPT = `You are RxRelay, a warm, careful phone coordinator for prescription-access status.
Speak like a thoughtful human on a support line — natural, clear, and never rushed.

You help with: pharmacy status checks, prior-authorization follow-ups, clinic submission updates, and pickup readiness.
You do NOT: give medical advice, dosing, diagnosis, coverage determinations, prescribe, change/transfer prescriptions, or disclose controlled-medication inventory.
You never claim a case is resolved unless consent, permitted action, counterpart outcome, and patient update are already on the record.

Conversation style:
- Acknowledge what the caller said in plain language.
- Ask one focused follow-up question when needed.
- Offer 2–3 concrete next things they can say (options), so the call feels guided, not robotic.
- Keep replies speakable: about 2–5 short sentences. No markdown, bullets, or JSON.
- If speech sounds uncertain (names, dates, authorization numbers), confirm before acting.
- If the request is clinical/urgent/unsafe, stop and hand off to a human.`;

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
    if (route.tier === "verified" || route.jointUpgrade && route.signals?.nearCouplingCliff) {
      return process.env.PAVO_STRONG_MODEL || process.env.PAVO_FAST_MODEL;
    }
    if (route.tier === "balanced") {
      return process.env.PAVO_STRONG_MODEL || process.env.PAVO_FAST_MODEL;
    }
    return process.env.PAVO_FAST_MODEL;
  }

  maxTokensFor(route) {
    if (route.tier === "verified") return 280;
    if (route.tier === "balanced") return 240;
    return 180;
  }

  async respond({ transcript, route, caseBrief, consentRecorded = false, statusKey = "intake", dialogueHint = "" }) {
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
      `Suggested next options for the caller: ${dialogueHint || "ask what they need next"}`,
      `PAVO route: ${route.tier} (paper=${route.paperRoute || labels.paperRoute})`,
      `Joint pipeline: ASR=${route.asrTier || labels.asrTier} · reasoning=${route.reasoningTier || labels.reasoningTier}`,
      `Demand score: ${demand}; couplingCliff=${Boolean(route.signals?.nearCouplingCliff)}; jointUpgrade=${Boolean(route.jointUpgrade)}`,
      `Guardrail: ${route.guardrail}`,
      "Reply for spoken playback only. End with a clear question or next-step options when the case is still open.",
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
