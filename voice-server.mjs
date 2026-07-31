import http from "node:http";
import { CaseStore } from "./src/store.mjs";
import { JsonCasePersistence } from "./src/persist.mjs";
import { createTelephonyAdapter } from "./src/telephony.mjs";

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

function gather(say, action) {
  return `<Gather input="speech" action="${xmlEscape(action)}" method="POST" timeout="6" speechTimeout="auto" language="en-US"><Say>${xmlEscape(say)}</Say></Gather><Say>I did not hear a response. Please call back when you are ready.</Say>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/health" && req.method === "GET") return sendJson(res, 200, { ok: true, service: "rxrelay-voice", model: process.env.PAVO_FAST_MODEL || null });
    if (!["GET", "POST"].includes(req.method) || !["/voice", "/voice/turn"].includes(url.pathname)) return sendJson(res, 404, { error: "Not found." });
    if (!authorized(url)) return sendJson(res, 401, { error: "Invalid voice webhook token." });
    const payload = req.method === "POST" ? await parseRequest(req) : Object.fromEntries(url.searchParams);
    if (url.pathname === "/voice") {
      const caseRecord = store.openVoiceCase({ callId: payload.CallSid || payload.call_id, from: payload.From || payload.from });
      return sendXml(res, gather("Hi, you reached RxRelay. I can coordinate a prescription access status follow-up. I do not provide medical advice or change prescriptions. To continue, say: I consent to a pharmacy status follow-up and text updates.", nextUrl(req, "/voice/turn", { caseId: caseRecord.id })));
    }
    const caseId = url.searchParams.get("caseId") || payload.caseId;
    if (!caseId) return sendXml(res, "<Say>Your voice session is missing a case reference. Please call again.</Say>");
    const transcript = payload.SpeechResult || payload.speech_result || payload.transcript || "";
    const result = await store.handleVoiceTurn({ caseId, transcript, asrConfidence: Number(payload.Confidence || payload.confidence || .9), noiseLevel: Number(payload.noiseLevel || .1) });
    const say = result.case.humanReview
      ? "A human coordinator will review this safely. I will not take further automated action."
      : result.reply;
    return sendXml(res, gather(say, nextUrl(req, "/voice/turn", { caseId })));
  } catch (error) {
    return sendXml(res, `<Say>RxRelay had a temporary issue. Please try again shortly.</Say>`);
  }
});

server.listen(PORT, HOST, () => console.log(`RxRelay voice gateway listening on ${HOST}:${PORT}`));
