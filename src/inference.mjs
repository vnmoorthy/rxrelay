import { scriptedVoiceReply } from "./pavo.mjs";

const SYSTEM_PROMPT = `You are RxRelay, a consent-first voice coordinator for prescription access.
You may coordinate non-clinical status follow-ups only after explicit consent. You do not provide medical advice, dosing, diagnosis, coverage determinations, prescribing, prescription changes/transfers, or controlled-medication inventory. You do not claim a case is resolved without recorded counterpart evidence and a patient update. Keep the spoken reply warm, short, and specific. If the user requests a prohibited action or reports urgent symptoms, direct them to urgent help or their care team and say a human coordinator will review the case.`;

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
    const model = route.tier === "verified" ? process.env.PAVO_STRONG_MODEL : process.env.PAVO_FAST_MODEL;
    return Boolean(process.env.PAVO_OPENAI_BASE_URL && process.env.PAVO_OPENAI_API_KEY && model);
  }

  modelFor(route) {
    return route.tier === "verified" ? process.env.PAVO_STRONG_MODEL : process.env.PAVO_FAST_MODEL;
  }

  async respond({ transcript, route, caseBrief }) {
    const fallback = scriptedVoiceReply(route);
    if (!this.configuredFor(route)) return { text: fallback, source: "local-safe-fallback", model: null };
    const endpoint = `${process.env.PAVO_OPENAI_BASE_URL.replace(/\/$/, "")}/responses`;
    // a1mobile's hackathon gateway implements the Responses endpoint but does
    // not support the optional `instructions` field. Keep the safety contract
    // in the single portable input string so it works with both the gateway and
    // standard OpenAI-compatible deployments.
    const input = `${SYSTEM_PROMPT}\n\nCaller said: ${transcript}\n\nCase context: ${caseBrief}\nRoute: ${route.tier}. Guardrail: ${route.guardrail}`;
    try {
      const response = await this.fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.PAVO_OPENAI_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: this.modelFor(route), input, max_output_tokens: 160 }),
      });
      if (!response.ok) throw new Error(`Responses API returned ${response.status}`);
      const text = responseText(await response.json());
      return { text: text || fallback, source: text ? "openai-compatible" : "local-safe-fallback", model: this.modelFor(route) };
    } catch (error) {
      return { text: fallback, source: "local-safe-fallback", model: this.modelFor(route), warning: error.message };
    }
  }
}
