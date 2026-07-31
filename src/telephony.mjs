import crypto from "node:crypto";

const now = () => new Date().toISOString();

function parseRecipients() {
  return (process.env.LIVE_ALLOWED_RECIPIENTS || process.env.DEMO_ALLOWED_RECIPIENTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function recipientIsAllowed(recipient, { requireList = false } = {}) {
  const allowed = parseRecipients();
  return requireList ? allowed.length > 0 && allowed.includes(recipient) : allowed.length === 0 || allowed.includes(recipient);
}

export function liveTelephonyMissing() {
  const required = [
    "A1MOBILE_PHONE_NUMBER",
    "PUBLIC_APP_URL",
    "A1MOBILE_WEBHOOK_SECRET",
  ];
  if (!process.env.A1MOBILE_TEAM_KEY && !process.env.A1MOBILE_API_KEY) required.push("A1MOBILE_TEAM_KEY or A1MOBILE_API_KEY");
  const missing = required.filter((key) => !process.env[key]);
  if (parseRecipients().length === 0) missing.push("LIVE_ALLOWED_RECIPIENTS");
  return missing;
}

function outboundAuthHeader() {
  const key = process.env.A1MOBILE_API_KEY;
  const header = process.env.A1MOBILE_API_AUTH_HEADER || "authorization";
  const prefix = process.env.A1MOBILE_API_AUTH_PREFIX ?? "Bearer";
  return key ? { [header]: `${prefix ? `${prefix} ` : ""}${key}` } : {};
}

async function responsePayload(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return response.json();
  return { raw: await response.text() };
}

/** A safe, fully functional adapter for the judged sandbox/demo. */
export class DemoTelephonyAdapter {
  constructor() {
    this.mode = "demo";
    this.events = [];
  }

  async placeCoordinationCall({ caseId, counterpart, summary }) {
    const result = {
      id: `demo-call-${crypto.randomUUID().slice(0, 8)}`,
      mode: "sandbox",
      type: "call",
      caseId,
      counterpart,
      summary,
      createdAt: now(),
      message: `Sandbox coordination call queued to ${counterpart}.`,
    };
    this.events.push(result);
    return result;
  }

  async sendPatientUpdate({ caseId, recipient, text, consentRecorded }) {
    if (!consentRecorded) throw new Error("Explicit communication consent is required before sending an update.");
    if (!recipientIsAllowed(recipient)) throw new Error("Recipient is not in the OTP-verified consent list.");
    const result = {
      id: `demo-sms-${crypto.randomUUID().slice(0, 8)}`,
      mode: "sandbox",
      type: "text",
      caseId,
      recipient,
      text,
      createdAt: now(),
      message: "Sandbox SMS recorded; no external number was contacted.",
    };
    this.events.push(result);
    return result;
  }
}

/**
 * A live, fail-closed adapter. It does not manufacture success from a demo
 * event: each outbound call/text must be accepted by an explicitly configured
 * a1mobile action URL. The precise hackathon endpoint paths live in env so
 * provider contract changes stay outside the safety-critical case engine.
 */
export class A1MobileAdapter {
  constructor({ fetchImpl = fetch } = {}) {
    this.mode = "a1mobile";
    this.fetch = fetchImpl;
  }

  assertLiveReady(kind) {
    const base = ["A1MOBILE_PHONE_NUMBER", "PUBLIC_APP_URL", "A1MOBILE_WEBHOOK_SECRET"];
    if (!process.env.A1MOBILE_TEAM_KEY && !process.env.A1MOBILE_API_KEY) base.push("A1MOBILE_TEAM_KEY or A1MOBILE_API_KEY");
    if (kind === "call") base.push("A1MOBILE_COORDINATION_RECIPIENT");
    const actionUrl = kind === "call" ? "A1MOBILE_CALL_ACTION_URL" : "A1MOBILE_TEXT_ACTION_URL";
    const needsGenericEndpoint = kind === "call" || !process.env.A1MOBILE_TEAM_KEY;
    const missing = [...base, ...(needsGenericEndpoint ? [actionUrl] : [])].filter((key) => !process.env[key]);
    if (process.env.ALLOW_LIVE_TELEPHONY !== "true" || missing.length) {
      throw new Error(`Live ${kind} is disabled or incomplete (${missing.join(", ") || "set ALLOW_LIVE_TELEPHONY=true"}).`);
    }
  }

  async dispatch(kind, target, payload) {
    this.assertLiveReady(kind);
    if (!recipientIsAllowed(target, { requireList: true })) {
      throw new Error("Live outreach requires an explicit OTP-verified recipient allowlist.");
    }
    const usingHackSms = kind === "text" && Boolean(process.env.A1MOBILE_TEAM_KEY);
    const endpoint = usingHackSms
      ? (process.env.A1MOBILE_SMS_URL || "https://hack.a1mobile.com/api/sms")
      : process.env[kind === "call" ? "A1MOBILE_CALL_ACTION_URL" : "A1MOBILE_TEXT_ACTION_URL"];
    const request = usingHackSms
      ? { to: target, body: payload.text }
      : { type: kind, to: target, from: process.env.A1MOBILE_PHONE_NUMBER, callbackUrl: `${process.env.PUBLIC_APP_URL.replace(/\/$/, "")}/api/telephony/a1mobile/events`, ...payload };
    const response = await this.fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(usingHackSms ? { "X-Team-Key": process.env.A1MOBILE_TEAM_KEY } : outboundAuthHeader()) },
      body: JSON.stringify(request),
    });
    const result = await responsePayload(response);
    if (!response.ok) throw new Error(`a1mobile ${kind} action was rejected (${response.status}).`);
    const id = result.id || result.callId || result.messageId || result.message_id || result.sid || (usingHackSms ? `a1-sms-${crypto.randomUUID().slice(0, 8)}` : null);
    if (!id) throw new Error(`a1mobile ${kind} action response did not include an id; refusing to record a completion.`);
    return { id: String(id), mode: "live", type: kind, createdAt: now(), providerResponse: result };
  }

  async placeCoordinationCall({ caseId, summary }) {
    const counterpart = process.env.A1MOBILE_COORDINATION_RECIPIENT;
    const result = await this.dispatch("call", counterpart, {
      caseId,
      purpose: "consented_non_clinical_status_coordination",
      summary,
    });
    return { ...result, counterpart, message: "Live coordination call accepted by a1mobile." };
  }

  async sendPatientUpdate({ caseId, recipient, text, consentRecorded }) {
    if (!consentRecorded) throw new Error("Explicit communication consent is required before sending an update.");
    const result = await this.dispatch("text", recipient, { caseId, text, purpose: "consented_status_update" });
    return { ...result, recipient, text, message: "Live patient update accepted by a1mobile." };
  }
}

export function createTelephonyAdapter() {
  // Inbound TeXML does not require the live adapter. Keep outbound in sandbox
  // unless live mode is explicitly enabled, so the proof board stays usable.
  if (process.env.TELEPHONY_PROVIDER === "a1mobile" && process.env.ALLOW_LIVE_TELEPHONY === "true") {
    return new A1MobileAdapter();
  }
  return new DemoTelephonyAdapter();
}

export function normalizeA1MobileEvent(payload = {}) {
  return {
    eventId: String(payload.eventId || payload.id || crypto.randomUUID()),
    type: String(payload.type || payload.event || "unknown"),
    callId: payload.callId || payload.call_id || null,
    caseId: payload.caseId || payload.case_id || payload.metadata?.caseId || null,
    from: payload.from || payload.caller || null,
    to: payload.to || payload.recipient || null,
    transcript: String(payload.transcript || payload.text || ""),
    asrConfidence: Number(payload.asrConfidence ?? payload.asr_confidence ?? 0.9),
    noiseLevel: Number(payload.noiseLevel ?? payload.noise_level ?? 0.1),
    occurredAt: payload.occurredAt || payload.timestamp || now(),
  };
}
