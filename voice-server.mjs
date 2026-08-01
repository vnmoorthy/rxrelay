import http from "node:http";
import { CaseStore } from "./src/store.mjs";
import { JsonCasePersistence } from "./src/persist.mjs";
import { createTelephonyAdapter } from "./src/telephony.mjs";
import { TIER_LABELS } from "./src/pavo.mjs";
import { openPrompt, noInputPrompt, sayVoiceAttrs, isUsableSpeech } from "./src/dialogue.mjs";

const store = new CaseStore({
  telephony: createTelephonyAdapter(),
  persistence: new JsonCasePersistence(),
  seedDemo: false,
});
const PORT = Number(process.env.VOICE_PORT || 3001);
const HOST = process.env.VOICE_HOST || "127.0.0.1";

/** In-memory webhook dedupe: identical TeXML retries must not double-advance state. */
const recentTurnKeys = new Map();
const TURN_DEDUPE_MS = 20_000;

function xmlEscape(value = "") {
  return String(value).replace(/[<>&'\"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[character]));
}

function sendXml(res, instruction) {
  res.writeHead(200, { "content-type": "application/xml; charset=utf-8", "cache-control": "no-store" });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${instruction}</Response>`);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

async function parseRequest(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32_000) throw new Error("Voice webhook body is too large.");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  const type = String(req.headers["content-type"] || "");
  if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
  return JSON.parse(raw);
}

function requestBase(req) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  const proto = String(req.headers["x-forwarded-proto"] || (host.includes("localhost") || host.startsWith("127.") ? "http" : "https")).split(",")[0].trim();
  if (!host) throw new Error("Voice webhook host is missing.");
  return `${proto}://${host}`;
}

function nextUrl(req, pathname, params = {}) {
  const url = new URL(`${requestBase(req)}${pathname}`);
  url.searchParams.set("token", process.env.VOICE_WEBHOOK_TOKEN || "");
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  return url.toString();
}

function authorized(url) {
  return Boolean(process.env.VOICE_WEBHOOK_TOKEN) && url.searchParams.get("token") === process.env.VOICE_WEBHOOK_TOKEN;
}

function say(text) {
  return `<Say${sayVoiceAttrs()}>${xmlEscape(text)}</Say>`;
}

/**
 * STT → Gather. Prompt plays inside Gather (one prompt only).
 * Critical: `timeout` must be long enough for the Say prompt PLUS the caller
 * reply. timeout="5" with a multi-sentence greeting timed out before the
 * caller could speak → endless "Sorry, I didn't catch that."
 * Keep Say attrs Telnyx-safe (alice only). speechTimeout=auto is required for
 * speech gathers on Telnyx; without it SpeechResult often never arrives.
 */
function gather(prompt, action, { verified = false } = {}) {
  const input = verified ? "speech dtmf" : "speech";
  const numDigits = verified ? ' numDigits="8"' : "";
  return `<Gather input="${input}" action="${xmlEscape(action)}" method="POST" timeout="12" speechTimeout="auto" language="en-US"${numDigits}>${say(prompt)}</Gather><Redirect method="POST">${xmlEscape(action)}</Redirect>`;
}

function turnDedupeKey(caseId, payload) {
  const callId = payload.CallSid || payload.call_id || "";
  const speech = String(payload.SpeechResult || payload.speech_result || payload.transcript || "").trim().toLowerCase();
  const digits = String(payload.Digits || payload.digits || "").trim();
  return `${caseId}|${callId}|${speech}|${digits}`;
}

function rememberTurn(key, instruction) {
  recentTurnKeys.set(key, { instruction, at: Date.now() });
  if (recentTurnKeys.size > 200) {
    const cutoff = Date.now() - TURN_DEDUPE_MS;
    for (const [k, v] of recentTurnKeys) if (v.at < cutoff) recentTurnKeys.delete(k);
  }
}

function replayIfDuplicate(key) {
  const prev = recentTurnKeys.get(key);
  if (!prev) return null;
  if (Date.now() - prev.at > TURN_DEDUPE_MS) {
    recentTurnKeys.delete(key);
    return null;
  }
  return prev.instruction;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/health" && req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        service: "rxrelay-voice",
        model: process.env.PAVO_STRONG_MODEL || process.env.PAVO_FAST_MODEL || null,
        chatModel: process.env.PAVO_CHAT_MODEL || null,
        fastModel: process.env.PAVO_FAST_MODEL || null,
        strongModel: process.env.PAVO_STRONG_MODEL || null,
        inferenceBase: process.env.PAVO_OPENAI_BASE_URL ? String(process.env.PAVO_OPENAI_BASE_URL).replace(/\/$/, "") : null,
        captureUpgrade: TIER_LABELS.verified.captureMode,
        voice: process.env.TEXML_VOICE || "alice",
      });
    }
    if (!["GET", "POST"].includes(req.method) || !["/voice", "/voice/turn"].includes(url.pathname)) {
      return sendJson(res, 404, { error: "Not found." });
    }
    if (!authorized(url)) return sendJson(res, 401, { error: "Invalid voice webhook token." });
    const payload = req.method === "POST" ? await parseRequest(req) : Object.fromEntries(url.searchParams);
    if (url.pathname === "/voice") {
      const caseRecord = store.openVoiceCase({ callId: payload.CallSid || payload.call_id, from: payload.From || payload.from });
      const instruction = gather(openPrompt(), nextUrl(req, "/voice/turn", { caseId: caseRecord.id }));
      return sendXml(res, instruction);
    }

    const caseId = url.searchParams.get("caseId") || payload.caseId;
    if (!caseId) return sendXml(res, say("Your voice session is missing a case reference. Please call again."));

    const dedupeKey = turnDedupeKey(caseId, payload);
    const replay = replayIfDuplicate(dedupeKey);
    if (replay) return sendXml(res, replay);

    const digits = String(payload.Digits || payload.digits || "").trim();
    // Telnyx / TeXML variants — never drop a real transcript on a field-name mismatch.
    const speech = String(
      payload.SpeechResult
      || payload.speech_result
      || payload.UnstableSpeechResult
      || payload.RecognitionResult
      || payload.Speech
      || payload.transcript
      || payload.TranscriptionText
      || "",
    ).trim();
    const confidenceRaw = payload.Confidence ?? payload.SpeechResultConfidence ?? payload.confidence ?? payload.Stability;
    const confidence = Number(confidenceRaw);
    const confidenceOrDefault = Number.isFinite(confidence) && confidence > 0
      ? confidence
      : (digits ? 0.99 : 0.85);

    console.log(JSON.stringify({
      at: new Date().toISOString(),
      turn: "inbound",
      caseId,
      keys: Object.keys(payload).slice(0, 30),
      speech: speech.slice(0, 160),
      digits: digits || null,
      confidence: confidenceOrDefault,
      confidenceRaw: confidenceRaw ?? null,
    }));

    const quality = digits
      ? { ok: true, reason: "digits", text: `${speech ? `${speech} ` : ""}authorization digits ${digits.split("").join(" ")}`.trim() }
      : isUsableSpeech(speech, confidenceOrDefault);

    if (!quality.ok) {
      const retry = Number(url.searchParams.get("retry") || 0);
      console.log(JSON.stringify({ at: new Date().toISOString(), turn: "rejected", caseId, reason: quality.reason, confidence: confidenceOrDefault, speech: speech.slice(0, 120), retry }));
      // Rotate the re-prompt (never the identical line twice) and carry a retry counter.
      const instruction = gather(noInputPrompt(retry), nextUrl(req, "/voice/turn", { caseId, retry: String(retry + 1) }));
      // Do not dedupe empty/garbage — retries should re-prompt, not lock a blank turn.
      return sendXml(res, instruction);
    }

    const startedAt = Date.now();
    const result = await store.handleVoiceTurn({
      caseId,
      transcript: quality.text,
      asrConfidence: confidenceOrDefault,
      noiseLevel: Number(payload.noiseLevel || (digits ? 0.02 : 0.1)),
    });
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      turn: "ok",
      caseId,
      speech: quality.text.slice(0, 140),
      confidence: confidenceOrDefault,
      intent: result.intent,
      action: result.action,
      source: result.inference?.source,
      status: result.case?.status?.key,
      proofReady: Boolean(result.case?.proof?.ready),
      ms: Date.now() - startedAt,
      reply: String(result.reply || "").slice(0, 140),
    }));

    const verified = result.route?.tier === "verified" || result.route?.jointUpgrade;
    let spoken = result.reply;
    if (verified && !digits && !result.case.humanReview && !result.case.digitHintSpoken) {
      spoken = `${spoken} If you have a reference number, you can enter the digits on your keypad.`;
      try {
        store.markDigitHintSpoken?.(caseId);
      } catch {
        /* optional */
      }
    }

    const proofReady = result.case?.proof?.ready || result.case?.status?.key === "resolved";
    // Clean hangup after 4/4 proof — avoids a dangling Gather / "anything else?" loop.
    const instruction = proofReady
      ? `${say(spoken)}<Hangup/>`
      : gather(spoken, nextUrl(req, "/voice/turn", { caseId }), { verified });
    rememberTurn(dedupeKey, instruction);
    return sendXml(res, instruction);
  } catch (error) {
    console.error("voice webhook error:", error?.stack || error);
    return sendXml(res, say("RxRelay had a temporary issue. Please try again shortly, or ask for a human coordinator."));
  }
});

server.listen(PORT, HOST, () => console.log(`RxRelay voice gateway listening on ${HOST}:${PORT}`));
