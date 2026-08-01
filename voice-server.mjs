import http from "node:http";
import { CaseStore } from "./src/store.mjs";
import { JsonCasePersistence } from "./src/persist.mjs";
import { createTelephonyAdapter } from "./src/telephony.mjs";
import { TIER_LABELS } from "./src/pavo.mjs";
import { openPrompt, noInputPrompt, sayVoiceAttrs } from "./src/dialogue.mjs";

const store = new CaseStore({
  telephony: createTelephonyAdapter(),
  persistence: new JsonCasePersistence(),
  seedDemo: false,
});
const PORT = Number(process.env.VOICE_PORT || 3001);
const HOST = process.env.VOICE_HOST || "127.0.0.1";

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
 * PAVO capture upgrade: verified turns open speech + DTMF so critical
 * authorization digits can be confirmed without relying on a better LLM alone.
 * No trailing <Say> after Gather — empty SpeechResult re-prompts once via action URL
 * (avoids double-speaking the miss message).
 */
function gather(prompt, action, { verified = false } = {}) {
  const input = verified ? "speech dtmf" : "speech";
  const hints = ' hints="consent, help with my prescription, pharmacy status, prior authorization, clinic submitted, ready for pickup, CVS, Walgreens, human"';
  const numDigits = verified ? ' numDigits="8"' : "";
  return `<Gather input="${input}" action="${xmlEscape(action)}" method="POST" timeout="8" speechTimeout="auto" language="en-US" profanityFilter="false"${numDigits}${hints}>${say(prompt)}</Gather><Redirect method="POST">${xmlEscape(action)}</Redirect>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/health" && req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        service: "rxrelay-voice",
        model: process.env.PAVO_FAST_MODEL || null,
        captureUpgrade: TIER_LABELS.verified.captureMode,
        voice: process.env.TEXML_VOICE || "Polly.Joanna-Neural",
      });
    }
    if (!["GET", "POST"].includes(req.method) || !["/voice", "/voice/turn"].includes(url.pathname)) {
      return sendJson(res, 404, { error: "Not found." });
    }
    if (!authorized(url)) return sendJson(res, 401, { error: "Invalid voice webhook token." });
    const payload = req.method === "POST" ? await parseRequest(req) : Object.fromEntries(url.searchParams);
    if (url.pathname === "/voice") {
      const caseRecord = store.openVoiceCase({ callId: payload.CallSid || payload.call_id, from: payload.From || payload.from });
      return sendXml(res, gather(openPrompt(), nextUrl(req, "/voice/turn", { caseId: caseRecord.id })));
    }
    const caseId = url.searchParams.get("caseId") || payload.caseId;
    if (!caseId) return sendXml(res, say("Your voice session is missing a case reference. Please call again."));
    const digits = String(payload.Digits || payload.digits || "").trim();
    const speech = String(payload.SpeechResult || payload.speech_result || payload.transcript || "").trim();
    const transcript = digits
      ? `${speech ? `${speech} ` : ""}authorization digits ${digits.split("").join(" ")}`.trim()
      : speech;
    if (!transcript) {
      return sendXml(res, gather(noInputPrompt(), nextUrl(req, "/voice/turn", { caseId })));
    }
    const result = await store.handleVoiceTurn({
      caseId,
      transcript,
      asrConfidence: Number(payload.Confidence || payload.confidence || (digits ? 0.99 : 0.9)),
      noiseLevel: Number(payload.noiseLevel || (digits ? 0.02 : 0.1)),
    });
    const verified = result.route?.tier === "verified" || result.route?.jointUpgrade;
    let spoken = result.reply;
    // Keypad hint once per case — repeating it every verified turn felt robotic.
    if (verified && !digits && !result.case.humanReview && !result.case.digitHintSpoken) {
      spoken = `${spoken} If you have a reference number, you can enter the digits on your keypad.`;
      try {
        store.markDigitHintSpoken?.(caseId);
      } catch {
        /* optional */
      }
    }
    return sendXml(res, gather(spoken, nextUrl(req, "/voice/turn", { caseId }), { verified }));
  } catch {
    return sendXml(res, say("RxRelay had a temporary issue. Please try again shortly, or ask for a human coordinator."));
  }
});

server.listen(PORT, HOST, () => console.log(`RxRelay voice gateway listening on ${HOST}:${PORT}`));
