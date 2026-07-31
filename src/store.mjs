import crypto from "node:crypto";
import { routeTurn, TIER_LABELS, detectVoiceIntent } from "./pavo.mjs";
import { PavoInferenceEngine } from "./inference.mjs";
import { JsonCasePersistence } from "./persist.mjs";

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
  constructor({ telephony, inference = new PavoInferenceEngine(), persistence = null, seedDemo = true } = {}) {
    this.telephony = telephony;
    this.inference = inference;
    this.persistence = persistence;
    this.cases = new Map();
    this.webhookIds = new Set();
    this.callSessions = new Map();
    this.reload();
    if (seedDemo && !this.cases.has("RX-1048")) this.seedDemo();
  }

  reload() {
    if (!this.persistence) return;
    const snapshot = this.persistence.load();
    this.cases = new Map(Object.entries(snapshot.cases || {}));
    this.callSessions = new Map(Object.entries(snapshot.callSessions || {}));
    this.webhookIds = new Set(snapshot.webhookIds || []);
  }

  persist() {
    if (!this.persistence) return;
    this.persistence.save({
      cases: this.cases,
      callSessions: this.callSessions,
      webhookIds: this.webhookIds,
    });
  }

  mutate(fn) {
    this.reload();
    const result = fn();
    this.persist();
    return result;
  }

  async mutateAsync(fn) {
    this.reload();
    const result = await fn();
    this.persist();
    return result;
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
    this.mutate(() => {
      const record = this.cases.get(demo.id);
      this.addEvent(record, "intake_ready", "Consent recorded. Case is ready for a permitted status follow-up.", "patient");
      return this.getUnlocked(demo.id);
    });
  }

  createCase({ id, patientAlias, recipient, medication, transcript = "", source = "web" }) {
    return this.mutate(() => {
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
    });
  }

  addEvent(record, type, summary, lane, data = {}) {
    record.events.unshift({ id: crypto.randomUUID(), type, summary, lane, data, createdAt: now() });
  }

  get(id) {
    this.reload();
    return this.getUnlocked(id);
  }

  getUnlocked(id) {
    const record = this.cases.get(id);
    if (!record) throw new Error(`Case ${id} was not found.`);
    const out = clone(record);
    out.status = deriveStatus(record);
    out.proof = resolutionProof(record);
    out.pipeline = TIER_LABELS[record.lastRoute.tier];
    return out;
  }

  list() {
    this.reload();
    return [...this.cases.keys()]
      .map((id) => this.getUnlocked(id))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  openVoiceCase({ callId, from }) {
    return this.mutate(() => {
      if (callId && this.callSessions.has(callId)) return this.getUnlocked(this.callSessions.get(callId));
      const caller = String(from || "Unknown caller");
      const caseId = `RX-${Math.floor(1000 + Math.random() * 8999)}`;
      if (this.cases.has(caseId)) throw new Error(`Case ${caseId} already exists.`);
      const routed = routeTurn({ transcript: "" });
      const record = {
        id: caseId,
        patient: { alias: caller.startsWith("+") ? `Caller • ${caller.slice(-4)}` : "Voice caller", recipient: caller },
        medication: "Prescription access request",
        source: "voice",
        createdAt: now(),
        coordinationStarted: false,
        humanReview: false,
        lastRoute: routed,
        evidence: initialEvidence(),
        pharmacy: { blocker: null, readyForPickup: false },
        clinic: { submissionRecorded: false },
        communications: [],
        events: [],
      };
      this.cases.set(caseId, record);
      this.addEvent(record, "case_created", "Case created with minimum necessary details.", "system", { source: "voice", pavoTier: routed.tier });
      if (callId) this.callSessions.set(callId, caseId);
      this.addEvent(record, "voice_call_started", "Inbound voice session opened. No outreach is permitted until explicit consent is recorded.", "patient", { callId: callId || null });
      return this.getUnlocked(caseId);
    });
  }

  async handleVoiceTurn({ caseId, transcript, asrConfidence, noiseLevel, intentConfidence }) {
    return this.mutateAsync(async () => {
      const record = this.cases.get(caseId);
      if (!record) throw new Error(`Case ${caseId} was not found.`);
      const previouslyConsented = record.evidence.consentRecorded;
      const saysConsent = /\b(i\s+consent|i\s+give\s+(?:you\s+)?permission|yes[,\s]+you\s+(?:may|can)|you\s+have\s+my\s+permission)\b/i.test(String(transcript || ""));
      const scopedConsent = /\b(pharmacy|status|coordinate|text|update)\b/i.test(String(transcript || ""));
      const consentRecorded = !previouslyConsented && saysConsent && scopedConsent;
      if (consentRecorded) {
        record.evidence.consentRecorded = true;
        this.addEvent(record, "consent_recorded", "Explicit consent recorded for permitted status coordination and updates.", "patient", { source: "voice", statement: String(transcript) });
      }

      let action = null;
      const intent = detectVoiceIntent(transcript);
      // Only act on coordination intents after consent already existed before this turn,
      // so the consent utterance itself cannot also fire a pharmacy call.
      if (previouslyConsented && !record.humanReview) {
        try {
          if (intent === "start_coordination" && !record.coordinationStarted) {
            await this.beginCoordinationUnlocked(caseId);
            action = "start_coordination";
          } else if (intent === "pharmacy_blocker" && record.coordinationStarted && !record.pharmacy.blocker) {
            this.recordPharmacyBlockerUnlocked(caseId);
            action = "pharmacy_blocker";
          } else if (intent === "clinic_submission" && record.pharmacy.blocker && !record.clinic.submissionRecorded) {
            this.recordClinicSubmissionUnlocked(caseId);
            action = "clinic_submission";
          } else if (intent === "pharmacy_ready" && record.clinic.submissionRecorded && !record.pharmacy.readyForPickup) {
            await this.recordPharmacyReadyUnlocked(caseId);
            action = "pharmacy_ready";
          } else if (intent === "escalate") {
            record.humanReview = true;
            this.addEvent(record, "human_handoff", "Caller requested a human coordinator.", "system");
            action = "escalate";
          }
        } catch (error) {
          this.addEvent(record, "voice_action_blocked", error.message, "system", { intent });
        }
      }

      const result = await this.inboundTurnUnlocked({ caseId, transcript, asrConfidence, noiseLevel, intentConfidence });
      let reply = result.reply;
      if (consentRecorded) {
        reply = "Your explicit consent is recorded and your RxRelay case is open. Say check my prescription status to start a permitted pharmacy follow-up.";
      } else if (action === "start_coordination") {
        reply = "I started a permitted pharmacy status follow-up. Your case stays open until a counterpart outcome and patient update are recorded.";
      } else if (action === "pharmacy_blocker") {
        reply = "I recorded the pharmacy blocker: prior authorization is needed. I can next record when the clinic submits the follow-up.";
      } else if (action === "clinic_submission") {
        reply = "Clinic follow-up is recorded. Tell me when the pharmacy confirms the prescription is ready for pickup.";
      } else if (action === "pharmacy_ready") {
        reply = "Pharmacy readiness is recorded and a consented status update was sent. Your resolution proof is complete.";
      } else if (action === "escalate") {
        reply = "A human coordinator will take it from here. I will not take further automated action.";
      }
      return { ...result, reply, consentRecorded, action, intent };
    });
  }

  recordConsent(id, { granted, source = "web", statement = "" }) {
    return this.mutate(() => {
      const record = this.cases.get(id);
      if (!record) throw new Error(`Case ${id} was not found.`);
      if (!granted) {
        record.humanReview = true;
        this.addEvent(record, "consent_declined", "Consent was not granted; no coordination or text was sent.", "patient");
        return this.getUnlocked(id);
      }
      record.evidence.consentRecorded = true;
      this.addEvent(record, "consent_recorded", "Explicit consent recorded for permitted status coordination and updates.", "patient", { source, statement });
      return this.getUnlocked(id);
    });
  }

  requireConsent(record) {
    if (!record.evidence.consentRecorded) throw new Error("Explicit consent is required before coordination.");
    if (record.humanReview) throw new Error("This case is held for human review; no autonomous action is permitted.");
  }

  async beginCoordination(id) {
    return this.mutateAsync(async () => this.beginCoordinationUnlocked(id));
  }

  async beginCoordinationUnlocked(id) {
    const record = this.cases.get(id);
    if (!record) throw new Error(`Case ${id} was not found.`);
    this.requireConsent(record);
    const call = await this.telephony.placeCoordinationCall({
      caseId: id,
      counterpart: "sandbox pharmacy desk",
      summary: "Confirm non-clinical prescription access status only. Do not request or disclose clinical information.",
    });
    record.coordinationStarted = true;
    record.evidence.permittedActionCompleted = true;
    this.addEvent(record, "pharmacy_call_started", call.message, "pharmacy", { callId: call.id, mode: call.mode });
    return this.getUnlocked(id);
  }

  recordPharmacyBlocker(id, { blocker = "Prior authorization needed" } = {}) {
    return this.mutate(() => this.recordPharmacyBlockerUnlocked(id, { blocker }));
  }

  recordPharmacyBlockerUnlocked(id, { blocker = "Prior authorization needed" } = {}) {
    const record = this.cases.get(id);
    if (!record) throw new Error(`Case ${id} was not found.`);
    this.requireConsent(record);
    record.pharmacy.blocker = blocker;
    record.pharmacy.readyForPickup = false;
    record.evidence.counterpartOutcomeRecorded = true;
    this.addEvent(record, "pharmacy_blocker", `Pharmacy outcome recorded: ${blocker}.`, "pharmacy");
    return this.getUnlocked(id);
  }

  recordClinicSubmission(id, { reference = "PA-2048" } = {}) {
    return this.mutate(() => this.recordClinicSubmissionUnlocked(id, { reference }));
  }

  recordClinicSubmissionUnlocked(id, { reference = "PA-2048" } = {}) {
    const record = this.cases.get(id);
    if (!record) throw new Error(`Case ${id} was not found.`);
    this.requireConsent(record);
    if (!record.pharmacy.blocker) throw new Error("Record a pharmacy blocker before recording a clinic submission.");
    record.clinic.submissionRecorded = true;
    this.addEvent(record, "clinic_submission", `Clinic outcome recorded: prior authorization submitted (${reference}).`, "clinic", { reference });
    return this.getUnlocked(id);
  }

  async recordPharmacyReady(id) {
    return this.mutateAsync(async () => this.recordPharmacyReadyUnlocked(id));
  }

  async recordPharmacyReadyUnlocked(id) {
    const record = this.cases.get(id);
    if (!record) throw new Error(`Case ${id} was not found.`);
    this.requireConsent(record);
    if (!record.clinic.submissionRecorded) throw new Error("Record the clinic follow-up before confirming pharmacy readiness.");
    record.pharmacy.readyForPickup = true;
    record.evidence.counterpartOutcomeRecorded = true;
    this.addEvent(record, "pharmacy_ready", "Pharmacy confirmed the prescription is ready for pickup.", "pharmacy");
    return this.sendPatientUpdateUnlocked(id, "Your pharmacy confirmed your prescription is ready for pickup. Please contact the pharmacy directly for pickup details.", "resolution_update");
  }

  async sendPatientUpdate(id, text, reason = "status_update") {
    return this.mutateAsync(async () => this.sendPatientUpdateUnlocked(id, text, reason));
  }

  async sendPatientUpdateUnlocked(id, text, reason = "status_update") {
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
    return this.getUnlocked(id);
  }

  escalate(id, reason = "Needs a human coordinator") {
    return this.mutate(() => {
      const record = this.cases.get(id);
      if (!record) throw new Error(`Case ${id} was not found.`);
      record.humanReview = true;
      this.addEvent(record, "human_handoff", reason, "system");
      return this.getUnlocked(id);
    });
  }

  async inboundTurn({ caseId = "RX-1048", transcript, asrConfidence, noiseLevel, intentConfidence }) {
    return this.mutateAsync(async () => this.inboundTurnUnlocked({ caseId, transcript, asrConfidence, noiseLevel, intentConfidence }));
  }

  async inboundTurnUnlocked({ caseId = "RX-1048", transcript, asrConfidence, noiseLevel, intentConfidence }) {
    const record = this.cases.get(caseId);
    if (!record) throw new Error(`Case ${caseId} was not found.`);
    const route = routeTurn({ transcript, asrConfidence, noiseLevel, intentConfidence, historyDepth: record.events.length });
    record.lastRoute = route;
    const statusKey = deriveStatus(record).key;
    const inference = await this.inference.respond({
      transcript,
      route,
      consentRecorded: record.evidence.consentRecorded,
      statusKey,
      caseBrief: `Case ${caseId}; consent=${record.evidence.consentRecorded}; status=${statusKey}; medication=${record.medication}; coordinationStarted=${record.coordinationStarted}; proof=${JSON.stringify(record.evidence)}.`,
    });
    this.addEvent(record, "voice_turn", inference.text, "patient", {
      transcript,
      route,
      inference: { source: inference.source, model: inference.model, pipeline: inference.pipeline?.pipeline || null },
    });
    if (route.tier === "safe_stop") record.humanReview = true;
    return { case: this.getUnlocked(caseId), route, reply: inference.text, inference: { source: inference.source, model: inference.model, pipeline: inference.pipeline } };
  }

  async receiveWebhook(event) {
    return this.mutateAsync(async () => {
      if (this.webhookIds.has(event.eventId)) return { deduplicated: true, case: null };
      const caseId = event.caseId || "RX-1048";
      const record = this.cases.get(caseId);
      if (!record) throw new Error(`Case ${caseId} was not found.`);
      if (process.env.TELEPHONY_PROVIDER === "a1mobile" && event.from && event.from !== record.patient.recipient) {
        throw new Error("Inbound caller does not match the consented case recipient.");
      }
      this.webhookIds.add(event.eventId);
      const result = await this.inboundTurnUnlocked({ caseId, transcript: event.transcript, asrConfidence: event.asrConfidence, noiseLevel: event.noiseLevel });
      return { deduplicated: false, ...result };
    });
  }
}

export { PERMITTED_ACTIONS };
