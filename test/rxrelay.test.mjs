import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { routeTurn } from "../src/pavo.mjs";
import { PavoInferenceEngine } from "../src/inference.mjs";
import { CaseStore } from "../src/store.mjs";
import { JsonCasePersistence } from "../src/persist.mjs";
import { A1MobileAdapter, DemoTelephonyAdapter } from "../src/telephony.mjs";

test("PAVO demand score jointly upgrades ASR and reasoning near the coupling cliff", () => {
  const route = routeTurn({
    transcript: "The prior authorization number sounded like PA two zero four eight",
    asrConfidence: 0.71,
    noiseLevel: 0.55,
    intentConfidence: 0.8,
  });
  assert.equal(route.tier, "verified");
  assert.equal(route.jointUpgrade, true);
  assert.equal(route.asrTier, "cloud_premium");
  assert.equal(route.reasoningTier, "strong_verified");
  assert.ok(route.signals.demand > 0.5);
  assert.match(route.citation, /coupling cliff/i);
});

test("voice turns can complete the sandbox proof path after consent", async () => {
  const store = new CaseStore({ telephony: new DemoTelephonyAdapter() });
  const voiceCase = store.openVoiceCase({ callId: "call-e2e-voice", from: "+15550000099" });
  await store.handleVoiceTurn({
    caseId: voiceCase.id,
    transcript: "I consent to a pharmacy status follow-up and text updates.",
    asrConfidence: .97,
    noiseLevel: .04,
  });
  const started = await store.handleVoiceTurn({
    caseId: voiceCase.id,
    transcript: "Please check the status of my prescription follow-up.",
    asrConfidence: .95,
    noiseLevel: .05,
  });
  assert.equal(started.action, "start_coordination");
  assert.equal(started.case.evidence.permittedActionCompleted, true);
  const blocker = await store.handleVoiceTurn({
    caseId: voiceCase.id,
    transcript: "The pharmacy said prior authorization is needed.",
    asrConfidence: .94,
    noiseLevel: .06,
  });
  assert.equal(blocker.action, "pharmacy_blocker");
  const clinic = await store.handleVoiceTurn({
    caseId: voiceCase.id,
    transcript: "The clinic submitted the prior authorization.",
    asrConfidence: .95,
    noiseLevel: .05,
  });
  assert.equal(clinic.action, "clinic_submission");
  const ready = await store.handleVoiceTurn({
    caseId: voiceCase.id,
    transcript: "The pharmacy says it is ready for pickup.",
    asrConfidence: .96,
    noiseLevel: .04,
  });
  assert.equal(ready.action, "pharmacy_ready");
  assert.equal(ready.case.proof.ready, true);
  assert.equal(ready.case.status.key, "resolved");
});

test("PAVO stops unsafe medical advice instead of automating it", () => {
  const route = routeTurn({ transcript: "What dosage should I take for my medication?" });
  assert.equal(route.tier, "safe_stop");
});

test("configured verified turns use the strong OpenAI-compatible model", async () => {
  const previous = { PAVO_OPENAI_BASE_URL: process.env.PAVO_OPENAI_BASE_URL, PAVO_OPENAI_API_KEY: process.env.PAVO_OPENAI_API_KEY, PAVO_FAST_MODEL: process.env.PAVO_FAST_MODEL, PAVO_STRONG_MODEL: process.env.PAVO_STRONG_MODEL };
  Object.assign(process.env, { PAVO_OPENAI_BASE_URL: "https://gateway.example/v1", PAVO_OPENAI_API_KEY: "test-key", PAVO_FAST_MODEL: "fast", PAVO_STRONG_MODEL: "strong" });
  try {
    let request;
    const engine = new PavoInferenceEngine({ fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ output_text: "I will confirm the pharmacy status." }) };
    } });
    const route = routeTurn({ transcript: "I could not hear the prior authorization number", asrConfidence: .61, noiseLevel: .55 });
    const reply = await engine.respond({ transcript: "test", route, caseBrief: "case" });
    assert.equal(request.url, "https://gateway.example/v1/responses");
    assert.equal(request.body.model, "strong");
    assert.equal(reply.source, "openai-compatible");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("case cannot resolve until its deterministic evidence proof is complete", async () => {
  const store = new CaseStore({ telephony: new DemoTelephonyAdapter() });
  let caseRecord = store.get("RX-1048");
  assert.equal(caseRecord.proof.ready, false);
  caseRecord = await store.beginCoordination("RX-1048");
  assert.equal(caseRecord.proof.checks.find((check) => check.id === "action").passed, true);
  caseRecord = store.recordPharmacyBlocker("RX-1048");
  assert.equal(caseRecord.status.key, "waiting_clinic");
  store.recordClinicSubmission("RX-1048");
  caseRecord = await store.recordPharmacyReady("RX-1048");
  assert.equal(caseRecord.proof.ready, true);
  assert.equal(caseRecord.status.key, "resolved");
  assert.equal(caseRecord.communications[0].mode, "sandbox");
});

test("case refuses coordination without consent", async () => {
  const store = new CaseStore({ telephony: new DemoTelephonyAdapter() });
  const caseRecord = store.createCase({ patientAlias: "Demo", recipient: "+15550000001" });
  await assert.rejects(() => store.beginCoordination(caseRecord.id), /Explicit consent/);
});

test("voice session records narrow explicit consent before an action is possible", async () => {
  const store = new CaseStore({ telephony: new DemoTelephonyAdapter() });
  const voiceCase = store.openVoiceCase({ callId: "call-voice-test", from: "+15550000077" });
  const turn = await store.handleVoiceTurn({
    caseId: voiceCase.id,
    transcript: "I consent to a pharmacy status follow-up and text updates.",
    asrConfidence: .97,
    noiseLevel: .05,
  });
  assert.equal(turn.consentRecorded, true);
  assert.equal(turn.case.evidence.consentRecorded, true);
  assert.equal(turn.case.evidence.permittedActionCompleted, false);
});

test("failed outbound coordination cannot create a false action proof", async () => {
  const failingTelephony = { placeCoordinationCall: async () => { throw new Error("Provider unavailable"); } };
  const store = new CaseStore({ telephony: failingTelephony });
  await assert.rejects(() => store.beginCoordination("RX-1048"), /Provider unavailable/);
  const caseRecord = store.get("RX-1048");
  assert.equal(caseRecord.coordinationStarted, false);
  assert.equal(caseRecord.evidence.permittedActionCompleted, false);
});

test("live adapter sends a real configured action and requires an allowlist", async () => {
  const keys = ["ALLOW_LIVE_TELEPHONY", "A1MOBILE_API_KEY", "A1MOBILE_PHONE_NUMBER", "PUBLIC_APP_URL", "A1MOBILE_WEBHOOK_SECRET", "A1MOBILE_CALL_ACTION_URL", "A1MOBILE_TEXT_ACTION_URL", "A1MOBILE_COORDINATION_RECIPIENT", "LIVE_ALLOWED_RECIPIENTS"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    ALLOW_LIVE_TELEPHONY: "true", A1MOBILE_API_KEY: "test-key", A1MOBILE_PHONE_NUMBER: "+15550000000",
    PUBLIC_APP_URL: "https://rxrelay.example", A1MOBILE_WEBHOOK_SECRET: "test-secret",
    A1MOBILE_CALL_ACTION_URL: "https://provider.example/calls", A1MOBILE_TEXT_ACTION_URL: "https://provider.example/texts",
    A1MOBILE_COORDINATION_RECIPIENT: "+15550000002", LIVE_ALLOWED_RECIPIENTS: "+15550000001,+15550000002",
  });
  try {
    let captured;
    const adapter = new A1MobileAdapter({ fetchImpl: async (url, options) => {
      captured = { url, body: JSON.parse(options.body), auth: options.headers.authorization };
      return { ok: true, headers: { get: () => "application/json" }, json: async () => ({ callId: "provider-call-1" }) };
    } });
    const action = await adapter.placeCoordinationCall({ caseId: "RX-1048", summary: "status only" });
    assert.equal(action.mode, "live");
    assert.equal(action.id, "provider-call-1");
    assert.equal(captured.url, "https://provider.example/calls");
    assert.equal(captured.body.to, "+15550000002");
    assert.equal(captured.auth, "Bearer test-key");
    process.env.LIVE_ALLOWED_RECIPIENTS = "";
    await assert.rejects(() => adapter.sendPatientUpdate({ caseId: "RX-1048", recipient: "+15550000001", text: "Update", consentRecorded: true }), /allowlist/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("duplicate telephony events do not produce duplicate case activity", async () => {
  const store = new CaseStore({ telephony: new DemoTelephonyAdapter() });
  const event = { eventId: "dedupe-1", transcript: "I need pharmacy status", asrConfidence: .9, noiseLevel: .1 };
  assert.equal((await store.receiveWebhook(event)).deduplicated, false);
  assert.equal((await store.receiveWebhook(event)).deduplicated, true);
});

test("shared JSON persistence keeps voice and dashboard case state aligned", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rxrelay-store-"));
  const filePath = path.join(dir, "cases.json");
  try {
    const voice = new CaseStore({ telephony: new DemoTelephonyAdapter(), persistence: new JsonCasePersistence(filePath), seedDemo: false });
    const opened = voice.openVoiceCase({ callId: "persist-call-1", from: "+15550000088" });
    await voice.handleVoiceTurn({
      caseId: opened.id,
      transcript: "I consent to a pharmacy status follow-up and text updates.",
      asrConfidence: .98,
      noiseLevel: .04,
    });
    const dashboard = new CaseStore({ telephony: new DemoTelephonyAdapter(), persistence: new JsonCasePersistence(filePath), seedDemo: false });
    const shared = dashboard.get(opened.id);
    assert.equal(shared.source, "voice");
    assert.equal(shared.evidence.consentRecorded, true);
    assert.equal(shared.patient.recipient, "+15550000088");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

import { buildProofReceipt, verifyProofReceipt } from "../src/receipt.mjs";
import { _resetCounterpartTokens } from "../src/counterpart.mjs";
import { publishCaseEvent, caseBus } from "../src/bus.mjs";

test("signed proof receipts verify and detect tampering", async () => {
  const store = new CaseStore({ telephony: new DemoTelephonyAdapter(), seedDemo: false });
  const opened = store.createCase({ patientAlias: "Pat", recipient: "+15550002222", medication: "Demo" });
  store.recordConsent(opened.id, { granted: true, statement: "I consent to a pharmacy status follow-up and text updates." });
  await store.beginCoordination(opened.id);
  store.recordPharmacyBlocker(opened.id);
  store.recordClinicSubmission(opened.id);
  await store.recordPharmacyReady(opened.id);
  const receipt = store.exportReceipt(opened.id);
  assert.equal(verifyProofReceipt(receipt).ok, true);
  const tampered = structuredClone(receipt);
  tampered.evidence.consentRecorded = false;
  assert.equal(verifyProofReceipt(tampered).ok, false);
});

test("counterpart magic links can attest outcomes without patient speech", async () => {
  _resetCounterpartTokens();
  const store = new CaseStore({ telephony: new DemoTelephonyAdapter(), seedDemo: false });
  const opened = store.createCase({ patientAlias: "Pat", recipient: "+15550003333", medication: "Demo" });
  store.recordConsent(opened.id, { granted: true, statement: "I consent to a pharmacy status follow-up and text updates." });
  await store.beginCoordination(opened.id);
  const pharmacy = store.issueCounterpartLink(opened.id, "pharmacy");
  await store.attestCounterpart(pharmacy.link.token, { outcome: "pharmacy_blocker", note: "PA needed" });
  const clinic = store.issueCounterpartLink(opened.id, "clinic");
  await store.attestCounterpart(clinic.link.token, { outcome: "clinic_submission", reference: "PA-77" });
  const readyLink = store.issueCounterpartLink(opened.id, "pharmacy");
  const ready = await store.attestCounterpart(readyLink.link.token, { outcome: "pharmacy_ready" });
  assert.equal(ready.proof.ready, true);
  assert.equal(ready.events.some((event) => event.data?.attestedBy === "pharmacy"), true);
});

test("human ops queue supports escalate and resume automation", () => {
  const store = new CaseStore({ telephony: new DemoTelephonyAdapter(), seedDemo: false });
  const opened = store.createCase({ patientAlias: "Pat", recipient: "+15550004444", medication: "Demo" });
  store.recordConsent(opened.id, { granted: true, statement: "I consent to a pharmacy status follow-up and text updates." });
  store.escalate(opened.id, "Needs pharmacist judgment");
  assert.equal(store.listHumanQueue().some((item) => item.id === opened.id), true);
  const resumed = store.resumeAutomation(opened.id);
  assert.equal(resumed.humanReview, false);
  assert.equal(store.listHumanQueue().some((item) => item.id === opened.id), false);
});

test("timeout escalation routes stale coordinating cases to humans", async () => {
  const store = new CaseStore({ telephony: new DemoTelephonyAdapter(), seedDemo: false });
  const opened = store.createCase({ patientAlias: "Pat", recipient: "+15550005555", medication: "Demo" });
  store.recordConsent(opened.id, { granted: true, statement: "I consent to a pharmacy status follow-up and text updates." });
  await store.beginCoordination(opened.id);
  store.mutate(() => {
    const record = store.cases.get(opened.id);
    record.createdAt = new Date(Date.now() - 1000 * 60 * 60).toISOString();
    return null;
  });
  const escalated = store.markStaleForHumanReview(1000 * 60 * 5);
  assert.deepEqual(escalated, [opened.id]);
  assert.equal(store.get(opened.id).humanReview, true);
});

test("case bus publishes envelopes for live SSE consumers", () => {
  let seen = null;
  const onCase = (envelope) => { seen = envelope; };
  caseBus.on("case", onCase);
  publishCaseEvent("unit_probe", { caseId: "RX-TEST" });
  caseBus.off("case", onCase);
  assert.equal(seen.type, "unit_probe");
  assert.equal(seen.caseId, "RX-TEST");
});

test("verified capture mode is exposed on the verified tier label", async () => {
  const { TIER_LABELS } = await import("../src/pavo.mjs");
  assert.equal(TIER_LABELS.verified.captureMode, "speech_digits");
  const route = routeTurn({
    transcript: "The prior authorization number sounded like PA two zero four eight",
    asrConfidence: 0.71,
    noiseLevel: 0.55,
  });
  assert.equal(route.tier, "verified");
});

import {
  detectConversationalIntent,
  consentFromTranscript,
  extractCallerNotes,
} from "../src/dialogue.mjs";

test("dialogue understands venting, off-topic, and story-shaped outcomes", () => {
  assert.equal(detectConversationalIntent("I've called ten times and I'm so frustrated nobody is helping"), "vent");
  assert.equal(detectConversationalIntent("what's the weather today"), "off_topic");
  assert.equal(
    detectConversationalIntent("So yeah after all that the pharmacy said they need prior authorization before they can fill it", "coordinating"),
    "pharmacy_blocker",
  );
  assert.equal(
    detectConversationalIntent("still waiting, nothing yet from them", "waiting_pharmacy"),
    "still_waiting",
  );
});

test("natural consent phrases still require a scoped yes", () => {
  assert.equal(consentFromTranscript("sure, you can check my pharmacy status").granted, true);
  assert.equal(consentFromTranscript("please help with my prescription").granted, false);
  assert.equal(consentFromTranscript("please help with my prescription").softAsk, true);
});

test("caller notes capture pharmacy mentions", () => {
  const notes = extractCallerNotes("I've been stuck with CVS pharmacy for 5 days");
  assert.ok(notes.pharmacyName);
  assert.equal(notes.waitDays, 5);
});
