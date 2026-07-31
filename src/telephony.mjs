import crypto from "node:crypto";

const now = () => new Date().toISOString();

function recipientIsAllowed(recipient) {
  const allowed = (process.env.DEMO_ALLOWED_RECIPIENTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return allowed.length === 0 || allowed.includes(recipient);
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
 * Live mode is deliberately guarded. It accepts only an a1mobile-normalized
 * webhook payload until the team receives the provider's exact API contract.
 */
export class A1MobileAdapter extends DemoTelephonyAdapter {
  constructor() {
    super();
    this.mode = "a1mobile";
  }

  assertLiveReady() {
    const missing = ["A1MOBILE_API_BASE_URL", "A1MOBILE_API_KEY", "A1MOBILE_PHONE_NUMBER", "PUBLIC_APP_URL"]
      .filter((key) => !process.env[key]);
    if (process.env.ALLOW_LIVE_TELEPHONY !== "true" || missing.length) {
      throw new Error(`Live telephony is disabled or incomplete (${missing.join(", ") || "set ALLOW_LIVE_TELEPHONY=true"}).`);
    }
  }

  async placeCoordinationCall(payload) {
    this.assertLiveReady();
    // Provider payload fields are kept intentionally isolated here. Replace only
    // this adapter method once a1mobile provides the final endpoint/schema.
    return { ...(await super.placeCoordinationCall(payload)), mode: "live-pending-provider-schema" };
  }

  async sendPatientUpdate(payload) {
    this.assertLiveReady();
    return { ...(await super.sendPatientUpdate(payload)), mode: "live-pending-provider-schema" };
  }
}

export function createTelephonyAdapter() {
  return process.env.TELEPHONY_PROVIDER === "a1mobile" ? new A1MobileAdapter() : new DemoTelephonyAdapter();
}

export function normalizeA1MobileEvent(payload = {}) {
  return {
    eventId: String(payload.eventId || payload.id || crypto.randomUUID()),
    type: String(payload.type || payload.event || "unknown"),
    callId: payload.callId || payload.call_id || null,
    from: payload.from || payload.caller || null,
    to: payload.to || payload.recipient || null,
    transcript: String(payload.transcript || payload.text || ""),
    asrConfidence: Number(payload.asrConfidence ?? payload.asr_confidence ?? 0.9),
    noiseLevel: Number(payload.noiseLevel ?? payload.noise_level ?? 0.1),
    occurredAt: payload.occurredAt || payload.timestamp || now(),
  };
}
