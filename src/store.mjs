import crypto from "node:crypto";
import { routeTurn, TIER_LABELS } from "./pavo.mjs";
import { PavoInferenceEngine } from "./inference.mjs";

const now = () => new Date().toISOString();
const clone = (value) => structuredClone(value);

const PERMITTED_ACTIONS = [
  "coordinate non-clinical status follow-up",
  "send status updates to the patient",
  "record a counterpart outcome",
];

function initialEvidence() {
  return {
    consentRecorded: false,
    permittedActionCompleted: false,
    counterpartOutcomeRecorded: false,
    patientNotificationSent: false,
  };
}

function resolutionProof(caseRecord) {
  const checks = [
    { id: "consent", label: "Explicit consent recorded", passed: caseRecord.evidence.consentRecorded },
    { id: "action", label: "Permitted coordination action completed", passed: caseRecord.evidence.permittedActionCompleted },
    { id: "outcome", label: "Counterpart outcome recorded", passed: caseRecord.evidence.counterpartOutcomeRecorded },
    { id: "notification", label: "Patient notification sent", passed: caseRecord.evidence.patientNotificationSent },
  ];
  return { checks, ready: checks.every((check) => check.passed) };
}

function deriveStatus(caseRecord) {
  if (caseRecord.humanReview) return { key: "human_review", label: "Human review required", tone: "danger" };
  const proof = resolutionProof(caseRecord);
  if (proof.ready) return { key: "resolved", label: "Resolution verified", tone: "success" };
  if (caseRecord.pharmacy.readyForPickup) return { key: "awaiting_update", label: "Ready — sending patient update", tone: "warning" };
  if (caseRecord.clinic.submissionRecorded) return { key: "waiting_pharmacy", label: "Waiting for pharmacy confirmation", tone: "warning" };
  if (caseRecord.pharmacy.blocker) return { key: "waiting_clinic", label: "Clinic follow-up needed", tone: "warning" };
  if (caseRecord.coordinationStarted) return { key: "coordinating", label: "Coordination in progress", tone: "info" };
  return caseRecord.evidence.consentRecorded
    ? { key: "ready", label: "Ready for pharmacy status check", tone: "info" }
    : { key: "intake", label: "Consent required", tone: "neutral" };
}

export class CaseStore {
  constructor({ telephony, inference = new PavoInferenceEngine() }) {
    this.telephony = telephony;
    this.inference = inference;
    this.cases = new Map();
    this.webhookIds = new Set();
    this.seedDemo();
  }

  seedDemo() {
    const demo = this.createCase({
      id: "RX-1048",
      patientAlias: "Taylor R.",
      recipient: "+15550001048",
      medication: "Demo medication",
      transcript: "I need help checking the status of my prescription at the pharmacy.",
      source: "demo",
    });
    this.recordConsent(demo.id, { granted: true, source: "voice", statement: "Yes, you may coordinate a status follow-up and text me updates." });
    this.addEvent(demo, "intake_ready", "Consent recorded. Case is ready for a permitted status follow-up.", "patient");
  }

  createCase({ id, patientAlias, recipient, medication, transcript = "", source = "web" }) {
    const caseId = id || `RX-${Math.floor(1000 + Math.random() * 8999)}`;
    if (this.cases.has(caseId)) throw new Error(`Case ${caseId} already exists.`);
    const routed = routeTurn({ transcript });
    const record = {
      id: caseId,
      patient: { alias: patientAlias || "Patient", recipient: recipient || "+15550000000" },
      medication: medication || "Unspecified medication",
      source,
      createdAt: now(),
      coordinationStarted: false,
      humanReview: routed.tier === "safe_stop",
      lastRoute: routed,
      evidence: initialEvidence(),
      pharmacy: { blocker: null, readyForPickup: false },
      clinic: { submissionRecorded: false },
      communications: [],
      events: [],
    };
    this.cases.set(caseId, record);
    this.addEvent(record, "case_created", "Case created with minimum necessary details.", "system", { source, pavoTier: routed.tier });
    if (routed.tier === "safe_stop") {
      this.addEvent(record, "safety_stop", routed.reason, "system", { route: routed });
    }
    return clone(record);
  }

  addEvent(record, type, summary, lane, data = {}) {
    record.events.unshift({ id: crypto.randomUUID(), type, summary, lane, data, createdAt: now() });
  }

  get(id) {
    const record = this.cases.get(id);
    if (!record) throw new Error(`Case ${id} was not found.`);
    const out = clone(record);
    out.status = deriveStatus(record);
    out.proof = resolutionProof(record);
    out.pipeline = TIER_LABELS[record.lastRoute.tier];
    return out;
  }

  list() {
    return [...this.cases.keys()].map((id) => this.get(id));
  }

  recordConsent(id, { granted, source = "web", statement = "" }) {
    const record = this.cases.get(id);
    if (!record) throw new Error(`Case ${id} was not found.`);
    if (!granted) {
      record.humanReview = true;
      this.addEvent(record, "consent_declined", "Consent was not granted; no coordination or text was sent.", "patient");
      return this.get(id);
    }
    record.evidence.consentRecorded = true;
    this.addEvent(record, "consent_recorded", "Explicit consent recorded for permitted status coordination and updates.", "patient", { source, statement });
    return this.get(id);
  }

  requireConsent(record) {
    if (!record.evidence.consentRecorded) throw new Error("Explicit consent is required before coordination.");
    if (record.humanReview) throw new Error("This case is held for human review; no autonomous action is permitted.");
  }

  async beginCoordination(id) {
    const record = this.cases.get(id);
    if (!record) throw new Error(`Case ${id} was not found.`);
    this.requireConsent(record);
    record.coordinationStarted = true;
    record.evidence.permittedActionCompleted = true;
    const call = await this.telephony.placeCoordinationCall({
      caseId: id,
      counterpart: "sandbox pharmacy desk",
      summary: "Confirm non-clinical prescription access status only. Do not request or disclose clinical information.",
    });
    this.addEvent(record, "pharmacy_call_started", call.message, "pharmacy", { callId: call.id, mode: call.mode });
    return this.get(id);
  }

  recordPharmacyBlocker(id, { blocker = "Prior authorization needed" } = {}) {
    const record = this.cases.get(id);
    if (!record) throw new Error(`Case ${id} was not found.`);
    this.requireConsent(record);
    record.pharmacy.blocker = blocker;
    record.pharmacy.readyForPickup = false;
    record.evidence.counterpartOutcomeRecorded = true;
    this.addEvent(record, "pharmacy_blocker", `Pharmacy outcome recorded: ${blocker}.`, "pharmacy");
    return this.get(id);
  }

  recordClinicSubmission(id, { reference = "PA-2048" } = {}) {
    const record = this.cases.get(id);
    if (!record) throw new Error(`Case ${id} was not found.`);
    this.requireConsent(record);
    if (!record.pharmacy.blocker) throw new Error("Record a pharmacy blocker before recording a clinic submission.");
    record.clinic.submissionRecorded = true;
    this.addEvent(record, "clinic_submission", `Clinic outcome recorded: prior authorization submitted (${reference}).`, "clinic", { reference });
    return this.get(id);
  }

  async recordPharmacyReady(id) {
    const record = this.cases.get(id);
    if (!record) throw new Error(`Case ${id} was not found.`);
    this.requireConsent(record);
    if (!record.clinic.submissionRecorded) throw new Error("Record the clinic follow-up before confirming pharmacy readiness.");
    record.pharmacy.readyForPickup = true;
    record.evidence.counterpartOutcomeRecorded = true;
    this.addEvent(record, "pharmacy_ready", "Pharmacy confirmed the prescription is ready for pickup.", "pharmacy");
    return this.sendPatientUpdate(id, "Your pharmacy confirmed your prescription is ready for pickup. Please contact the pharmacy directly for pickup details.", "resolution_update");
  }

  async sendPatientUpdate(id, text, reason = "status_update") {
    const record = this.cases.get(id);
    if (!record) throw new Error(`Case ${id} was not found.`);
    this.requireConsent(record);
    const sms = await this.telephony.sendPatientUpdate({
      caseId: id,
      recipient: record.patient.recipient,
      text,
      consentRecorded: record.evidence.consentRecorded,
    });
    record.communications.unshift({ id: sms.id, text, type: "sms", mode: sms.mode, createdAt: sms.createdAt });
    if (reason === "resolution_update") record.evidence.patientNotificationSent = true;
    this.addEvent(record, "patient_update", sms.message, "patient", { reason, text, mode: sms.mode });
    return this.get(id);
  }

  escalate(id, reason = "Needs a human coordinator") {
    const record = this.cases.get(id);
    if (!record) throw new Error(`Case ${id} was not found.`);
    record.humanReview = true;
    this.addEvent(record, "human_handoff", reason, "system");
    return this.get(id);
  }

  async inboundTurn({ caseId = "RX-1048", transcript, asrConfidence, noiseLevel, intentConfidence }) {
    const record = this.cases.get(caseId);
    if (!record) throw new Error(`Case ${caseId} was not found.`);
    const route = routeTurn({ transcript, asrConfidence, noiseLevel, intentConfidence, historyDepth: record.events.length });
    record.lastRoute = route;
    const inference = await this.inference.respond({
      transcript,
      route,
      caseBrief: `Case ${caseId}; consent=${record.evidence.consentRecorded}; status=${deriveStatus(record).key}; medication=${record.medication}.`,
    });
    this.addEvent(record, "voice_turn", inference.text, "patient", { transcript, route, inference: { source: inference.source, model: inference.model } });
    if (route.tier === "safe_stop") record.humanReview = true;
    return { case: this.get(caseId), route, reply: inference.text, inference: { source: inference.source, model: inference.model } };
  }

  async receiveWebhook(event) {
    if (this.webhookIds.has(event.eventId)) return { deduplicated: true, case: null };
    this.webhookIds.add(event.eventId);
    const result = await this.inboundTurn({ transcript: event.transcript, asrConfidence: event.asrConfidence, noiseLevel: event.noiseLevel });
    return { deduplicated: false, ...result };
  }
}

export { PERMITTED_ACTIONS };
