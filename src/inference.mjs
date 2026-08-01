import { scriptedVoiceReply, TIER_LABELS } from "./pavo.mjs";
import { goalForStatus } from "./dialogue.mjs";
import { formatFewShotBlock } from "./voice-lexicon.mjs";
// formatFewShotBlock pulls mined exemplars from src/voice-training/lexicon.json

const SYSTEM_PROMPT = `You are Maya at RxRelay — a calm phone coordinator for prescription-access status. You also answer ordinary non-clinical questions briefly when asked.

You are on a live phone call. Sound like a competent human, not an IVR.

Response rules (strict):
1. Speak in 1–2 short sentences. Max ~35 words unless summarizing after they ask.
2. Answer what they just said first. Do not restate your previous reply or the same goal again.
3. Ask at most one question, and only if you need a fact to advance the case.
4. Never recite menus, legal disclaimers, or "I understand" filler.
5. Never end with "Is there anything else I can help you with?"
6. Never re-ask for consent or permission once Case context says consent=true.
7. Never re-ask the same status question you already asked in Your previous spoken lines.
8. Mirror the tone of the few-shot examples: warm, brief, concrete.

Truth rules — non-negotiable:
- Never claim you searched, called, texted, or completed an action unless System action just completed says so.
- Never invent pharmacy/clinic outcomes.
- No diagnosis, dosing, prescribing, Rx changes, or inventory answers.
- Urgent symptoms / self-harm: urge emergency services briefly; stop automation.

When they describe being stuck on a prescription after consent, help move the status trail (check → PA → clinic filed → ready) using only facts they provide.

Ideal phone style (few-shot — match this brevity):
${formatFewShotBlock()}`;

function responseText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
  for (const output of payload.output || []) {
    for (const content of output.content || []) {
      if (typeof content.text === "string" && content.text.trim()) return content.text.trim();
    }
  }
  return "";
}

function trimSpoken(text = "") {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  // Soft-cap runaway model replies for phone TTS
  const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [cleaned];
  if (sentences.length <= 2 && cleaned.split(/\s+/).length <= 45) return cleaned;
  return sentences.slice(0, 2).join(" ").trim();
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
    return process.env.PAVO_FAST_MODEL || process.env.PAVO_STRONG_MODEL;
  }

  maxTokensFor(route) {
    if (route.tier === "verified") return 120;
    if (route.tier === "balanced") return 100;
    return 80;
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
    lastAssistantReply = "",
    lastAssistantReplies = [],
    scriptedFallback = "",
  }) {
    const fallback = scriptedFallback
      || scriptedVoiceReply(route, { consentRecorded, statusKey });
    if (!this.configuredFor(route)) {
      return { text: fallback, source: "local-safe-fallback", model: null, pipeline: TIER_LABELS[route.tier] };
    }
    const endpoint = `${process.env.PAVO_OPENAI_BASE_URL.replace(/\/$/, "")}/responses`;
    const labels = TIER_LABELS[route.tier] || TIER_LABELS.fast;
    const demand = route.signals?.demand ?? null;
    const goal = dialogueHint || goalForStatus(statusKey, { consented: consentRecorded });
    const priorLines = (lastAssistantReplies?.length
      ? lastAssistantReplies
      : (lastAssistantReply ? [lastAssistantReply] : [])
    ).filter(Boolean);
    const input = [
      SYSTEM_PROMPT,
      "",
      `Case context: ${caseBrief}`,
      `Consent already recorded: ${consentRecorded ? "YES — never ask for consent again" : "no"}`,
      `Detected intent: ${intent}`,
      actionTaken
        ? `System action just completed with evidence: ${actionTaken}. Acknowledge once, briefly. Do not invent other completed actions.`
        : "No tool execution this turn — do not claim outreach happened.",
      `Caller notes: ${JSON.stringify(callerNotes || {})}`,
      `Internal goal (do not recite verbatim): ${goal}`,
      priorLines.length
        ? `Your previous spoken lines (do NOT repeat, paraphrase, or re-ask the same question):\n${priorLines.map((line, i) => `${i + 1}. ${line}`).join("\n")}`
        : "Your previous spoken lines: (none)",
      conversationDigest ? `Recent conversation:\n${conversationDigest}` : "Recent conversation: (start of call)",
      `Caller just said: ${transcript}`,
      `PAVO: tier=${route.tier}; demand=${demand}`,
      "Reply for spoken playback only. One or two short sentences. New information only.",
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
      const text = trimSpoken(responseText(await response.json()));
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
