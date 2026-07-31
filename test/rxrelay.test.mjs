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

test("PAVO routing upgrades the full pipeline for uncertain critical audio", () => {
  const route = routeTurn({ transcript: "The pharmacy said the prior authorization number is unclear", asrConfidence: 0.62, noiseLevel: 0.6 });
  assert.equal(route.tier, "verified");
  assert.match(route.guardrail, /Confirm critical names/);
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
