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
  const previous = {
    PAVO_OPENAI_BASE_URL: process.env.PAVO_OPENAI_BASE_URL,
    PAVO_OPENAI_API_KEY: process.env.PAVO_OPENAI_API_KEY,
    PAVO_FAST_MODEL: process.env.PAVO_FAST_MODEL,
    PAVO_STRONG_MODEL: process.env.PAVO_STRONG_MODEL,
    PAVO_CHAT_MODEL: process.env.PAVO_CHAT_MODEL,
  };
  Object.assign(process.env, {
    PAVO_OPENAI_BASE_URL: "https://hack.a1mobile.com/gw/v1",
    PAVO_OPENAI_API_KEY: "test-key",
    PAVO_FAST_MODEL: "fast",
    PAVO_STRONG_MODEL: "strong",
  });
  delete process.env.PAVO_CHAT_MODEL;
  try {
    let request;
    const engine = new PavoInferenceEngine({ fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "I will confirm the pharmacy status." } }],
        }),
      };
    } });
    const route = routeTurn({ transcript: "I could not hear the prior authorization number", asrConfidence: .61, noiseLevel: .55 });
    const reply = await engine.respond({ transcript: "test", route, caseBrief: "case" });
    assert.equal(request.url, "https://hack.a1mobile.com/gw/v1/chat/completions");
    assert.equal(request.body.model, "strong");
    assert.ok(request.body.max_tokens >= 180);
    assert.equal(request.body.messages[0].role, "system");
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

test("natural help requests count as scoped consent", () => {
  assert.equal(consentFromTranscript("sure, you can check my pharmacy status").granted, true);
  assert.equal(consentFromTranscript("please help with my prescription").granted, true);
  assert.equal(consentFromTranscript("please help with my prescription").softAsk, true);
  assert.equal(consentFromTranscript("I've been waiting five days and can't get my medication from CVS").granted, true);
});

test("ASR repairs and avoid-repeat keep phone turns clean", async () => {
  const { normalizeTranscript, avoidRepeat } = await import("../src/dialogue.mjs");
  assert.match(normalizeTranscript("they need prior off before they can fill it"), /prior auth/i);
  assert.match(normalizeTranscript("I'm stuck at see vs pharmacy"), /CVS/i);
  assert.match(normalizeTranscript("wall greens needs pryor auth for my met for min"), /Walgreens.*prior auth.*metformin/i);
  assert.match(normalizeTranscript("cbs pharmacy said ready to pick up"), /CVS.*ready for pickup/i);
  const repeated = avoidRepeat(
    "I'm listening. Learn what they need.",
    [{ role: "assistant", text: "I'm listening. Learn what they need." }],
  );
  assert.notEqual(repeated, "I'm listening. Learn what they need.");
  // Near-paraphrases from a strong LLM must be kept (anti-repeat is identical lines only).
  const nearDup = avoidRepeat(
    "Got it — prior authorization is on the record. Tell me when your doctor files it.",
    [{ role: "assistant", text: "Got it — prior authorization is on the record. Tell me when your doctor or clinic files it." }],
  );
  assert.match(nearDup, /prior authorization is on the record/i);
});

test("voice lexicon expands paraphrases for intent and consent", async () => {
  const { detectConversationalIntent, consentFromTranscript } = await import("../src/dialogue.mjs");
  const { lexiconMeta, gatherSpeechHintsAttr, fewShotPromptBlock } = await import("../src/voice-training/index.mjs");
  const meta = lexiconMeta();
  assert.ok(meta.exemplarCount >= 8);
  assert.ok(meta.speechHintCount >= 10);
  assert.match(gatherSpeechHintsAttr(), /metformin/i);
  assert.match(fewShotPromptBlock(), /Maya:/);

  assert.equal(detectConversationalIntent("Insurance is holding it and they won't fill"), "pharmacy_blocker");
  assert.equal(detectConversationalIntent("Doc took care of it this morning", "waiting_clinic"), "clinic_submission");
  assert.equal(detectConversationalIntent("Filled and ready at the pharmacy", "waiting_pharmacy"), "pharmacy_ready");
  assert.equal(detectConversationalIntent("Get me a human please"), "escalate");
  assert.equal(detectConversationalIntent("I'm exhausted and sick of calling"), "vent");
  assert.equal(consentFromTranscript("Could you look into my refill at Walgreens?").granted, true);
  assert.equal(consentFromTranscript("I've been stuck with Costco pharmacy and need my meds").granted, true);
});

test("paraphrase path still hits 4/4 proof without legalese", async () => {
  const store = new CaseStore({ telephony: new DemoTelephonyAdapter(), seedDemo: false });
  const opened = store.openVoiceCase({ callId: "lexicon-e2e", from: "+15550008888" });
  await store.handleVoiceTurn({
    caseId: opened.id,
    transcript: "Can you check what's going on with my prescription at see vs? It's metformin.",
    asrConfidence: 0.93,
  });
  assert.equal(store.get(opened.id).evidence.consentRecorded, true);
  await store.handleVoiceTurn({
    caseId: opened.id,
    transcript: "They're waiting on insurance / PA.",
    asrConfidence: 0.92,
  });
  assert.ok(store.get(opened.id).pharmacy.blocker);
  await store.handleVoiceTurn({
    caseId: opened.id,
    transcript: "The clinic submitted it.",
    asrConfidence: 0.94,
  });
  assert.equal(store.get(opened.id).clinic.submissionRecorded, true);
  const ready = await store.handleVoiceTurn({
    caseId: opened.id,
    transcript: "It's ready.",
    asrConfidence: 0.95,
  });
  assert.equal(store.get(opened.id).status.key, "resolved");
  assert.equal(store.get(opened.id).proof.ready, true);
  const replies = store.get(opened.id).conversationTurns.filter((t) => t.role === "assistant").map((t) => t.text);
  const unique = new Set(replies.map((r) => r.toLowerCase()));
  assert.equal(unique.size, replies.length, "assistant should not repeat identical lines");
  assert.ok(ready.reply.length < 220);
});

test("natural patient story completes proof without legalese consent", async () => {
  const store = new CaseStore({ telephony: new DemoTelephonyAdapter(), seedDemo: false });
  const opened = store.openVoiceCase({ callId: "story-1", from: "+15550007777" });
  await store.handleVoiceTurn({
    caseId: opened.id,
    transcript: "Hi, please help — I've been stuck at CVS pharmacy for five days on my metformin.",
    asrConfidence: 0.94,
  });
  assert.equal(store.get(opened.id).evidence.consentRecorded, true);
  await store.handleVoiceTurn({
    caseId: opened.id,
    transcript: "They said they need prior authorization before they can fill it.",
    asrConfidence: 0.93,
  });
  assert.ok(store.get(opened.id).pharmacy.blocker);
  await store.handleVoiceTurn({
    caseId: opened.id,
    transcript: "My doctor filed the PA this morning.",
    asrConfidence: 0.95,
  });
  assert.equal(store.get(opened.id).clinic.submissionRecorded, true);
  await store.handleVoiceTurn({
    caseId: opened.id,
    transcript: "The pharmacy says it's ready for pickup.",
    asrConfidence: 0.96,
  });
  assert.equal(store.get(opened.id).status.key, "resolved");
  assert.equal(store.get(opened.id).proof.ready, true);
});

test("caller notes capture pharmacy mentions", () => {
  const notes = extractCallerNotes("I've been stuck with CVS pharmacy for 5 days");
  assert.ok(notes.pharmacyName);
  assert.equal(notes.waitDays, 5);
});

test("PAVO exposes tasteful user-facing route labels", () => {
  const verified = routeTurn({
    transcript: "Please call +15551234567 tomorrow at 3:00 pm about prior authorization PA2048",
    asrConfidence: 0.7,
    noiseLevel: 0.5,
  });
  assert.equal(verified.tier, "verified");
  assert.equal(verified.userFacingLabel, "Verified details");
  assert.match(verified.userFacingReason, /Verified details/i);

  const safe = routeTurn({ transcript: "I have chest pain and difficulty breathing" });
  assert.equal(safe.tier, "safe_stop");
  assert.equal(safe.userFacingLabel, "Safety handoff");
});

test("memory guards block consent re-asks and duplicate status questions", async () => {
  const { enforceMemoryGuards, markAskedStatusQuestion, lastAssistantLines } = await import("../src/dialogue.mjs");
  const asked = markAskedStatusQuestion("Want me to start a pharmacy status check now?", "ready", {});
  assert.equal(asked.ready, true);
  const again = enforceMemoryGuards("Want me to start a pharmacy status check now?", {
    consented: true,
    statusKey: "ready",
    conversationTurns: [{ role: "assistant", text: "Want me to start a pharmacy status check now?" }],
    askedStatusQuestions: asked,
  });
  assert.doesNotMatch(again, /want me to start a pharmacy status check now/i);
  const noConsentAgain = enforceMemoryGuards("Please say: I consent to a pharmacy status follow-up.", {
    consented: true,
    statusKey: "coordinating",
    conversationTurns: [],
    askedStatusQuestions: {},
  });
  assert.doesNotMatch(noConsentAgain, /i consent/i);
  assert.deepEqual(
    lastAssistantLines([
      { role: "user", text: "hi" },
      { role: "assistant", text: "one" },
      { role: "assistant", text: "two" },
      { role: "assistant", text: "three" },
    ], 2),
    ["two", "three"],
  );
});

test("forget session clears conversation memory", async () => {
  const store = new CaseStore({ telephony: new DemoTelephonyAdapter(), seedDemo: false });
  const opened = store.openVoiceCase({ callId: "forget-1", from: "+15550006666" });
  await store.handleVoiceTurn({
    caseId: opened.id,
    transcript: "I consent to a pharmacy status follow-up and text updates.",
    asrConfidence: 0.96,
  });
  assert.ok(store.get(opened.id).conversationTurns.length > 0);
  const cleared = store.forgetSession(opened.id);
  assert.equal(cleared.conversationTurns.length, 0);
  assert.equal(store.getPublicView(opened.id).patient.recipient, "[redacted]");
});

test("empty and garbage ASR do not count as usable speech", async () => {
  const { isUsableSpeech } = await import("../src/dialogue.mjs");
  assert.equal(isUsableSpeech("").ok, false);
  assert.equal(isUsableSpeech("   ").ok, false);
  assert.equal(isUsableSpeech("...").ok, false);
  assert.equal(isUsableSpeech("um").ok, false);
  assert.equal(isUsableSpeech("uh huh").ok, false);
  assert.equal(isUsableSpeech("okay").ok, false);
  assert.equal(isUsableSpeech("help me with CVS metformin", 0.2).ok, false);
  assert.equal(isUsableSpeech("help me with CVS metformin", 0.9).ok, true);
  assert.equal(isUsableSpeech("It's ready.").ok, true);
  assert.equal(isUsableSpeech("Please help — I've been stuck at CVS on my metformin.").ok, true);
});

test("exact judge demo lines: every turn acts and speaks a first-person ack", async () => {
  const store = new CaseStore({ telephony: new DemoTelephonyAdapter(), seedDemo: false });
  const opened = store.openVoiceCase({ callId: "judge-demo", from: "+15550009999" });
  const lines = [
    ["Please help — I've been stuck at CVS on my metformin.", "start_coordination"],
    ["They need prior authorization.", "pharmacy_blocker"],
    ["My doctor filed the PA.", "clinic_submission"],
    ["It's ready for pickup.", "pharmacy_ready"],
  ];
  const replies = [];
  for (const [line, expectedAction] of lines) {
    const turn = await store.handleVoiceTurn({ caseId: opened.id, transcript: line, asrConfidence: 0.9 });
    assert.equal(turn.action, expectedAction, `"${line}" must trigger ${expectedAction}`);
    assert.equal(turn.inference.source, "scripted-action", "action turns must use the scripted ack, not the LLM");
    replies.push(turn.reply);
  }
  const c = store.get(opened.id);
  assert.equal(c.proof.ready, true);
  assert.equal(c.status.key, "resolved");
  assert.equal(c.proof.checks.filter((x) => x.passed).length, 4);
  assert.equal(c.callerNotes.pharmacyName, "CVS");
  assert.equal(c.callerNotes.medicationHint, "metformin");
  assert.equal(new Set(replies.map((r) => r.toLowerCase())).size, replies.length, "acks must be distinct");
  for (const reply of replies) {
    assert.doesNotMatch(reply, /what'?s going on/i, `looping-IVR question leaked: ${reply}`);
    assert.match(reply, /\bI['’](ve|m)\b/, `ack must be first-person doing-work: ${reply}`);
  }
  assert.match(replies[3], /today|same-day/i, "final ack must state pickup timing");
  assert.match(replies[3], /update/i, "final ack must confirm the patient update");
});

test("missed middle turns cannot dead-end the case (chain backfill)", async () => {
  const store = new CaseStore({ telephony: new DemoTelephonyAdapter(), seedDemo: false });
  const skipBoth = store.openVoiceCase({ callId: "skip-both", from: "+15550009998" });
  await store.handleVoiceTurn({ caseId: skipBoth.id, transcript: "Please help — I've been stuck at CVS on my metformin.", asrConfidence: 0.9 });
  const ready = await store.handleVoiceTurn({ caseId: skipBoth.id, transcript: "It's ready for pickup.", asrConfidence: 0.9 });
  assert.equal(ready.action, "pharmacy_ready");
  assert.equal(ready.case.proof.ready, true);

  const skipBlocker = store.openVoiceCase({ callId: "skip-blocker", from: "+15550009997" });
  await store.handleVoiceTurn({ caseId: skipBlocker.id, transcript: "Please help — I've been stuck at CVS on my metformin.", asrConfidence: 0.9 });
  const clinic = await store.handleVoiceTurn({ caseId: skipBlocker.id, transcript: "My doctor filed the PA.", asrConfidence: 0.9 });
  assert.equal(clinic.action, "clinic_submission");
  assert.ok(store.get(skipBlocker.id).pharmacy.blocker, "clinic filing implies the PA blocker");
});

test("no-input prompts rotate, content-bearing speech survives modest confidence", async () => {
  const { noInputPrompt, isUsableSpeech, enforceMemoryGuards } = await import("../src/dialogue.mjs");
  assert.notEqual(noInputPrompt(0), noInputPrompt(1));
  assert.notEqual(noInputPrompt(1), noInputPrompt(2));
  for (const attempt of [0, 1, 2]) assert.doesNotMatch(noInputPrompt(attempt), /what'?s going on/i);
  assert.equal(isUsableSpeech("It's ready for pickup.", 0.3).ok, true);
  assert.equal(isUsableSpeech("They need prior authorization.", 0.32).ok, true);
  const guarded = enforceMemoryGuards("Thanks. What's going on with the prescription?", {
    consented: true,
    statusKey: "coordinating",
    conversationTurns: [],
    askedStatusQuestions: {},
  });
  assert.doesNotMatch(guarded, /what'?s going on/i);
  assert.match(guarded, /pharmacy/i);
});

test("Alex natural path still reaches proof 4/4 with memory-safe replies", async () => {
  const store = new CaseStore({ telephony: new DemoTelephonyAdapter(), seedDemo: false });
  const opened = store.openVoiceCase({ callId: "alex-demo", from: "+15550005555" });
  const lines = [
    "Hi — please help, I've been stuck at CVS for five days on my metformin.",
    "They said they need prior authorization before they can fill it.",
    "My doctor filed the PA this morning.",
    "The pharmacy says it's ready for pickup.",
  ];
  const replies = [];
  for (const line of lines) {
    const turn = await store.handleVoiceTurn({ caseId: opened.id, transcript: line, asrConfidence: 0.94 });
    replies.push(turn.reply);
  }
  const c = store.get(opened.id);
  assert.equal(c.evidence.consentRecorded, true);
  assert.ok(c.pharmacy.blocker);
  assert.equal(c.clinic.submissionRecorded, true);
  assert.equal(c.pharmacy.readyForPickup, true);
  assert.equal(c.proof.ready, true);
  assert.equal(c.status.key, "resolved");
  assert.equal(c.proof.checks.filter((x) => x.passed).length, 4);
  assert.equal(new Set(replies.map((r) => r.toLowerCase())).size, replies.length);
  for (const reply of replies) {
    assert.doesNotMatch(reply, /say:?\s*i consent/i);
    assert.ok(reply.split(/\s+/).length <= 90, `reply too long for phone: ${reply}`);
  }
});
