let activeCase;

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

function pipeline(caseRecord) {
  const selected = caseRecord.lastRoute.tier;
  const steps = ["fast", "balanced", "verified", "safe_stop"];
  const labels = { fast: "Fast intake", balanced: "Balanced", verified: "Verified", safe_stop: "Safety stop" };
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
  const btn = (action, title, detail, disabled, danger = false) => `<button class="action ${danger ? "danger" : ""}" data-action="${action}" ${disabled ? "disabled" : ""}><strong>${title}</strong><small>${detail}</small></button>`;
  return [
    btn("start", "1 · Call pharmacy", "Permitted status check", !enabled || caseRecord.coordinationStarted),
    btn("blocker", "2 · Record blocker", "Pharmacy says PA needed", !enabled || !caseRecord.coordinationStarted || hasBlocker),
    btn("clinic", "3 · Record clinic step", "PA submitted", !enabled || !hasBlocker || hasSubmission),
    btn("ready", "4 · Confirm readiness", "Sends consented SMS", !enabled || !hasSubmission || ready),
    btn("escalate", "Escalate safely", "Keep case amber", caseRecord.humanReview || caseRecord.status.key === "resolved", true),
  ].join("");
}

function render(caseRecord) {
  activeCase = caseRecord;
  $("#case-title").textContent = `${caseRecord.id} · Demo prescription-access case`;
  $("#case-created").textContent = `Opened ${time(caseRecord.createdAt)}`;
  const status = $("#case-status"); status.textContent = caseRecord.status.label; status.className = `status ${caseRecord.status.tone}`;
  $("#patient-name").textContent = caseRecord.patient.alias;
  $("#pavo-label").textContent = `${caseRecord.pipeline.label} · ${caseRecord.lastRoute.reason}`;
  $("#pipeline").innerHTML = pipeline(caseRecord);
  $("#patient-lane").innerHTML = laneEvent(caseRecord, "patient", "Waiting for a consented request.");
  $("#pharmacy-lane").innerHTML = laneEvent(caseRecord, "pharmacy", "No pharmacy outcome recorded.");
  $("#clinic-lane").innerHTML = laneEvent(caseRecord, "clinic", "No clinic / insurer step needed yet.");
  const passed = caseRecord.proof.checks.filter((item) => item.passed).length;
  $("#proof-score").textContent = `${passed}/4`;
  $("#proof-list").innerHTML = caseRecord.proof.checks.map((item) => `<li class="proof-item ${item.passed ? "pass" : ""}"><span class="check">${item.passed ? "✓" : "·"}</span><span>${escape(item.label)}</span></li>`).join("");
  const footer = $("#proof-footer"); footer.textContent = caseRecord.proof.ready ? "Verified: all closure evidence is present." : "Still open: missing evidence prevents a false completion claim."; footer.className = caseRecord.proof.ready ? "proof-footer verified" : "proof-footer";
  $("#actions").innerHTML = actions(caseRecord);
  $("#timeline").innerHTML = caseRecord.events.map((event) => `<li class="${escape(event.lane)}"><span class="timeline-dot"></span><time>${time(event.createdAt)}</time><strong>${escape(event.type.replaceAll("_", " "))}</strong>${escape(event.summary)}</li>`).join("");
  const lastMessage = caseRecord.communications[0];
  $("#message-preview").innerHTML = lastMessage ? `${escape(lastMessage.text)}<span class="delivery">${escape(lastMessage.mode)} · consent recorded</span>` : '<span class="message-placeholder">No patient update has been sent.</span>';
}

async function loadCases(preferredId) {
  const [{ cases }, configuration] = await Promise.all([request("/api/cases"), request("/api/config")]);
  $("#mode-pill").innerHTML = `<span class="pulse"></span>${configuration.mode === "sandbox" ? "Sandbox · no real outreach" : "Live configuration"}`;
  const picker = $("#case-picker");
  picker.innerHTML = cases.map((item) => `<option value="${escape(item.id)}">${escape(item.id)} · ${escape(item.patient.alias)} · ${escape(item.source)}</option>`).join("");
  const selected = cases.find((item) => item.id === preferredId) || cases.find((item) => item.source === "voice") || cases.find((item) => item.id === "RX-1048") || cases[0];
  if (!selected) throw new Error("No cases are available.");
  picker.value = selected.id;
  render(selected);
}

async function load() {
  await loadCases();
}

$("#case-picker").addEventListener("change", async (event) => {
  try {
    const result = await request(`/api/cases/${encodeURIComponent(event.target.value)}`);
    render(result.case);
  } catch (error) {
    toast(error.message);
  }
});

$("#actions").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]"); if (!button || button.disabled) return;
  const action = button.dataset.action;
  const endpoints = { start: "/start", blocker: "/pharmacy-blocker", clinic: "/clinic-submission", ready: "/pharmacy-ready", escalate: "/escalate" };
  button.disabled = true;
  try {
    const payload = action === "escalate" ? { reason: "Demo branch: human coordinator needed before a completion claim." } : {};
    const result = await request(`/api/cases/${activeCase.id}${endpoints[action]}`, { method: "POST", body: JSON.stringify(payload) });
    render(result.case); toast(action === "ready" ? "Resolution proof completed — sandbox patient update recorded." : "Evidence recorded.");
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
    $("#voice-result").innerHTML = `<div class="route-result"><strong>${escape(result.route.tier.replaceAll("_", " "))} route</strong><span>${escape(result.route.reason)}</span><span>Voice reply: “${escape(result.reply)}”</span></div>`;
  } catch (error) { toast(error.message); }
});

load().catch((error) => { toast(error.message); });
setInterval(() => {
  if (!activeCase) return;
  loadCases(activeCase.id).catch(() => {});
}, 4000);
