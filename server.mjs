import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CaseStore, PERMITTED_ACTIONS } from "./src/store.mjs";
import { JsonCasePersistence } from "./src/persist.mjs";
import { createTelephonyAdapter, liveTelephonyMissing, normalizeA1MobileEvent } from "./src/telephony.mjs";
import { caseBus } from "./src/bus.mjs";
import { verifyProofReceipt } from "./src/receipt.mjs";
import { peekCounterpartToken } from "./src/counterpart.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const store = new CaseStore({
  telephony: createTelephonyAdapter(),
  persistence: new JsonCasePersistence(),
});
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const sseClients = new Set();

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  const contentType = String(req.headers["content-type"] || "");
  if (contentType.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
  try { return JSON.parse(raw); }
  catch { throw new Error("Request body must be valid JSON or form data."); }
}

function xmlEscape(value = "") {
  return String(value).replace(/[<>&'\"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[character]));
}

function texml(res, instructions) {
  res.writeHead(200, { "content-type": "application/xml; charset=utf-8", "cache-control": "no-store" });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${instructions}</Response>`);
}

function voiceBaseUrl() {
  return (process.env.PUBLIC_APP_URL || `http://${HOST}:${PORT}`).replace(/\/$/, "");
}

function voiceUrl(pathname, params = {}) {
  const url = new URL(`${voiceBaseUrl()}${pathname}`);
  if (process.env.VOICE_WEBHOOK_TOKEN) url.searchParams.set("token", process.env.VOICE_WEBHOOK_TOKEN);
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  return url.toString();
}

function voiceTokenValid(requestUrl) {
  return !process.env.VOICE_WEBHOOK_TOKEN || requestUrl.searchParams.get("token") === process.env.VOICE_WEBHOOK_TOKEN;
}

function gather(say, actionUrl, verified = false) {
  const input = verified ? "speech dtmf" : "speech";
  return `<Gather input="${input}" action="${xmlEscape(actionUrl)}" method="POST" timeout="7" speechTimeout="auto" language="en-US"${verified ? ' numDigits="8"' : ""}><Say>${xmlEscape(say)}</Say></Gather><Say>I did not hear a response. Please call back when you are ready.</Say>`;
}

function config() {
  const provider = process.env.TELEPHONY_PROVIDER || "demo";
  const live = provider === "a1mobile" && process.env.ALLOW_LIVE_TELEPHONY === "true";
  const missing = provider === "a1mobile" ? liveTelephonyMissing() : [];
  return {
    mode: live && missing.length === 0 ? "live-configured" : provider === "a1mobile" ? "live-incomplete" : "sandbox",
    provider,
    liveReadiness: { ready: live && missing.length === 0, missing },
    publicAppUrl: process.env.PUBLIC_APP_URL || `http://localhost:${PORT}`,
    features: {
      proofReceipts: true,
      liveEventStream: true,
      counterpartPortal: true,
      humanOpsQueue: true,
      verifiedDigitCapture: true,
      timeoutEscalation: true,
    },
    safety: "No clinical advice, prescribing, controlled-medication inventory, or unconsented outreach.",
    permittedActions: PERMITTED_ACTIONS,
  };
}

function signatureLooksValid(req, rawBody) {
  const secret = process.env.A1MOBILE_WEBHOOK_SECRET;
  if (!secret) return process.env.ALLOW_LIVE_TELEPHONY !== "true";
  const supplied = req.headers[process.env.A1MOBILE_WEBHOOK_SIGNATURE_HEADER || "x-a1mobile-signature"];
  if (!supplied || Array.isArray(supplied)) return false;
  const normalized = supplied.replace(/^sha256=/i, "").trim();
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(normalized), Buffer.from(expected)); }
  catch { return false; }
}

async function serveStatic(urlPath, res) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const file = path.resolve(publicDir, `.${requested}`);
  if (!file.startsWith(`${publicDir}${path.sep}`)) return json(res, 403, { error: "Forbidden" });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

function broadcastSse(envelope) {
  const payload = `id: ${envelope.id}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); }
    catch { sseClients.delete(client); }
  }
}

caseBus.on("case", broadcastSse);

function attestPage(token, meta) {
  const role = meta?.role || "counterpart";
  const status = meta?.status || "missing";
  const disabled = status !== "open";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>RxRelay counterpart attestation</title>
<style>
:root{--ink:#062033;--teal:#0f9f8f;--bg:#f2f7f8;--line:#d5e2e6;--danger:#b42318}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 "Sora",system-ui,sans-serif;background:radial-gradient(circle at top left,#d9f4ef,transparent 40%),var(--bg);color:var(--ink)}
main{max-width:560px;margin:8vh auto;padding:28px;background:#fff;border:1px solid var(--line);border-radius:18px;box-shadow:0 24px 60px rgba(6,32,51,.08)}
h1{font-size:1.45rem;margin:0 0 .4rem}p{margin:.35rem 0 1rem;color:#466070}
label{display:block;font-size:.85rem;margin:1rem 0 .35rem}select,textarea,button{width:100%;padding:.85rem 1rem;border-radius:12px;border:1px solid var(--line);font:inherit}
button{background:var(--teal);color:#fff;border:0;font-weight:600;cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}
.badge{display:inline-block;padding:.2rem .55rem;border-radius:999px;background:#e7f7f4;color:#0b6f64;font-size:.75rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.warn{color:var(--danger)}
</style></head><body><main>
<span class="badge">${role} portal</span>
<h1>Attest a counterpart outcome</h1>
<p>RxRelay only closes cases when a counterpart confirms what happened. This link is single-use and scoped to one case.</p>
<p class="${disabled ? "warn" : ""}">Link status: <strong>${status}</strong>${meta?.caseId ? ` · case ${meta.caseId}` : ""}</p>
<form method="POST" action="/attest/${token}">
<label for="outcome">Outcome</label>
<select id="outcome" name="outcome" ${disabled ? "disabled" : ""}>
<option value="pharmacy_blocker">Pharmacy: prior authorization / blocker needed</option>
<option value="clinic_submission">Clinic: prior authorization submitted</option>
<option value="pharmacy_ready">Pharmacy: ready for pickup</option>
<option value="insurer_update">Insurer: coverage-status note</option>
</select>
<label for="reference">Reference (optional)</label>
<textarea id="reference" name="reference" rows="2" placeholder="PA-2048" ${disabled ? "disabled" : ""}></textarea>
<label for="note">Note (optional)</label>
<textarea id="note" name="note" rows="3" placeholder="Minimum-necessary non-clinical note" ${disabled ? "disabled" : ""}></textarea>
<button type="submit" ${disabled ? "disabled" : ""}>Submit attestation</button>
</form>
<p style="margin-top:1.4rem;font-size:.85rem;color:#6a7f8a">No clinical advice. Minimum necessary status facts only.</p>
</main></body></html>`;
}

async function handleMcp(req, res) {
  const request = await body(req);
  const id = request.id ?? null;
  const method = request.method;
  const success = (result) => json(res, 200, { jsonrpc: "2.0", id, result });
  const failure = (message) => json(res, 200, { jsonrpc: "2.0", id, error: { code: -32602, message } });
  if (method === "initialize") return success({ protocolVersion: "2024-11-05", serverInfo: { name: "rxrelay", version: "0.2.0" }, capabilities: { tools: {} } });
  if (method === "tools/list") {
    return success({ tools: [
      { name: "create_rx_case", description: "Create a consent-gated prescription access coordination case.", inputSchema: { type: "object", properties: { patientAlias: { type: "string" }, recipient: { type: "string" }, medication: { type: "string" }, transcript: { type: "string" } }, required: ["patientAlias", "recipient"] } },
      { name: "record_consent", description: "Record explicit patient consent before any coordination activity.", inputSchema: { type: "object", properties: { caseId: { type: "string" }, granted: { type: "boolean" }, statement: { type: "string" } }, required: ["caseId", "granted"] } },
      { name: "begin_coordination_call", description: "Begin a non-clinical pharmacy status call for a consented case.", inputSchema: { type: "object", properties: { caseId: { type: "string" } }, required: ["caseId"] } },
      { name: "record_external_outcome", description: "Record a sandbox counterpart result without inventing evidence.", inputSchema: { type: "object", properties: { caseId: { type: "string" }, outcome: { type: "string", enum: ["pharmacy_blocker", "clinic_submission", "pharmacy_ready"] } }, required: ["caseId", "outcome"] } },
      { name: "issue_counterpart_link", description: "Issue a single-use magic link for pharmacy/clinic/insurer attestation.", inputSchema: { type: "object", properties: { caseId: { type: "string" }, role: { type: "string", enum: ["pharmacy", "clinic", "insurer"] } }, required: ["caseId"] } },
      { name: "export_proof_receipt", description: "Export a signed hash-chained proof receipt for a resolved case.", inputSchema: { type: "object", properties: { caseId: { type: "string" } }, required: ["caseId"] } },
      { name: "get_case_brief", description: "Get the case status and deterministic resolution proof.", inputSchema: { type: "object", properties: { caseId: { type: "string" } }, required: ["caseId"] } },
      { name: "list_human_queue", description: "List cases held for human review.", inputSchema: { type: "object", properties: {} } },
    ] });
  }
  if (method !== "tools/call") return failure("Unsupported MCP method.");
  const { name, arguments: args = {} } = request.params || {};
  try {
    let result;
    if (name === "create_rx_case") result = store.createCase(args);
    else if (name === "record_consent") result = store.recordConsent(args.caseId, args);
    else if (name === "begin_coordination_call") result = await store.beginCoordination(args.caseId);
    else if (name === "record_external_outcome") {
      result = args.outcome === "pharmacy_blocker" ? store.recordPharmacyBlocker(args.caseId)
        : args.outcome === "clinic_submission" ? store.recordClinicSubmission(args.caseId)
          : args.outcome === "pharmacy_ready" ? await store.recordPharmacyReady(args.caseId)
            : (() => { throw new Error("Unknown outcome."); })();
    } else if (name === "issue_counterpart_link") result = store.issueCounterpartLink(args.caseId, args.role || "pharmacy");
    else if (name === "export_proof_receipt") result = store.exportReceipt(args.caseId);
    else if (name === "get_case_brief") result = store.get(args.caseId);
    else if (name === "list_human_queue") result = store.listHumanQueue();
    else return failure("Unknown tool.");
    return success({ content: [{ type: "text", text: JSON.stringify(result) }] });
  } catch (error) { return failure(error.message); }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;
  try {
    if (pathname === "/api/health" && req.method === "GET") return json(res, 200, { ok: true, ...config(), time: new Date().toISOString() });
    if (pathname === "/api/config" && req.method === "GET") return json(res, 200, config());
    if (pathname === "/api/cases" && req.method === "GET") return json(res, 200, { cases: store.list() });
    if (pathname === "/api/cases" && req.method === "POST") return json(res, 201, { case: store.createCase(await body(req)) });
    if (pathname === "/api/ops/queue" && req.method === "GET") return json(res, 200, { queue: store.listHumanQueue() });
    if (pathname === "/api/ops/timeout-scan" && req.method === "POST") {
      const payload = await body(req);
      return json(res, 200, { escalated: store.markStaleForHumanReview(Number(payload.maxAgeMs) || 1000 * 60 * 30) });
    }
    if (pathname === "/api/receipts/verify" && req.method === "POST") return json(res, 200, verifyProofReceipt(await body(req)));
    if (pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, at: new Date().toISOString() })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    if (pathname === "/mcp" && req.method === "POST") return handleMcp(req, res);

    const caseMatch = pathname.match(/^\/api\/cases\/([^/]+)$/);
    if (caseMatch && req.method === "GET") return json(res, 200, { case: store.get(decodeURIComponent(caseMatch[1])) });

    const actionMatch = pathname.match(/^\/api\/cases\/([^/]+)\/(consent|start|pharmacy-blocker|clinic-submission|pharmacy-ready|send-update|escalate|resume|counterpart-link|receipt)$/);
    if (actionMatch && req.method === "POST") {
      const caseId = decodeURIComponent(actionMatch[1]);
      const action = actionMatch[2];
      const payload = await body(req);
      let updated;
      if (action === "consent") updated = store.recordConsent(caseId, payload);
      if (action === "start") updated = await store.beginCoordination(caseId);
      if (action === "pharmacy-blocker") updated = store.recordPharmacyBlocker(caseId, payload);
      if (action === "clinic-submission") updated = store.recordClinicSubmission(caseId, payload);
      if (action === "pharmacy-ready") updated = await store.recordPharmacyReady(caseId);
      if (action === "send-update") updated = await store.sendPatientUpdate(caseId, payload.text || "We are still coordinating your prescription access status.");
      if (action === "escalate") updated = store.escalate(caseId, payload.reason);
      if (action === "resume") updated = store.resumeAutomation(caseId, payload.reason);
      if (action === "counterpart-link") {
        const issued = store.issueCounterpartLink(caseId, payload.role || "pharmacy");
        const base = `${requestUrl.protocol}//${requestUrl.host}`;
        return json(res, 200, { ...issued, url: `${base}/attest/${issued.link.token}` });
      }
      if (action === "receipt") return json(res, 200, { receipt: store.exportReceipt(caseId) });
      return json(res, 200, { case: updated });
    }

    const attestMatch = pathname.match(/^\/attest\/([^/]+)$/);
    if (attestMatch && req.method === "GET") {
      const token = decodeURIComponent(attestMatch[1]);
      const meta = peekCounterpartToken(token);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(attestPage(token, meta));
    }
    if (attestMatch && req.method === "POST") {
      const token = decodeURIComponent(attestMatch[1]);
      const payload = await body(req);
      const updated = await store.attestCounterpart(token, payload);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h1>Attestation recorded</h1><p>Case ${updated.id} is now ${updated.status.label}.</p><p>Proof: ${updated.proof.ready ? "complete" : "still open"}.</p></body></html>`);
    }

    if (pathname === "/api/demo/inbound-call" && req.method === "POST") {
      const payload = await body(req);
      return json(res, 200, await store.inboundTurn(payload));
    }

    if (pathname === "/voice" && ["GET", "POST"].includes(req.method)) {
      if (!voiceTokenValid(requestUrl)) return json(res, 401, { error: "Invalid voice webhook token." });
      const payload = req.method === "POST" ? await body(req) : Object.fromEntries(requestUrl.searchParams);
      const caseRecord = store.openVoiceCase({ callId: payload.CallSid || payload.call_id, from: payload.From || payload.from });
      const action = voiceUrl("/voice/turn", { caseId: caseRecord.id });
      return texml(res, gather("Hi, you reached RxRelay. I can coordinate a prescription access status follow-up. I do not provide medical advice or change prescriptions. To continue, say: I consent to a pharmacy status follow-up and text updates.", action));
    }

    if (pathname === "/voice/turn" && ["GET", "POST"].includes(req.method)) {
      if (!voiceTokenValid(requestUrl)) return json(res, 401, { error: "Invalid voice webhook token." });
      const payload = req.method === "POST" ? await body(req) : Object.fromEntries(requestUrl.searchParams);
      const caseId = requestUrl.searchParams.get("caseId") || payload.caseId;
      if (!caseId) return texml(res, "<Say>Your voice session is missing a case reference. Please call again.</Say>");
      const digits = String(payload.Digits || "").trim();
      const speech = String(payload.SpeechResult || payload.speech_result || payload.transcript || "").trim();
      const transcript = digits ? `${speech ? `${speech} ` : ""}authorization digits ${digits.split("").join(" ")}`.trim() : speech;
      const result = await store.handleVoiceTurn({
        caseId,
        transcript,
        asrConfidence: Number(payload.Confidence || payload.confidence || (digits ? 0.99 : 0.9)),
        noiseLevel: Number(payload.noiseLevel || (digits ? 0.02 : 0.1)),
      });
      const verified = result.route?.tier === "verified";
      const followUp = result.case.humanReview
        ? "A human coordinator will review this safely. I will not take further automated action."
        : result.reply;
      return texml(res, gather(followUp, voiceUrl("/voice/turn", { caseId }), verified));
    }

    if (pathname === "/api/telephony/a1mobile/events" && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!signatureLooksValid(req, raw)) return json(res, 401, { error: "Invalid webhook signature." });
      let payload;
      try { payload = JSON.parse(raw || "{}"); } catch { return json(res, 400, { error: "Webhook payload must be JSON." }); }
      return json(res, 200, await store.receiveWebhook(normalizeA1MobileEvent(payload)));
    }

    return serveStatic(pathname, res);
  } catch (error) {
    const status = /not found/.test(error.message) ? 404 : /required|not in|before|invalid|expired|already used/i.test(error.message) ? 422 : 400;
    return json(res, status, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`RxRelay listening at http://${HOST}:${PORT} (${config().mode} mode)`);
});
