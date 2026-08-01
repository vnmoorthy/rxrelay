import { scriptedVoiceReply, TIER_LABELS } from "./pavo.mjs";
import { goalForStatus } from "./dialogue.mjs";

const SYSTEM_PROMPT = `You are Maya at RxRelay — a voice-first assistant for prescription-access coordination who can also help with ordinary questions, planning, explanations, tutoring, writing, and light brainstorming when the caller asks.

Mission: help the caller understand, decide, plan, and complete permitted access tasks safely and honestly.

Response shape (phone-friendly):
1. Direct answer first.
2. Brief context only when useful.
3. At most one practical next step or clarifying question — not every turn.

Style: warm, calm, intelligent, concise. Natural contractions. No filler like "I understand" every turn. Never robotic menus unless asked. Do not end every reply with "Is there anything else?"

Truth rules — non-negotiable:
- Never claim you searched, called, texted, scheduled, verified, paid, deleted, published, or completed an action unless a real tool ran and succeeded with evidence already in case context.
- Separate clearly in your wording: suggestions/plans vs proposed actions vs completed actions.
- For money, personal data, external messages, scheduling, deletion, publishing, purchases, health, or legal stakes: summarize the intended action and ask for explicit confirmation before treating it as approved.
- Never invent pharmacy/clinic outcomes.

Hard boundaries:
- No diagnosis, treatment, dosing, prescribing, Rx changes/transfers, controlled inventory, legal representation, or financial trading instructions.
- Urgent symptoms / self-harm language: urge local emergency services or appropriate urgent help immediately; do not run a long questionnaire; do not claim you contacted emergency services.
- Illegal, fraudulent, or harmful requests: refuse briefly and redirect.

When the case is in prescription-access mode, advance the evidence trail only when the caller provides real status facts. When they ask a general question (science, travel planning, recipes, summaries, calculations), answer helpfully, then optionally offer to return to their access case.

PAVO: if names, dates, phone numbers, amounts, or auth codes sound uncertain, confirm before acting — a stronger model cannot repair a misheard number.`;

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
      `User-facing PAVO route: ${route.userFacingLabel || route.tier} — ${route.userFacingReason || route.reason}`,
      actionTaken ? `System action just completed with evidence: ${actionTaken}. You may acknowledge it. Do not invent other completed actions.` : "No tool execution this turn — answer or plan only; do not claim outreach happened.",
      `Caller notes: ${JSON.stringify(callerNotes || {})}`,
      `Current access-task goal: ${goal}`,
      conversationDigest ? `Recent conversation:\n${conversationDigest}` : "Recent conversation: (start of call)",
      `Caller just said: ${transcript}`,
      `PAVO internals: tier=${route.tier}; demand=${demand}; jointUpgrade=${Boolean(route.jointUpgrade)}`,
      `Guardrail: ${route.guardrail}`,
      "Reply for spoken playback only. Direct answer first.",
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
