import crypto from "node:crypto";
import { routeTurn, TIER_LABELS } from "./pavo.mjs";
import { PavoInferenceEngine } from "./inference.mjs";
import { JsonCasePersistence } from "./persist.mjs";
import { publishCaseEvent } from "./bus.mjs";
import { buildProofReceipt } from "./receipt.mjs";
import { issueCounterpartToken, consumeCounterpartToken, listOpenTokensForCase } from "./counterpart.mjs";
import {
  consentFromTranscript,
  detectConversationalIntent,
  scriptedConversationalReply,
  goalForStatus,
  extractCallerNotes,
  recentTranscriptDigest,
} from "./dialogue.mjs";

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
        counterpartLinks: [],
        insurer: null,
        receiptTip: null,
        conversationTurns: [],
        callerNotes: {},
      };
      this.cases.set(caseId, record);
      this.addEvent(record, "case_created", "Case created with minimum necessary details.", "system", { source, pavoTier: routed.tier });
      if (routed.tier === "safe_stop") {
        this.addEvent(record, "safety_stop", routed.reason, "system", { route: routed });
      }
      publishCaseEvent("case_created", { caseId });
      return clone(record);
    });
  }

  addEvent(record, type, summary, lane, data = {}) {
    record.events.unshift({ id: crypto.randomUUID(), type, summary, lane, data, createdAt: now() });
    publishCaseEvent("case_event", { caseId: record.id, type, summary, lane, status: deriveStatus(record).key });
  }

  listHumanQueue() {
    return this.list().filter((item) => item.humanReview && item.status.key !== "resolved");
  }

  resumeAutomation(id, reason = "Human cleared the case for automation") {
    return this.mutate(() => {
      const record = this.cases.get(id);
      if (!record) throw new Error(`Case ${id} was not found.`);
      record.humanReview = false;
      this.addEvent(record, "automation_resumed", reason, "system");
      return this.getUnlocked(id);
    });
  }

  issueCounterpartLink(id, role = "pharmacy") {
    return this.mutate(() => {
      const record = this.cases.get(id);
      if (!record) throw new Error(`Case ${id} was not found.`);
      this.requireConsent(record);
      if (!["pharmacy", "clinic", "insurer"].includes(role)) throw new Error("Counterpart role must be pharmacy, clinic, or insurer.");
      const issued = issueCounterpartToken({ caseId: id, role });
      if (!record.counterpartLinks) record.counterpartLinks = [];
      record.counterpartLinks.unshift(issued);
      this.addEvent(record, "counterpart_link_issued", `${role} attestation link issued.`, role === "insurer" ? "clinic" : role, { token: issued.token, role });
      return { case: this.getUnlocked(id), link: issued };
    });
  }

  attestCounterpart(token, { outcome, note = "", reference = "" } = {}) {
    return this.mutateAsync(async () => {
      const link = consumeCounterpartToken(token);
      if (!link || link.status !== "consumed") throw new Error(link?.status === "used" ? "This attestation link was already used." : "Attestation link is invalid or expired.");
      const record = this.cases.get(link.caseId);
      if (!record) throw new Error(`Case ${link.caseId} was not found.`);
      this.requireConsent(record);
      if (outcome === "pharmacy_blocker" || (link.role === "pharmacy" && outcome === "blocker")) {
        return this.recordPharmacyBlockerUnlocked(link.caseId, { blocker: note || "Prior authorization needed", attestedBy: link.role, token });
      }
      if (outcome === "clinic_submission" || (link.role === "clinic" && outcome === "submitted")) {
        return this.recordClinicSubmissionUnlocked(link.caseId, { reference: reference || "PA-ATTST", attestedBy: link.role, token });
      }
      if (outcome === "pharmacy_ready" || (link.role === "pharmacy" && outcome === "ready")) {
        return this.recordPharmacyReadyUnlocked(link.caseId, { attestedBy: link.role, token });
      }
      if (outcome === "insurer_update" || link.role === "insurer") {
        record.insurer = { ...(record.insurer || {}), lastNote: note || "Coverage status reviewed", updatedAt: now() };
        record.evidence.counterpartOutcomeRecorded = true;
        this.addEvent(record, "insurer_update", note || "Insurer counterpart recorded a coverage-status note.", "clinic", { attestedBy: "insurer", token });
        return this.getUnlocked(link.caseId);
      }
      throw new Error("Unknown counterpart outcome.");
    });
  }

  exportReceipt(id) {
    const caseRecord = this.get(id);
    if (!caseRecord.proof.ready) throw new Error("Proof receipt is only available after the resolution gate is complete.");
    const receipt = buildProofReceipt(caseRecord);
    this.mutate(() => {
      const record = this.cases.get(id);
      record.receiptTip = receipt.tip;
      this.addEvent(record, "proof_receipt_exported", `Signed proof receipt exported (${receipt.tip.slice(0, 12)}…).`, "system", { tip: receipt.tip });
      return null;
    });
    return receipt;
  }

  markStaleForHumanReview(maxAgeMs = 1000 * 60 * 30) {
    return this.mutate(() => {
      const stale = [];
      for (const record of this.cases.values()) {
        if (record.humanReview || resolutionProof(record).ready) continue;
        const age = Date.now() - Date.parse(record.createdAt);
        if (age >= maxAgeMs && record.coordinationStarted) {
          record.humanReview = true;
          this.addEvent(record, "timeout_escalation", `Case exceeded ${Math.round(maxAgeMs / 60000)} minutes without resolution; routed to human review.`, "system");
          stale.push(record.id);
        }
      }
      return stale;
    });
  }

  openTokens(id) {
    return listOpenTokensForCase(id);
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
        counterpartLinks: [],
        insurer: null,
        receiptTip: null,
        conversationTurns: [],
        callerNotes: {},
      };
      this.cases.set(caseId, record);
      this.addEvent(record, "case_created", "Case created with minimum necessary details.", "system", { source: "voice", pavoTier: routed.tier });
      if (callId) this.callSessions.set(callId, caseId);
      this.addEvent(record, "voice_call_started", "Inbound voice session opened. No outreach is permitted until explicit consent is recorded.", "patient", { callId: callId || null });
      publishCaseEvent("voice_opened", { caseId });
      return this.getUnlocked(caseId);
    });
  }

  async handleVoiceTurn({ caseId, transcript, asrConfidence, noiseLevel, intentConfidence }) {
    return this.mutateAsync(async () => {
      const record = this.cases.get(caseId);
      if (!record) throw new Error(`Case ${caseId} was not found.`);
      if (!record.conversationTurns) record.conversationTurns = [];
      if (!record.callerNotes) record.callerNotes = {};

      const previouslyConsented = record.evidence.consentRecorded;
      const consentParse = consentFromTranscript(transcript);
      let consentRecorded = false;
      if (!previouslyConsented && consentParse.granted === false && consentParse.scoped) {
        record.humanReview = true;
        this.addEvent(record, "consent_declined", "Caller declined consent; case held for human review.", "patient", { statement: String(transcript) });
      } else if (!previouslyConsented && consentParse.granted) {
        record.evidence.consentRecorded = true;
        consentRecorded = true;
        this.addEvent(record, "consent_recorded", "Explicit consent recorded for permitted status coordination and updates.", "patient", { source: "voice", statement: String(transcript) });
      }

      Object.assign(record.callerNotes, extractCallerNotes(transcript));
      if (record.callerNotes.medicationHint && record.medication === "Prescription access request") {
        record.medication = record.callerNotes.medicationHint;
      }

      const statusBefore = deriveStatus(record).key;
      let action = null;
      const intent = detectConversationalIntent(transcript, statusBefore);
      if (previouslyConsented && !record.humanReview) {
        try {
          if (intent === "start_coordination" && !record.coordinationStarted) {
            await this.beginCoordinationUnlocked(caseId);
            action = "start_coordination";
          } else if (intent === "pharmacy_blocker" && record.coordinationStarted && !record.pharmacy.blocker) {
            const blocker = /insurance/i.test(transcript) ? "Insurance / prior authorization hold" : "Prior authorization needed";
            this.recordPharmacyBlockerUnlocked(caseId, { blocker });
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
      } else if (!previouslyConsented && intent === "escalate") {
        record.humanReview = true;
        this.addEvent(record, "human_handoff", "Caller requested a human coordinator before consent.", "system");
        action = "escalate";
      }

      // Soft auto-start: consented caller tells a stuck-prescription story without explicit "check status"
      if (previouslyConsented && !action && !record.humanReview && !record.coordinationStarted && intent === "vent") {
        // stay conversational — do not auto-start without a clear ask
      }

      const actionLabel = consentRecorded ? "consent" : action;
      const digest = recentTranscriptDigest(record.conversationTurns);
      const result = await this.inboundTurnUnlocked({
        caseId,
        transcript,
        asrConfidence,
        noiseLevel,
        intentConfidence,
        dialogueHint: goalForStatus(deriveStatus(record).key, { consented: record.evidence.consentRecorded }),
        conversationDigest: digest,
        actionTaken: actionLabel,
        intent,
        callerNotes: record.callerNotes,
      });

      const statusKey = deriveStatus(record).key;
      const fallback = scriptedConversationalReply({
        statusKey,
        consented: record.evidence.consentRecorded,
        action: actionLabel,
        intent,
        caseId,
        humanReview: record.humanReview,
        notes: record.callerNotes,
      });

      let reply = fallback;
      if (result.route.tier === "safe_stop") {
        reply = result.reply;
      } else if (result.inference?.source === "openai-compatible" && result.reply) {
        // Prefer Maya's natural model voice for almost all turns, including after actions.
        reply = result.reply;
      }

      record.conversationTurns.push({ role: "user", text: String(transcript), at: now(), intent, action: actionLabel });
      record.conversationTurns.push({ role: "assistant", text: reply, at: now() });
      if (record.conversationTurns.length > 40) record.conversationTurns = record.conversationTurns.slice(-40);

      return { ...result, reply, consentRecorded, action: actionLabel, intent };
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

  recordPharmacyBlockerUnlocked(id, { blocker = "Prior authorization needed", attestedBy = "voice_or_dashboard", token = null } = {}) {
    const record = this.cases.get(id);
    if (!record) throw new Error(`Case ${id} was not found.`);
    this.requireConsent(record);
    record.pharmacy.blocker = blocker;
    record.pharmacy.readyForPickup = false;
    record.evidence.counterpartOutcomeRecorded = true;
    this.addEvent(record, "pharmacy_blocker", `Pharmacy outcome recorded: ${blocker}.`, "pharmacy", { attestedBy, token });
    return this.getUnlocked(id);
  }

  recordClinicSubmission(id, { reference = "PA-2048" } = {}) {
    return this.mutate(() => this.recordClinicSubmissionUnlocked(id, { reference }));
  }

  recordClinicSubmissionUnlocked(id, { reference = "PA-2048", attestedBy = "voice_or_dashboard", token = null } = {}) {
    const record = this.cases.get(id);
    if (!record) throw new Error(`Case ${id} was not found.`);
    this.requireConsent(record);
    if (!record.pharmacy.blocker) throw new Error("Record a pharmacy blocker before recording a clinic submission.");
    record.clinic.submissionRecorded = true;
    this.addEvent(record, "clinic_submission", `Clinic outcome recorded: prior authorization submitted (${reference}).`, "clinic", { reference, attestedBy, token });
    return this.getUnlocked(id);
  }

  async recordPharmacyReady(id) {
    return this.mutateAsync(async () => this.recordPharmacyReadyUnlocked(id));
  }

  async recordPharmacyReadyUnlocked(id, { attestedBy = "voice_or_dashboard", token = null } = {}) {
    const record = this.cases.get(id);
    if (!record) throw new Error(`Case ${id} was not found.`);
    this.requireConsent(record);
    if (!record.clinic.submissionRecorded) throw new Error("Record the clinic follow-up before confirming pharmacy readiness.");
    record.pharmacy.readyForPickup = true;
    record.evidence.counterpartOutcomeRecorded = true;
    this.addEvent(record, "pharmacy_ready", "Pharmacy confirmed the prescription is ready for pickup.", "pharmacy", { attestedBy, token });
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

  async inboundTurnUnlocked({
    caseId = "RX-1048",
    transcript,
    asrConfidence,
    noiseLevel,
    intentConfidence,
    dialogueHint = "",
    conversationDigest = "",
    actionTaken = null,
    intent = "chat",
    callerNotes = {},
  }) {
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
      dialogueHint,
      conversationDigest,
      actionTaken,
      intent,
      callerNotes,
      caseBrief: `Case ${caseId}; consent=${record.evidence.consentRecorded}; status=${statusKey}; medication=${record.medication}; coordinationStarted=${record.coordinationStarted}; pharmacyBlocker=${record.pharmacy.blocker || "none"}; clinicSubmitted=${record.clinic.submissionRecorded}; ready=${record.pharmacy.readyForPickup}; proof=${JSON.stringify(record.evidence)}; notes=${JSON.stringify(record.callerNotes || {})}.`,
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
