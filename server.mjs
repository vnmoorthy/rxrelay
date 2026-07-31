import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CaseStore, PERMITTED_ACTIONS } from "./src/store.mjs";
import { createTelephonyAdapter, normalizeA1MobileEvent } from "./src/telephony.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const store = new CaseStore({ telephony: createTelephonyAdapter() });
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";

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
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Request body must be valid JSON."); }
}

function config() {
  const provider = process.env.TELEPHONY_PROVIDER || "demo";
  const live = provider === "a1mobile" && process.env.ALLOW_LIVE_TELEPHONY === "true";
  return {
    mode: live ? "live-configured" : "sandbox",
    provider,
    publicAppUrl: process.env.PUBLIC_APP_URL || `http://localhost:${PORT}`,
    safety: "No clinical advice, prescribing, controlled-medication inventory, or unconsented outreach.",
    permittedActions: PERMITTED_ACTIONS,
  };
}

function signatureLooksValid(req, rawBody) {
  const secret = process.env.A1MOBILE_WEBHOOK_SECRET;
  if (!secret) return process.env.ALLOW_LIVE_TELEPHONY !== "true";
  const supplied = req.headers[process.env.A1MOBILE_WEBHOOK_SIGNATURE_HEADER || "x-a1mobile-signature"];
  if (!supplied || typeof supplied !== "string") return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)); }
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

async function handleMcp(req, res) {
  const request = await body(req);
  const id = request.id ?? null;
  const method = request.method;
  const success = (result) => json(res, 200, { jsonrpc: "2.0", id, result });
  const failure = (message) => json(res, 200, { jsonrpc: "2.0", id, error: { code: -32602, message } });
  if (method === "initialize") return success({ protocolVersion: "2024-11-05", serverInfo: { name: "rxrelay", version: "0.1.0" }, capabilities: { tools: {} } });
  if (method === "tools/list") {
    return success({ tools: [
      { name: "create_rx_case", description: "Create a consent-gated prescription access coordination case.", inputSchema: { type: "object", properties: { patientAlias: { type: "string" }, recipient: { type: "string" }, medication: { type: "string" }, transcript: { type: "string" } }, required: ["patientAlias", "recipient"] } },
      { name: "record_consent", description: "Record explicit patient consent before any coordination activity.", inputSchema: { type: "object", properties: { caseId: { type: "string" }, granted: { type: "boolean" }, statement: { type: "string" } }, required: ["caseId", "granted"] } },
      { name: "begin_coordination_call", description: "Begin a non-clinical pharmacy status call for a consented case.", inputSchema: { type: "object", properties: { caseId: { type: "string" } }, required: ["caseId"] } },
      { name: "record_external_outcome", description: "Record a sandbox counterpart result without inventing evidence.", inputSchema: { type: "object", properties: { caseId: { type: "string" }, outcome: { type: "string", enum: ["pharmacy_blocker", "clinic_submission", "pharmacy_ready"] } }, required: ["caseId", "outcome"] } },
      { name: "get_case_brief", description: "Get the case status and deterministic resolution proof.", inputSchema: { type: "object", properties: { caseId: { type: "string" } }, required: ["caseId"] } },
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
    } else if (name === "get_case_brief") result = store.get(args.caseId);
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
    if (pathname === "/mcp" && req.method === "POST") return handleMcp(req, res);

    const caseMatch = pathname.match(/^\/api\/cases\/([^/]+)$/);
    if (caseMatch && req.method === "GET") return json(res, 200, { case: store.get(decodeURIComponent(caseMatch[1])) });

    const actionMatch = pathname.match(/^\/api\/cases\/([^/]+)\/(consent|start|pharmacy-blocker|clinic-submission|pharmacy-ready|send-update|escalate)$/);
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
      return json(res, 200, { case: updated });
    }

    if (pathname === "/api/demo/inbound-call" && req.method === "POST") {
      const payload = await body(req);
      return json(res, 200, await store.inboundTurn(payload));
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
    const status = /not found/.test(error.message) ? 404 : /required|not in|before/.test(error.message) ? 422 : 400;
    return json(res, status, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`RxRelay listening at http://${HOST}:${PORT} (${config().mode} mode)`);
});
