import test from "node:test";
import assert from "node:assert/strict";
import { routeTurn } from "../src/pavo.mjs";
import { PavoInferenceEngine } from "../src/inference.mjs";
import { CaseStore } from "../src/store.mjs";
import { DemoTelephonyAdapter } from "../src/telephony.mjs";

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

test("duplicate telephony events do not produce duplicate case activity", async () => {
  const store = new CaseStore({ telephony: new DemoTelephonyAdapter() });
  const event = { eventId: "dedupe-1", transcript: "I need pharmacy status", asrConfidence: .9, noiseLevel: .1 };
  assert.equal((await store.receiveWebhook(event)).deduplicated, false);
  assert.equal((await store.receiveWebhook(event)).deduplicated, true);
});
