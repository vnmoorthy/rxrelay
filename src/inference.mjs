import { scriptedVoiceReply, TIER_LABELS } from "./pavo.mjs";
import { goalForStatus } from "./dialogue.mjs";

const SYSTEM_PROMPT = `You are Maya, a real phone coordinator at RxRelay.
You sound like a thoughtful, emotionally intelligent human on a care-access line — warm, concise, never corporate-robotic.

Your job: help callers with prescription ACCESS status (pharmacy delays, prior authorization follow-ups, clinic submissions, pickup readiness) and complete an evidence trail.
You are NOT a clinician. Never give dosing, diagnosis, medical advice, coverage determinations, prescribing, Rx changes/transfers, or controlled-inventory answers. For those, hand off to a human.

How to talk:
- Speak in first person as Maya. Use natural contractions (I'm, that's, we'll).
- Acknowledge feelings and context first when the caller vents, tells a long story, or mixes topics.
- Handle complex turns: extract the access-relevant facts, ignore noise, ask one clarifying question if needed.
- You may briefly answer what you are / how this works, then steer back to their case.
- Never dump a numbered menu unless they ask for options.
- Keep replies speakable for phone TTS: 2–5 short sentences. No markdown, bullets, emoji, or JSON.
- Never invent pharmacy/clinic outcomes. Only treat facts the caller (or system action) just established.
- Never claim the case is resolved unless the proof gate is already complete.
- Always leave a gentle next step that advances the real task when appropriate.

PAVO note (internal): when speech is uncertain on names/dates/auth numbers, confirm before acting — a stronger model cannot repair a misheard number.`;

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
    // Prefer the strong model for natural conversation quality on coordination turns.
    if (route.tier === "verified" || route.tier === "balanced" || route.jointUpgrade) {
      return process.env.PAVO_STRONG_MODEL || process.env.PAVO_FAST_MODEL;
    }
    return process.env.PAVO_STRONG_MODEL || process.env.PAVO_FAST_MODEL;
  }

  maxTokensFor(route) {
    if (route.tier === "verified") return 320;
    if (route.tier === "balanced") return 280;
    return 220;
  }

  async respond({
    transcript,
    route,
    caseBrief,
    consentRecorded = false,
    statusKey = "intake",
    dialogueHint = "",
    conversationDigest = "",
    actionTaken = null,
    intent = "chat",
    callerNotes = {},
  }) {
    const fallback = scriptedVoiceReply(route, { consentRecorded, statusKey });
    if (!this.configuredFor(route)) {
      return { text: fallback, source: "local-safe-fallback", model: null, pipeline: TIER_LABELS[route.tier] };
    }
    const endpoint = `${process.env.PAVO_OPENAI_BASE_URL.replace(/\/$/, "")}/responses`;
    const labels = TIER_LABELS[route.tier] || TIER_LABELS.fast;
    const demand = route.signals?.demand ?? null;
    const goal = dialogueHint || goalForStatus(statusKey, { consented: consentRecorded });
    const input = [
      SYSTEM_PROMPT,
      "",
      `Case context: ${caseBrief}`,
      `Detected intent: ${intent}`,
      actionTaken ? `System action just completed: ${actionTaken}. Acknowledge it naturally; do not redo it.` : "No system state transition this turn — converse and gently advance the goal.",
      `Caller notes so far: ${JSON.stringify(callerNotes || {})}`,
      `Current task goal: ${goal}`,
      conversationDigest ? `Recent conversation:\n${conversationDigest}` : "Recent conversation: (start of call)",
      `Caller just said: ${transcript}`,
      `PAVO route: ${route.tier}; demand=${demand}; jointUpgrade=${Boolean(route.jointUpgrade)}`,
      `Guardrail: ${route.guardrail}`,
      "Reply as Maya for spoken playback only.",
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
