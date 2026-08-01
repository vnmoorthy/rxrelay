import { scriptedVoiceReply, TIER_LABELS } from "./pavo.mjs";
import { goalForStatus } from "./dialogue.mjs";
import { formatFewShotBlock } from "./voice-lexicon.mjs";
// formatFewShotBlock pulls mined exemplars from src/voice-training/lexicon.json

const SYSTEM_PROMPT = `You are Maya at RxRelay — a calm phone coordinator for prescription-access status. You also answer ordinary non-clinical questions briefly when asked.

You are on a live phone call. Sound like a competent human, not an IVR or chatbot.

Response rules:
1. Speak naturally in about 2–4 short sentences (phone-friendly). Prefer warmth and clarity over telegraphic fragments.
2. Answer what they just said first. Do not restate your previous reply or the same goal again.
3. Acknowledge facts they gave (pharmacy, med, wait days), then act on the case trail when evidence arrives.
4. Ask at most ONE question, and only if you need a fact to advance the case. Never interrogate.
5. Never recite menus, legal disclaimers, or "I understand" filler.
6. Never end with "Is there anything else I can help you with?"
7. Never re-ask for consent or permission once Case context says consent=true.
8. Never re-ask the same status question you already asked in Your previous spoken lines.
9. Mirror the tone of the few-shot examples: warm, concrete, human.

Truth rules — non-negotiable:
- Never claim you searched, called, texted, or completed an action unless System action just completed says so.
- Never invent pharmacy/clinic outcomes.
- No diagnosis, dosing, prescribing, Rx changes, or inventory answers.
- Urgent symptoms / self-harm: urge emergency services briefly; stop automation.

Four-layer path (advance with natural speech — do not quiz robotically):
help/consent → pharmacy status check (PA) → clinic filed → ready → patient SMS/update.
When they describe being stuck after consent, help move that trail using only facts they provide.

Ideal phone style (few-shot — match this warmth):
${formatFewShotBlock()}`;

function responseText(payload) {
  // Chat Completions
  const choice = payload?.choices?.[0]?.message?.content;
  if (typeof choice === "string" && choice.trim()) return choice.trim();
  if (Array.isArray(choice)) {
    const joined = choice.map((part) => (typeof part === "string" ? part : part?.text || "")).join("").trim();
    if (joined) return joined;
  }
  // Responses API fallback (legacy gateways)
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
  // Soft-cap runaway model replies for phone TTS — allow 2–4 natural sentences
  const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [cleaned];
  const words = cleaned.split(/\s+/).filter(Boolean).length;
  if (sentences.length <= 4 && words <= 90) return cleaned;
  return sentences.slice(0, 4).join(" ").trim();
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

  /**
   * Prefer strongest quality (sol) for all live voice turns.
   * Optional PAVO_CHAT_MODEL (e.g. luna) only for pure open-chat fast turns.
   */
  modelFor(route) {
    if (route.tier === "fast" && !route.jointUpgrade && process.env.PAVO_CHAT_MODEL) {
      return process.env.PAVO_CHAT_MODEL;
    }
    return process.env.PAVO_STRONG_MODEL || process.env.PAVO_FAST_MODEL;
  }

  maxTokensFor(route) {
    if (route.tier === "verified") return 280;
    if (route.tier === "balanced") return 220;
    return 180;
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
    const base = process.env.PAVO_OPENAI_BASE_URL.replace(/\/$/, "");
    const endpoint = `${base}/chat/completions`;
    const labels = TIER_LABELS[route.tier] || TIER_LABELS.fast;
    const demand = route.signals?.demand ?? null;
    const goal = dialogueHint || goalForStatus(statusKey, { consented: consentRecorded });
    const priorLines = (lastAssistantReplies?.length
      ? lastAssistantReplies
      : (lastAssistantReply ? [lastAssistantReply] : [])
    ).filter(Boolean);
    const userTurn = [
      `Case context: ${caseBrief}`,
      `Consent already recorded: ${consentRecorded ? "YES — never ask for consent again" : "no"}`,
      `Detected intent: ${intent}`,
      actionTaken
        ? `System action just completed with evidence: ${actionTaken}. Acknowledge once, briefly. Do not invent other completed actions.`
        : "No tool execution this turn — do not claim outreach happened.",
      `Caller notes: ${JSON.stringify(callerNotes || {})}`,
      `Internal goal (do not recite verbatim): ${goal}`,
      priorLines.length
        ? `Your previous spoken lines (do NOT repeat identically or re-ask the same question):\n${priorLines.map((line, i) => `${i + 1}. ${line}`).join("\n")}`
        : "Your previous spoken lines: (none)",
      conversationDigest ? `Recent conversation:\n${conversationDigest}` : "Recent conversation: (start of call)",
      `Caller just said: ${transcript}`,
      `PAVO: tier=${route.tier}; demand=${demand}`,
      "Reply for spoken playback only. About 2–4 short natural sentences. New information only. At most one question.",
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
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userTurn },
          ],
          max_tokens: this.maxTokensFor(route),
        }),
      });
      if (!response.ok) throw new Error(`Chat Completions API returned ${response.status}`);
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
