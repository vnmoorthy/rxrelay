import http from "node:http";
import { CaseStore } from "./src/store.mjs";
import { JsonCasePersistence } from "./src/persist.mjs";
import { createTelephonyAdapter } from "./src/telephony.mjs";
import { TIER_LABELS } from "./src/pavo.mjs";
import { noInputPrompt, sayVoiceAttrs, isUsableSpeech } from "./src/dialogue.mjs";
import { DEMO_OPEN, resolveDemoInput, fixedReplyForAction } from "./src/demo-beats.mjs";

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
 * Always speech + single DTMF digit so the 4-beat demo works even when ASR fails.
 * Press 1 → 2 → 3 → 4, or speak the four judge lines.
 */
function gather(prompt, action) {
  return `<Gather input="speech dtmf" numDigits="1" action="${xmlEscape(action)}" method="POST" timeout="15" speechTimeout="auto" language="en-US">${say(prompt)}</Gather><Redirect method="POST">${xmlEscape(action)}</Redirect>`;
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
      const instruction = gather(DEMO_OPEN, nextUrl(req, "/voice/turn", { caseId: caseRecord.id }));
      return sendXml(res, instruction);
    }

    const caseId = url.searchParams.get("caseId") || payload.caseId;
    if (!caseId) return sendXml(res, say("Your voice session is missing a case reference. Please call again."));

    const dedupeKey = turnDedupeKey(caseId, payload);
    const replay = replayIfDuplicate(dedupeKey);
    if (replay) return sendXml(res, replay);

    const digits = String(payload.Digits || payload.digits || "").trim();
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

    const demo = resolveDemoInput({ speech, digits });
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      turn: "inbound",
      caseId,
      speech: speech.slice(0, 160),
      digits: digits || null,
      demoBeat: demo?.beat || null,
      via: demo?.via || null,
      confidence: confidenceOrDefault,
    }));

    let transcript = demo?.transcript || null;
    if (!transcript) {
      const quality = isUsableSpeech(speech, confidenceOrDefault);
      if (!quality.ok) {
        const retry = Number(url.searchParams.get("retry") || 0);
        const hint = "Please speak your request, or press 1, then 2, then 3, then 4 on the keypad.";
        const instruction = gather(`${noInputPrompt(retry)} ${hint}`, nextUrl(req, "/voice/turn", { caseId, retry: String(retry + 1) }));
        return sendXml(res, instruction);
      }
      transcript = quality.text;
    }

    const startedAt = Date.now();
    const result = await store.handleVoiceTurn({
      caseId,
      transcript,
      asrConfidence: confidenceOrDefault,
      noiseLevel: Number(payload.noiseLevel || (digits ? 0.02 : 0.1)),
    });

    // Exact fixed Maya lines for the 4-beat demo — judges hear the same script every time.
    let spoken = fixedReplyForAction(result.action) || demo?.fixedReply || result.reply;
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      turn: "ok",
      caseId,
      transcript: transcript.slice(0, 120),
      action: result.action,
      status: result.case?.status?.key,
      proofReady: Boolean(result.case?.proof?.ready),
      ms: Date.now() - startedAt,
      reply: String(spoken || "").slice(0, 160),
    }));

    const proofReady = result.case?.proof?.ready || result.case?.status?.key === "resolved" || result.action === "pharmacy_ready";
    const instruction = proofReady
      ? `${say(spoken)}<Hangup/>`
      : gather(spoken, nextUrl(req, "/voice/turn", { caseId }));
    rememberTurn(dedupeKey, instruction);
    return sendXml(res, instruction);
  } catch (error) {
    console.error("voice webhook error:", error?.stack || error);
    return sendXml(res, say("RxRelay had a temporary issue. Please try again shortly, or ask for a human coordinator."));
  }
});

server.listen(PORT, HOST, () => console.log(`RxRelay voice gateway listening on ${HOST}:${PORT}`));
