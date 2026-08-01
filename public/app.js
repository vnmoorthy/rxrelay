let activeCase;
let lastConfig;

const $ = (selector) => document.querySelector(selector);
const escape = (value = "") => String(value).replace(/[&<>'"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[character]));
const time = (value) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "Request failed.");
  return json;
}

function toast(message) {
  const node = $("#toast"); node.textContent = message; node.classList.add("visible");
  window.clearTimeout(toast.timer); toast.timer = window.setTimeout(() => node.classList.remove("visible"), 3600);
}

function modeLabel(configuration) {
  if (configuration.mode === "sandbox") return "Sandbox · no real outreach";
  if (configuration.mode === "live-configured") return "Live · OTP allowlist ready";
  const missing = configuration.liveReadiness?.missing?.slice(0, 3).join(", ") || "incomplete";
  return `Live incomplete · ${missing}`;
}

function pipeline(caseRecord) {
  const selected = caseRecord.lastRoute.tier;
  const steps = ["fast", "balanced", "verified", "safe_stop"];
  const labels = { fast: "Fast response", balanced: "Balanced help", verified: "Verified details", safe_stop: "Safety handoff" };
  return steps.map((step, index) => `${index ? '<span class="pipe-arrow">→</span>' : ""}<span class="pipe-step ${step === selected ? "active" : ""}">${labels[step]}</span>`).join("");
}

function laneEvent(caseRecord, lane, empty) {
  const events = caseRecord.events.filter((event) => event.lane === lane).slice(0, 3);
  if (!events.length) return `<div class="lane-card empty">${empty}</div>`;
  return events.map((event, index) => `<div class="lane-card ${index === 0 ? "current" : ""}"><strong>${escape(event.type.replaceAll("_", " "))}</strong>${escape(event.summary)}</div>`).join("");
}

function actions(caseRecord) {
  const enabled = !caseRecord.humanReview;
  const hasBlocker = Boolean(caseRecord.pharmacy.blocker);
  const hasSubmission = Boolean(caseRecord.clinic.submissionRecorded);
  const ready = Boolean(caseRecord.pharmacy.readyForPickup);
  const consented = caseRecord.evidence.consentRecorded;
  const btn = (action, title, detail, disabled, danger = false) => `<button class="action ${danger ? "danger" : ""}" data-action="${action}" ${disabled ? "disabled" : ""}><strong>${title}</strong><small>${detail}</small></button>`;
  return [
    btn("consent", "0 · Record consent", "Scoped status + text consent", consented || caseRecord.humanReview),
    btn("start", "1 · Call pharmacy", "Permitted status check", !enabled || !consented || caseRecord.coordinationStarted),
    btn("blocker", "2 · Record blocker", "Pharmacy says PA needed", !enabled || !caseRecord.coordinationStarted || hasBlocker),
    btn("clinic", "3 · Record clinic step", "PA submitted", !enabled || !hasBlocker || hasSubmission),
    btn("ready", "4 · Confirm readiness", "Sends consented SMS", !enabled || !hasSubmission || ready),
    btn("link-pharmacy", "Issue pharmacy link", "Counterpart attestation URL", !enabled || !consented),
    btn("link-clinic", "Issue clinic link", "Counterpart attestation URL", !enabled || !consented),
    btn("escalate", "Escalate safely", "Human ops queue", caseRecord.humanReview || caseRecord.status.key === "resolved", true),
    btn("resume", "Resume automation", "Clear human hold", !caseRecord.humanReview || caseRecord.status.key === "resolved"),
  ].join("");
}

function render(caseRecord) {
  activeCase = caseRecord;
  $("#case-title").textContent = `${caseRecord.id} · ${caseRecord.source} case`;
  $("#case-created").textContent = `Opened ${time(caseRecord.createdAt)}`;
  const status = $("#case-status"); status.textContent = caseRecord.status.label; status.className = `status ${caseRecord.status.tone}`;
  $("#patient-name").textContent = caseRecord.patient.alias;
  const faceLabel = caseRecord.lastRoute.userFacingLabel || caseRecord.pipeline.label;
  const faceReason = caseRecord.lastRoute.userFacingReason || caseRecord.lastRoute.reason;
  $("#route-chip").textContent = faceLabel;
  $("#pavo-label").textContent = `${faceReason}${caseRecord.lastRoute.signals?.demand != null ? ` · demand ${caseRecord.lastRoute.signals.demand}` : ""}`;
  $("#pipeline").innerHTML = pipeline(caseRecord);
  $("#patient-lane").innerHTML = laneEvent(caseRecord, "patient", "Waiting for a consented request.");
  $("#pharmacy-lane").innerHTML = laneEvent(caseRecord, "pharmacy", "No pharmacy outcome recorded.");
  $("#clinic-lane").innerHTML = laneEvent(caseRecord, "clinic", "No clinic / insurer step needed yet.");
  const passed = caseRecord.proof.checks.filter((item) => item.passed).length;
  $("#proof-score").textContent = `${passed}/4`;
  $("#proof-list").innerHTML = caseRecord.proof.checks.map((item) => `<li class="proof-item ${item.passed ? "pass" : ""}"><span class="check">${item.passed ? "✓" : "·"}</span><span>${escape(item.label)}</span></li>`).join("");
  const footer = $("#proof-footer"); footer.textContent = caseRecord.proof.ready ? "Verified: all closure evidence is present." : "Still open: missing evidence prevents a false completion claim."; footer.className = caseRecord.proof.ready ? "proof-footer verified" : "proof-footer";
  $("#export-receipt").disabled = !caseRecord.proof.ready;
  $("#actions").innerHTML = actions(caseRecord);
  $("#timeline").innerHTML = caseRecord.events.map((event) => `<li class="${escape(event.lane)}"><span class="timeline-dot"></span><time>${time(event.createdAt)}</time><strong>${escape(event.type.replaceAll("_", " "))}</strong>${escape(event.summary)}</li>`).join("");
  const lastMessage = caseRecord.communications[0];
  $("#message-preview").innerHTML = lastMessage ? `${escape(lastMessage.text)}<span class="delivery">${escape(lastMessage.mode)} · consent recorded</span>` : '<span class="message-placeholder">No patient update has been sent.</span>';
}

async function loadQueue() {
  const { queue } = await request("/api/ops/queue");
  if (!queue.length) {
    $("#ops-queue").innerHTML = '<span class="message-placeholder">No cases in human review.</span>';
    return;
  }
  $("#ops-queue").innerHTML = queue.map((item) => `<button type="button" class="queue-item" data-case="${escape(item.id)}"><strong>${escape(item.id)}</strong><span>${escape(item.patient.alias)} · ${escape(item.status.label)}</span></button>`).join("");
}

async function loadCases(preferredId) {
  const [{ cases }, configuration] = await Promise.all([request("/api/cases"), request("/api/config")]);
  lastConfig = configuration;
  $("#mode-pill").innerHTML = `<span class="pulse"></span>${modeLabel(configuration)}`;
  const picker = $("#case-picker");
  picker.innerHTML = cases.map((item) => `<option value="${escape(item.id)}">${escape(item.id)} · ${escape(item.patient.alias)} · ${escape(item.source)}</option>`).join("");
  const selected = cases.find((item) => item.id === preferredId) || cases.find((item) => item.source === "voice") || cases.find((item) => item.id === "RX-1048") || cases[0];
  if (!selected) throw new Error("No cases are available.");
  picker.value = selected.id;
  render(selected);
  await loadQueue();
}

function connectSse() {
  const source = new EventSource("/api/events");
  const pill = $("#live-pill");
  source.addEventListener("hello", () => { pill.textContent = "SSE · live"; pill.classList.add("on"); });
  source.onmessage = () => { if (activeCase) loadCases(activeCase.id).catch(() => {}); };
  source.addEventListener("case_event", () => { if (activeCase) loadCases(activeCase.id).catch(() => {}); });
  source.addEventListener("case_created", () => loadCases(activeCase?.id).catch(() => {}));
  source.addEventListener("voice_opened", () => loadCases(activeCase?.id).catch(() => {}));
  source.onerror = () => { pill.textContent = "SSE · reconnecting"; pill.classList.remove("on"); };
}

$("#case-picker").addEventListener("change", async (event) => {
  try {
    const result = await request(`/api/cases/${encodeURIComponent(event.target.value)}`);
    render(result.case);
  } catch (error) {
    toast(error.message);
  }
});

$("#create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    const result = await request("/api/cases", {
      method: "POST",
      body: JSON.stringify({
        patientAlias: form.get("patientAlias"),
        recipient: form.get("recipient"),
        medication: form.get("medication") || "Unspecified medication",
        source: "web",
      }),
    });
    event.target.reset();
    await loadCases(result.case.id);
    toast(`Opened ${result.case.id}`);
  } catch (error) {
    toast(error.message);
  }
});

$("#ops-queue").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-case]");
  if (!button) return;
  try {
    const result = await request(`/api/cases/${encodeURIComponent(button.dataset.case)}`);
    $("#case-picker").value = result.case.id;
    render(result.case);
  } catch (error) {
    toast(error.message);
  }
});

$("#timeout-scan").addEventListener("click", async () => {
  try {
    const result = await request("/api/ops/timeout-scan", { method: "POST", body: JSON.stringify({ maxAgeMs: 1 }) });
    await loadCases(activeCase?.id);
    toast(result.escalated.length ? `Escalated ${result.escalated.join(", ")}` : "No stale open cases.");
  } catch (error) {
    toast(error.message);
  }
});

$("#export-receipt").addEventListener("click", async () => {
  if (!activeCase) return;
  try {
    const result = await request(`/api/cases/${activeCase.id}/receipt`, { method: "POST", body: "{}" });
    const blob = new Blob([JSON.stringify(result.receipt, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${activeCase.id}-proof-receipt.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast(`Receipt tip ${result.receipt.tip.slice(0, 12)}…`);
    await loadCases(activeCase.id);
  } catch (error) {
    toast(error.message);
  }
});

$("#forget-session").addEventListener("click", async () => {
  if (!activeCase) return;
  try {
    const result = await request(`/api/cases/${activeCase.id}/forget`, { method: "POST", body: "{}" });
    render(result.case);
    toast("Session memory cleared.");
  } catch (error) {
    toast(error.message);
  }
});

$("#actions").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]"); if (!button || button.disabled) return;
  const action = button.dataset.action;
  button.disabled = true;
  try {
    if (action === "consent") {
      const result = await request(`/api/cases/${activeCase.id}/consent`, { method: "POST", body: JSON.stringify({ granted: true, statement: "I consent to a pharmacy status follow-up and text updates." }) });
      render(result.case); toast("Consent recorded."); return;
    }
    if (action.startsWith("link-")) {
      const role = action.replace("link-", "");
      const result = await request(`/api/cases/${activeCase.id}/counterpart-link`, { method: "POST", body: JSON.stringify({ role }) });
      $("#link-row").innerHTML = `<a class="attest-url" href="${escape(result.url)}" target="_blank" rel="noreferrer">${escape(result.url)}</a>`;
      render(result.case); toast(`${role} attestation link ready.`); return;
    }
    if (action === "resume") {
      const result = await request(`/api/cases/${activeCase.id}/resume`, { method: "POST", body: JSON.stringify({ reason: "Human cleared automation hold." }) });
      render(result.case); await loadQueue(); toast("Automation resumed."); return;
    }
    const endpoints = { start: "/start", blocker: "/pharmacy-blocker", clinic: "/clinic-submission", ready: "/pharmacy-ready", escalate: "/escalate" };
    const payload = action === "escalate" ? { reason: "Demo branch: human coordinator needed before a completion claim." } : {};
    const result = await request(`/api/cases/${activeCase.id}${endpoints[action]}`, { method: "POST", body: JSON.stringify(payload) });
    render(result.case); await loadQueue();
    toast(action === "ready" ? "Resolution proof completed." : "Evidence recorded.");
  } catch (error) { toast(error.message); button.disabled = false; }
});

$("#asr-confidence").addEventListener("input", (event) => { $("#asr-output").textContent = `${Math.round(Number(event.target.value) * 100)}%`; });
$("#voice-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const transcript = $("#utterance").value;
  const asrConfidence = Number($("#asr-confidence").value);
  try {
    const result = await request("/api/demo/inbound-call", { method: "POST", body: JSON.stringify({ caseId: activeCase.id, transcript, asrConfidence, noiseLevel: 1 - asrConfidence }) });
    render(result.case);
    $("#voice-result").innerHTML = `<div class="route-result"><strong>${escape(result.route.tier.replaceAll("_", " "))} route</strong><span>${escape(result.route.reason)}</span><span>Capture: ${escape(result.case.pipeline.captureMode || "speech")}</span><span>Voice reply: “${escape(result.reply)}”</span></div>`;
  } catch (error) { toast(error.message); }
});

loadCases().catch((error) => { toast(error.message); });
connectSse();
