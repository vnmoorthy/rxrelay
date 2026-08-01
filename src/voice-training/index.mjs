/**
 * Practical voice "training" layer for RxRelay.
 * Not a model fine-tune — curated lexicon + few-shot exemplars that improve
 * TeXML STT hints, ASR phrase repair, intent/consent coverage, and Maya prompts.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)));
const lexiconPath = join(root, "lexicon.json");

let cached = null;

export function loadVoiceLexicon() {
  if (cached) return cached;
  cached = JSON.parse(readFileSync(lexiconPath, "utf8"));
  return cached;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compile lexicon ASR repairs into [RegExp, replacement] pairs. */
export function lexiconAsrRepairs() {
  const { asrRepairs = [] } = loadVoiceLexicon();
  return asrRepairs.map(([from, to]) => {
    const escaped = escapeRegExp(from).replace(/ +/g, "\\s+");
    const pattern = new RegExp(`\\b${escaped}\\b`, "gi");
    return [pattern, to];
  });
}

/** Telnyx Gather speech hints — comma-separated, capped for TeXML size. */
export function gatherSpeechHintsAttr(limit = 24) {
  const hints = (loadVoiceLexicon().speechHints || []).slice(0, limit);
  if (!hints.length) return "";
  const joined = hints.join(", ").replace(/"/g, "");
  return ` hints="${joined}"`;
}

/** Few-shot block injected into the LLM system input. */
export function fewShotPromptBlock(limit = 6) {
  const exemplars = (loadVoiceLexicon().fewShotExemplars || []).slice(0, limit);
  if (!exemplars.length) return "";
  const lines = [
    "Style exemplars (match brevity and tone; do not copy verbatim unless the situation matches):",
  ];
  for (const ex of exemplars) {
    lines.push(`Caller: ${ex.caller}`);
    lines.push(`Maya: ${ex.maya}`);
  }
  return lines.join("\n");
}

/** Best matching exemplar Maya line for a beat/intent (scripted polish). */
export function exemplarReplyFor(beatOrIntent = "") {
  const key = String(beatOrIntent || "").toLowerCase();
  const map = {
    consent: "help_consent",
    start_coordination: "help_consent",
    pharmacy_blocker: "pharmacy_blocker",
    clinic_submission: "clinic_submission",
    pharmacy_ready: "pharmacy_ready",
    escalate: "escalate",
    vent: "vent",
    still_waiting: "still_waiting",
    off_topic: "off_topic",
    help_consent: "help_consent",
  };
  const beat = map[key] || key;
  const hit = (loadVoiceLexicon().fewShotExemplars || []).find((ex) => ex.beat === beat);
  return hit?.maya || "";
}

function includesAny(haystack, phrases = []) {
  const t = haystack.toLowerCase();
  return phrases.some((p) => t.includes(String(p).toLowerCase()));
}

/**
 * Lexicon-backed intent hints used after core regexes miss.
 * Returns an intent string or null.
 */
export function lexiconIntentHint(transcript = "", statusKey = "intake") {
  const t = String(transcript || "").toLowerCase();
  const phrases = loadVoiceLexicon().intentPhrases || {};
  const order = [
    "escalate",
    "vent",
    "ask_options",
    "summarize",
    "off_topic",
    "clinic_submission",
    "pharmacy_ready",
    "pharmacy_blocker",
    "still_waiting",
  ];
  for (const intent of order) {
    if (includesAny(t, phrases[intent] || [])) return intent;
  }
  if (statusKey === "ready" || statusKey === "intake" || !statusKey) {
    const pureConsent = /\bi\s+consent\b|\bi\s+give\s+(?:you\s+)?permission\b|\byou\s+have\s+my\s+permission\b/i.test(t)
      && !/\b(check|please help|help me|can you help|stuck|been waiting|find out|look into|what'?s going on|chase|track)\b/i.test(t);
    if (!pureConsent && includesAny(t, phrases.start_coordination || [])) return "start_coordination";
  }
  if (includesAny(t, phrases.thanks || [])) return "thanks";
  return null;
}

export function lexiconConsentParse(transcript = "") {
  const t = String(transcript || "");
  const c = loadVoiceLexicon().consent || {};
  const declines = includesAny(t, c.decline || []);
  if (declines) return { granted: false, scoped: true, saysConsent: false, softAsk: false, fromLexicon: true };

  const saysConsent = includesAny(t, c.explicit || []);
  const softAskCore = includesAny(t, c.softAsk || []);
  const story = includesAny(t, c.story || []);
  const scoped = includesAny(t, c.scope || []) || saysConsent || softAskCore || story;
  const softAsk = (softAskCore && scoped) || (story && scoped);
  const granted = Boolean((saysConsent && scoped) || softAsk);

  return {
    granted,
    scoped: Boolean(scoped),
    saysConsent: Boolean(saysConsent),
    softAsk: Boolean(softAsk),
    fromLexicon: true,
  };
}

export function lexiconMeta() {
  const lex = loadVoiceLexicon();
  return {
    version: lex.version,
    speechHintCount: (lex.speechHints || []).length,
    asrRepairCount: (lex.asrRepairs || []).length,
    exemplarCount: (lex.fewShotExemplars || []).length,
    intentBuckets: Object.keys(lex.intentPhrases || {}).length,
  };
}
