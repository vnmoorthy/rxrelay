import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Presentation, PresentationFile } from "/Users/moorthy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs";

const OUT = new URL("./output/", import.meta.url);
const W = 1280;
const H = 720;
const C = {
  ink: "#0B1F33", dark: "#071A2B", muted: "#5F6D80", pale: "#F3F5F7",
  panel: "#FFFFFF", rule: "#D8E0E7", teal: "#0E9F8E", tealPale: "#DCF6F0",
  blue: "#3D8DFF", bluePale: "#E5F0FF", amber: "#E6A037", amberPale: "#FFF1D7",
  red: "#D35656", redPale: "#FCE6E6", purple: "#7B61D4", purplePale: "#EEE9FF",
};

async function writeBlob(file, blob) {
  await fs.writeFile(new URL(file, OUT), new Uint8Array(await blob.arrayBuffer()));
}

function rect(slide, x, y, w, h, fill, options = {}) {
  return slide.shapes.add({
    geometry: options.geometry || "rect",
    name: options.name,
    position: { left: x, top: y, width: w, height: h },
    fill,
    line: { style: "solid", fill: options.line ?? fill, width: options.lineWidth ?? 0 },
    borderRadius: options.radius || undefined,
    shadow: options.shadow || undefined,
  });
}

function text(slide, value, x, y, w, h, options = {}) {
  const shape = slide.shapes.add({
    geometry: "textbox",
    name: options.name,
    position: { left: x, top: y, width: w, height: h },
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  shape.text = value;
  shape.text.style = {
    fontFace: "Helvetica Neue",
    fontSize: options.size ?? 16,
    color: options.color ?? C.ink,
    bold: options.bold ?? false,
    italic: options.italic ?? false,
    alignment: options.align ?? "left",
  };
  return shape;
}

function rule(slide, x, y, w, color = C.rule, h = 1) { return rect(slide, x, y, w, h, color); }
function dot(slide, x, y, color = C.teal, size = 10) { return rect(slide, x, y, size, size, color, { geometry: "ellipse" }); }

function header(slide, kicker, number, dark = false) {
  const fg = dark ? "#ECF5FF" : C.ink;
  const muted = dark ? "#A8BACB" : C.muted;
  text(slide, kicker.toUpperCase(), 48, 33, 620, 18, { size: 10, bold: true, color: muted });
  text(slide, `RXRELAY  /  ${String(number).padStart(2, "0")}`, 1012, 33, 220, 18, { size: 10, bold: true, color: muted, align: "right" });
  rule(slide, 48, 58, 1184, dark ? "#294257" : C.rule);
  return fg;
}

function footer(slide, message, dark = false) {
  text(slide, message, 48, 678, 900, 16, { size: 9, color: dark ? "#8BA1B5" : "#8090A1" });
  text(slide, "A1MOBILE VOICE AI HACKATHON · 2026", 880, 678, 352, 16, { size: 9, color: dark ? "#8BA1B5" : "#8090A1", align: "right" });
}

function note(slide, message, sources = []) {
  const sourceBlock = sources.length ? `\n\n[Sources]\n${sources.map((source) => `- ${source}`).join("\n")}\n[/Sources]` : "";
  slide.speakerNotes.textFrame.setText(`${message}${sourceBlock}`);
  slide.speakerNotes.setVisible(true);
}

function pill(slide, value, x, y, w, color, textColor = C.ink) {
  rect(slide, x, y, w, 25, color, { radius: "rounded-full" });
  text(slide, value, x + 10, y + 6, w - 20, 15, { size: 10, bold: true, color: textColor, align: "center" });
}

function card(slide, x, y, w, h, options = {}) {
  return rect(slide, x, y, w, h, options.fill || C.panel, { line: options.line || C.rule, lineWidth: 1, radius: "rounded-xl", shadow: options.shadow || "shadow-sm", name: options.name });
}

function title(slide, value, subtitle, options = {}) {
  const color = options.color || C.ink;
  text(slide, value, 48, options.y || 92, options.width || 850, options.height || 112, { size: options.size || 53, bold: true, color, name: "title" });
  if (subtitle) text(slide, subtitle, 48, (options.y || 92) + (options.height || 112) + 12, options.subWidth || 750, 55, { size: options.subSize || 18, color: options.subColor || C.muted, name: "subtitle" });
}

function addSlide(presentation, setup) {
  const slide = presentation.slides.add();
  setup(slide);
  return slide;
}

function event(slide, x, y, label, value, tint, accent) {
  card(slide, x, y, 210, 110, { fill: tint, line: tint });
  dot(slide, x + 18, y + 18, accent, 9);
  text(slide, label.toUpperCase(), x + 34, y + 15, 150, 15, { size: 9, bold: true, color: C.muted });
  text(slide, value, x + 18, y + 48, 174, 42, { size: 16, bold: true, color: C.ink });
}

function slide1(presentation) {
  addSlide(presentation, (slide) => {
    slide.background.fill = "#FFFFFF";
    text(slide, "VOICE COORDINATION FOR PRESCRIPTION ACCESS", 48, 41, 520, 18, { size: 10, bold: true, color: C.muted });
    text(slide, "RxRelay", 48, 104, 650, 88, { size: 88, bold: true, color: C.ink });
    text(slide, "Make the calls.", 48, 216, 720, 74, { size: 66, bold: true, color: C.ink });
    text(slide, "Bring the proof.", 48, 291, 800, 74, { size: 66, italic: true, color: C.teal });
    text(slide, "A consent-first voice agent that coordinates pharmacy, clinic, and insurer follow-ups—and refuses to call a case resolved without evidence.", 52, 401, 620, 72, { size: 20, color: C.muted });
    pill(slide, "PAVO-POWERED ROUTING", 51, 510, 210, C.tealPale, C.teal);
    pill(slide, "EVIDENCE-GATED", 272, 510, 160, C.bluePale, C.blue);
    card(slide, 814, 118, 352, 420, { fill: C.dark, line: C.dark, shadow: "shadow-lg" });
    text(slide, "RESOLUTION\nPROOF", 850, 159, 210, 50, { size: 12, bold: true, color: "#9FB6C9" });
    const checks = ["Consent recorded", "Permitted action", "Counterpart outcome", "Patient update"];
    checks.forEach((check, index) => {
      const y = 242 + index * 56;
      rect(slide, 850, y, 28, 28, C.teal, { geometry: "ellipse" });
      text(slide, "✓", 857, y + 5, 14, 16, { size: 14, bold: true, color: "#FFFFFF", align: "center" });
      text(slide, check, 894, y + 5, 220, 20, { size: 16, bold: true, color: "#FFFFFF" });
    });
    rule(slide, 850, 481, 280, "#34516A");
    text(slide, "No evidence missing.\nCase can turn green.", 850, 497, 240, 42, { size: 13, color: "#AEEADE" });
    footer(slide, "Proof, not promises.");
    note(slide, "Open with the outcome. Do not start by saying ‘an AI agent.’ Say what becomes possible for someone stranded between systems: one consented request, followed until evidence exists.");
  });
}

function slide2(presentation) {
  addSlide(presentation, (slide) => {
    slide.background.fill = "#FFFFFF";
    header(slide, "The human cost", 2);
    title(slide, "The patient becomes the switchboard.", "When a prescription stalls, the person who needs it is often left to repeat the same story across pharmacy, clinic, and insurer.");
    const nodes = [
      { label: "PHARMACY", copy: "“We need a prior authorization.”", x: 50, color: C.amber, tint: C.amberPale },
      { label: "CLINIC", copy: "“We sent it—call your insurer.”", x: 395, color: C.purple, tint: C.purplePale },
      { label: "INSURER", copy: "“Ask the pharmacy for the status.”", x: 740, color: C.blue, tint: C.bluePale },
    ];
    nodes.forEach((node, index) => {
      card(slide, node.x, 332, 295, 150, { fill: node.tint, line: node.tint });
      text(slide, node.label, node.x + 22, 357, 220, 18, { size: 10, bold: true, color: node.color });
      text(slide, node.copy, node.x + 22, 399, 240, 46, { size: 18, bold: true, color: C.ink });
      if (index < 2) text(slide, "→", node.x + 302, 389, 30, 26, { size: 28, color: "#A4B0BE", align: "center" });
    });
    card(slide, 1086, 265, 146, 286, { fill: C.dark, line: C.dark });
    text(slide, "THE\nPATIENT", 1107, 300, 100, 45, { size: 11, bold: true, color: "#AEC1D1", align: "center" });
    rect(slide, 1125, 370, 68, 68, C.teal, { geometry: "ellipse" });
    text(slide, "?", 1142, 378, 34, 45, { size: 38, bold: true, color: "#FFFFFF", align: "center" });
    text(slide, "calling\nagain", 1102, 466, 112, 36, { size: 13, color: "#FFFFFF", align: "center" });
    footer(slide, "Patient-reported experiences point to repeated pharmacy calls during shortage and authorization friction.");
    note(slide, "Use community voices carefully: these are not prevalence statistics. They make the operational burden emotionally concrete. Say: ‘We heard people describe calling 10, even 20 pharmacies—not because they wanted an agent, but because coordination had failed.’", [
      "https://www.reddit.com/r/ADHD/comments/1qnsfdc/medication_shortagesstill/ (community report of calling multiple pharmacies)",
      "https://www.reddit.com/r/ADHD/comments/125349s (community report of calling 20+ pharmacies)"
    ]);
  });
}

function slide3(presentation) {
  addSlide(presentation, (slide) => {
    slide.background.fill = C.pale;
    header(slide, "The missing layer", 3);
    title(slide, "The problem is not finding a phone number.", "It is closing the loop across institutions—without making the patient prove that every handoff happened.");
    const left = card(slide, 48, 335, 525, 215, { fill: "#FFFFFF", line: C.rule });
    text(slide, "TODAY", 74, 362, 120, 16, { size: 10, bold: true, color: C.red });
    text(slide, "Call → hold → repeat → hope", 74, 404, 430, 58, { size: 27, bold: true });
    text(slide, "No shared state. No reliable owner. No proof that the next actor actually acted.", 74, 492, 410, 42, { size: 15, color: C.muted });
    const right = card(slide, 657, 335, 575, 215, { fill: C.dark, line: C.dark });
    text(slide, "WITH RXRELAY", 685, 362, 170, 16, { size: 10, bold: true, color: "#78E6D4" });
    text(slide, "Consent → coordinate → verify", 685, 404, 480, 40, { size: 31, bold: true, color: "#FFFFFF" });
    text(slide, "One case owns the handoffs. The patient sees evidence, not a vague assurance.", 685, 468, 465, 42, { size: 15, color: "#B8CBDB" });
    rule(slide, 48, 596, 1184, C.rule);
    text(slide, "THE SHIFT", 48, 622, 160, 15, { size: 10, bold: true, color: C.muted });
    text(slide, "from a conversational agent to an accountable coordination system", 208, 618, 700, 22, { size: 17, bold: true, color: C.ink });
    footer(slide, "RxRelay automates only the bounded, non-clinical coordination work.");
    note(slide, "Land the insight: a smoother bot is not the answer. The solution is an operational memory and an honest completion gate.");
  });
}

function slide4(presentation) {
  addSlide(presentation, (slide) => {
    slide.background.fill = "#FFFFFF";
    header(slide, "The product", 4);
    title(slide, "One consented voice request becomes a case with an owner.", "RxRelay coordinates status—not medicine—and keeps every participant aligned on the next verified fact.");
    const steps = [
      { n: "01", h: "Ask once", b: "Patient speaks naturally. RxRelay captures narrow, explicit coordination consent.", tint: C.bluePale, accent: C.blue },
      { n: "02", h: "Coordinate", b: "A policy gate permits only non-clinical status follow-up with the pharmacy or clinic.", tint: C.amberPale, accent: C.amber },
      { n: "03", h: "Prove", b: "The case stays open until the final outcome and patient update are recorded.", tint: C.tealPale, accent: C.teal },
    ];
    steps.forEach((step, index) => {
      const x = 48 + index * 400;
      card(slide, x, 352, 350, 225, { fill: step.tint, line: step.tint });
      text(slide, step.n, x + 23, 375, 65, 22, { size: 17, bold: true, color: step.accent });
      text(slide, step.h, x + 23, 422, 278, 30, { size: 27, bold: true, color: C.ink });
      text(slide, step.b, x + 23, 472, 280, 60, { size: 14, color: C.muted });
      if (index < 2) text(slide, "→", x + 355, 445, 32, 28, { size: 26, color: C.rule, align: "center" });
    });
    footer(slide, "The voice layer earns trust by visibly narrowing its authority.");
    note(slide, "Walk the three verbs slowly. It is intentionally not five product features. The distinctive thing is the proof condition in step three.");
  });
}

function slide5(presentation) {
  addSlide(presentation, (slide) => {
    slide.background.fill = "#FFFFFF";
    header(slide, "Live in 100 seconds", 5);
    title(slide, "A case turns green\nonly when evidence arrives.", "The judged flow is deterministic, visible, and safe to run end to end in a sandbox.", { size: 49, height: 140 });
    const stages = [
      ["00:00", "Consent", "Patient permits a status follow-up."],
      ["00:20", "Pharmacy", "Blocker: prior authorization needed."],
      ["00:45", "Clinic", "Required follow-up is submitted."],
      ["01:10", "Verify", "Pharmacy confirms readiness."],
      ["01:22", "Update", "Consented patient SMS is sent."],
    ];
    rule(slide, 80, 403, 1120, C.rule, 3);
    stages.forEach((stage, index) => {
      const x = 75 + index * 250;
      dot(slide, x, 397, index === 4 ? C.teal : C.ink, 14);
      text(slide, stage[0], x, 333, 100, 20, { size: 11, bold: true, color: C.muted });
      text(slide, stage[1], x, 435, 180, 23, { size: 18, bold: true });
      text(slide, stage[2], x, 468, 180, 42, { size: 12, color: C.muted });
    });
    card(slide, 772, 564, 460, 74, { fill: C.tealPale, line: C.tealPale });
    text(slide, "✓  4/4 proof conditions complete", 798, 587, 380, 25, { size: 18, bold: true, color: C.teal });
    footer(slide, "Every UI action hits the real demo case state machine—no pre-baked animation.");
    note(slide, "Run the dashboard buttons as you narrate this timeline. The visible proof board is the payoff. For the branch that earns trust, take the unsafe voice path and show it stays out of the green state.");
  });
}

function slide6(presentation) {
  addSlide(presentation, (slide) => {
    slide.background.fill = C.pale;
    header(slide, "The proof board", 6);
    title(slide, "The interface is designed to make a false “done” impossible.", "Judges can see the exact difference between activity and resolution.", { size: 44, height: 86 });
    card(slide, 48, 299, 1184, 330, { fill: "#FFFFFF", line: C.rule, shadow: "shadow-md" });
    text(slide, "RX-1048 · Demo prescription-access case", 76, 326, 510, 25, { size: 16, bold: true });
    pill(slide, "RESOLUTION VERIFIED", 1010, 320, 184, C.tealPale, C.teal);
    const lanes = [
      { label: "PATIENT", title: "Consent recorded", tint: C.bluePale, accent: C.blue, copy: "Status update sent" },
      { label: "PHARMACY", title: "Ready for pickup", tint: C.amberPale, accent: C.amber, copy: "Outcome confirmed" },
      { label: "CLINIC / INSURER", title: "PA submitted", tint: C.purplePale, accent: C.purple, copy: "Follow-up recorded" },
    ];
    lanes.forEach((lane, index) => {
      const x = 76 + index * 242;
      card(slide, x, 377, 218, 200, { fill: lane.tint, line: lane.tint });
      text(slide, lane.label, x + 17, 399, 175, 15, { size: 9, bold: true, color: lane.accent });
      text(slide, lane.title, x + 17, 438, 175, 40, { size: 18, bold: true });
      rule(slide, x + 17, 501, 180, "#FFFFFF", 1);
      text(slide, lane.copy, x + 17, 522, 174, 25, { size: 12, color: C.muted });
    });
    card(slide, 843, 377, 351, 200, { fill: C.dark, line: C.dark });
    text(slide, "DETERMINISTIC CLOSE GATE", 867, 400, 275, 16, { size: 9, bold: true, color: "#91A9BC" });
    ["Consent", "Action", "Outcome", "Notification"].forEach((label, index) => {
      const row = index % 2; const col = Math.floor(index / 2); const x = 867 + col * 152; const y = 444 + row * 49;
      rect(slide, x, y, 17, 17, C.teal, { geometry: "ellipse" }); text(slide, "✓", x + 3, y + 2, 11, 12, { size: 9, bold: true, color: "#FFFFFF", align: "center" });
      text(slide, label, x + 24, y + 2, 105, 15, { size: 11, bold: true, color: "#FFFFFF" });
    });
    footer(slide, "The product language is intentionally evidence-centric: record, confirm, notify, prove.");
    note(slide, "This slide is a product screenshot re-created as editable presentation objects. Emphasize that every green check is a deterministic state transition, not an LLM confidence score.");
  });
}

function slide7(presentation) {
  addSlide(presentation, (slide) => {
    slide.background.fill = C.dark;
    header(slide, "Why PAVO", 7, true);
    title(slide, "When the audio gets risky,\nupgrade the whole pipeline.", "A stronger LLM cannot repair a misheard authorization number.", { color: "#FFFFFF", subColor: "#B7C9D9", size: 50, height: 105 });
    const tiers = [
      ["FAST", "Greetings / yes-no", "Fast ASR → compact reasoning", "#274A64", "#D6E3EE"],
      ["BALANCED", "Routine coordination", "Reliable ASR → tools", "#2E6075", "#D6F0F2"],
      ["VERIFIED", "Names · dates · prior auth · noise", "High-accuracy ASR → structured verifier", C.teal, "#FFFFFF"],
      ["SAFE STOP", "Clinical or unsafe request", "No action → safe script → human", "#A04C50", "#FFFFFF"],
    ];
    tiers.forEach((tier, index) => {
      const x = 48 + index * 300;
      card(slide, x, 365, 270, 185, { fill: tier[3], line: tier[3] });
      text(slide, tier[0], x + 19, 390, 220, 18, { size: 11, bold: true, color: tier[4] });
      text(slide, tier[1], x + 19, 427, 225, 42, { size: 17, bold: true, color: "#FFFFFF" });
      rule(slide, x + 19, 486, 220, "#FFFFFF", 1);
      text(slide, tier[2], x + 19, 507, 224, 30, { size: 11, color: "#FFFFFF" });
    });
    text(slide, "DEMAND-CONDITIONED ROUTING  •  CONFIDENCE  •  NOISE  •  CRITICAL ENTITIES  •  ACTION RISK", 48, 607, 1050, 17, { size: 10, bold: true, color: "#8AA4B8" });
    footer(slide, "PAVO-inspired routing keeps fast turns fast—and raises assurance only when needed.", true);
    note(slide, "Explain PAVO in plain language. We do not just route an uncertain turn to a bigger model. We select a safer end-to-end pipeline: transcription, reasoning, structured verification, and a safe stop when the work should remain human.", [
      "https://openreview.net/forum?id=zrneoIxlFx (PAVO: Pipeline-Aware Voice Orchestration with Demand-Conditioned Inference Routing)",
      "https://github.com/vnmoorthy/pavo-bench (benchmark and reference implementation)"
    ]);
  });
}

function node(slide, x, y, w, h, label, copy, tint = "#FFFFFF", accent = C.ink, bodyColor = C.ink) {
  const shape = card(slide, x, y, w, h, { fill: tint, line: tint, name: label });
  text(slide, label.toUpperCase(), x + 15, y + 14, w - 30, 14, { size: 9, bold: true, color: accent });
  text(slide, copy, x + 15, y + 38, w - 30, h - 48, { size: 12, bold: true, color: bodyColor });
  return shape;
}

function slide8(presentation) {
  addSlide(presentation, (slide) => {
    slide.background.fill = "#071829";
    text(slide, "ARCHITECTURE", 48, 28, 220, 16, { size: 10, bold: true, color: "#7CE7D5" });
    text(slide, "RXRELAY  /  08", 1012, 28, 220, 16, { size: 10, bold: true, color: "#8BA1B5", align: "right" });
    text(slide, "A voice agent with a real trust boundary.", 48, 52, 900, 36, { size: 28, bold: true, color: "#FFFFFF" });
    text(slide, "LLM proposes language. Deterministic policy + evidence decide what may happen. Public tunnel never reaches the dashboard.", 48, 90, 1100, 28, { size: 13, color: "#A8BACB" });

    text(slide, "PUBLIC EDGE", 48, 132, 160, 14, { size: 9, bold: true, color: "#7CE7D5" });
    text(slide, "VOICE PROCESS", 280, 132, 160, 14, { size: 9, bold: true, color: "#7CE7D5" });
    text(slide, "SHARED CORE", 520, 132, 160, 14, { size: 9, bold: true, color: "#7CE7D5" });
    text(slide, "DASHBOARD / MCP", 780, 132, 180, 14, { size: 9, bold: true, color: "#7CE7D5" });
    text(slide, "COUNTERPARTS", 1040, 132, 160, 14, { size: 9, bold: true, color: "#7CE7D5" });

    const caller = node(slide, 40, 160, 200, 78, "Caller", "OTP-verified phone\nconsented speech", "#12324A", "#7CE7D5", "#EAF7FF");
    const tunnel = node(slide, 40, 260, 200, 78, "Quick tunnel", "Cloudflare → :3001 only\nnever exposes dashboard", "#12324A", "#7CE7D5", "#EAF7FF");
    const a1 = node(slide, 40, 360, 200, 78, "a1mobile / Telnyx", "TeXML Gather + SpeechResult\nclaim · point · SMS APIs", "#12324A", "#7CE7D5", "#EAF7FF");

    const voice = node(slide, 270, 160, 210, 110, "voice-server.mjs", "/voice · /voice/turn · /health\ntoken-gated TeXML only", "#0E4A44", "#7CE7D5", "#EAF7FF");
    const consent = node(slide, 270, 295, 210, 95, "Consent parse", "explicit phrase + scope\nvague “yes” rejected", "#3A1F24", "#F0A0A0", "#FFE8E8");
    const safe = node(slide, 270, 415, 210, 95, "Safe stop", "clinical / emergency / Rx change\n→ human review, no action", "#3A1F24", "#F0A0A0", "#FFE8E8");

    const pavo = node(slide, 510, 160, 230, 100, "PAVO router", "confidence · noise · entities\nfast / balanced / verified / stop", "#0E4A44", "#7CE7D5", "#EAF7FF");
    const infer = node(slide, 510, 282, 230, 90, "Inference", "a1 Responses gateway\n+ local safe fallback", "#12324A", "#9FB6C9", "#EAF7FF");
    const store = node(slide, 510, 392, 230, 118, "CaseStore + proof gate", "consent ∧ action ∧ outcome ∧ update\npersist → data/cases.json", "#1B3A5C", "#7CE7D5", "#EAF7FF");

    const board = node(slide, 770, 160, 230, 95, "Proof board", "lanes · timeline · 4/4 gate\npublic/ on :3000", "#12324A", "#9FB6C9", "#EAF7FF");
    const mcp = node(slide, 770, 275, 230, 95, "MCP /api", "create · consent · coordinate\noutcome · brief — same gate", "#12324A", "#9FB6C9", "#EAF7FF");
    const tel = node(slide, 770, 390, 230, 120, "telephony.mjs", "sandbox adapter by default\nlive fails closed without\nOTP allowlist + provider id", "#3A2A12", "#E6A037", "#FFF4E0");

    const pharm = node(slide, 1030, 160, 210, 90, "Pharmacy", "status / blocker / ready\nsandbox or live action", "#3A2A12", "#E6A037", "#FFF4E0");
    const clinic = node(slide, 1030, 275, 210, 90, "Clinic / insurer", "PA / follow-up recorded\nas counterpart outcome", "#1B3A5C", "#3D8DFF", "#EAF7FF");
    const sms = node(slide, 1030, 390, 210, 90, "Patient SMS", "only after proof path\nOTP-verified recipient", "#0E4A44", "#7CE7D5", "#EAF7FF");
    const human = node(slide, 1030, 505, 210, 78, "Human owner", "escalation queue\nambiguous / urgent / clinical", "#3A1F24", "#F0A0A0", "#FFE8E8");

    const connector = (a, b, from, to, color = "#38506A") => slide.shapes.connect(a, b, { kind: "elbow", fromSide: from, toSide: to, line: { style: "solid", fill: color, width: 2 }, head: { type: "arrow", width: "sm", length: "sm" } });
    connector(caller, tunnel, "bottom", "top", "#7CE7D5");
    connector(tunnel, voice, "right", "left", "#7CE7D5");
    connector(a1, tunnel, "top", "bottom", "#5F6D80");
    connector(voice, consent, "bottom", "top", "#F0A0A0");
    connector(voice, pavo, "right", "left", "#7CE7D5");
    connector(consent, safe, "bottom", "top", "#F0A0A0");
    connector(pavo, infer, "bottom", "top", "#9FB6C9");
    connector(infer, store, "bottom", "top", "#7CE7D5");
    connector(store, board, "right", "left", "#9FB6C9");
    connector(store, mcp, "right", "left", "#9FB6C9");
    connector(store, tel, "right", "left", "#E6A037");
    connector(tel, pharm, "right", "left", "#E6A037");
    connector(tel, clinic, "right", "left", "#3D8DFF");
    connector(store, sms, "right", "left", "#7CE7D5");
    connector(safe, human, "right", "left", "#F0A0A0");

    text(slide, "Blast radius of a public URL = three TeXML routes. Proof flags are never set by model text. Live outreach requires OTP allowlist.", 48, 620, 1180, 22, { size: 13, bold: true, color: "#D6E8F5" });
    text(slide, "github.com/vnmoorthy/rxrelay  ·  docs/ARCHITECTURE.md  ·  PAVO paper openreview.net/forum?id=zrneoIxlFx", 48, 655, 1100, 18, { size: 11, color: "#8BA1B5" });
    text(slide, "A1MOBILE VOICE AI HACKATHON · 2026", 900, 680, 340, 16, { size: 9, color: "#8BA1B5", align: "right" });
    note(slide, "This is the wow technical slide. Walk left→right: public edge, isolated voice process, shared core, dashboard/MCP, counterparts. Emphasize the red safe-stop path never touches live outreach, and the amber telephony adapter fails closed.", [
      "https://github.com/vnmoorthy/rxrelay",
      "https://openreview.net/forum?id=zrneoIxlFx",
      "https://github.com/vnmoorthy/pavo-bench"
    ]);
  });
}

function slide9(presentation) {
  addSlide(presentation, (slide) => {
    slide.background.fill = C.pale;
    header(slide, "Trust by construction", 9);
    title(slide, "The wow factor is that it knows when not to act.", "RxRelay is aggressively useful inside a narrow boundary—and visibly humble outside it.", { size: 47, height: 92 });
    const allowed = card(slide, 48, 344, 552, 224, { fill: C.tealPale, line: C.tealPale });
    text(slide, "CAN DO", 75, 373, 170, 16, { size: 10, bold: true, color: C.teal });
    ["Record explicit coordination consent", "Check a non-clinical status", "Document counterpart outcomes", "Send a consented patient update"].forEach((value, index) => {
      dot(slide, 77, 418 + index * 31, C.teal, 11); text(slide, value, 99, 414 + index * 31, 430, 20, { size: 14, bold: true });
    });
    const blocked = card(slide, 632, 344, 600, 224, { fill: C.redPale, line: C.redPale });
    text(slide, "WILL NOT DO", 659, 373, 170, 16, { size: 10, bold: true, color: C.red });
    ["Give clinical advice or dosing guidance", "Change / transfer a prescription", "Disclose controlled-medication inventory", "Contact an unconsented recipient"].forEach((value, index) => {
      rect(slide, 660, 418 + index * 31, 11, 11, C.red, { geometry: "ellipse" }); text(slide, "×", 661, 415 + index * 31, 9, 12, { size: 10, bold: true, color: "#FFFFFF", align: "center" });
      text(slide, value, 682, 414 + index * 31, 470, 20, { size: 14, bold: true });
    });
    footer(slide, "A safe stop is a successful outcome when automation would be the wrong thing to do.");
    note(slide, "The team should say this unprompted. It is not a disclaimer slide; it is our product position. The guardrails make the product deployable in a high-stakes setting.");
  });
}

function slide10(presentation) {
  addSlide(presentation, (slide) => {
    slide.background.fill = "#FFFFFF";
    header(slide, "The ask", 10);
    text(slide, "A prescription should not\nfail because coordination did.", 48, 100, 815, 130, { size: 48, bold: true, color: C.ink });
    text(slide, "RxRelay turns a consented call into a verifiable outcome — grounded in PAVO research and the same evidence discipline as Groundtruth, Lifeline, and MCP Observatory.", 52, 255, 760, 55, { size: 16, color: C.muted });
    card(slide, 50, 340, 380, 150, { fill: C.dark, line: C.dark });
    text(slide, "LIVE DEMO", 77, 365, 120, 17, { size: 10, bold: true, color: "#7CE7D5" });
    text(slide, "Proof board + unsafe branch.\nCall the claimed number.", 77, 400, 320, 55, { size: 22, bold: true, color: "#FFFFFF" });
    card(slide, 450, 340, 380, 150, { fill: C.tealPale, line: C.tealPale });
    text(slide, "WHY THIS WINS", 478, 365, 180, 17, { size: 10, bold: true, color: C.teal });
    text(slide, "Real problem. Real voice UX.\nReal safety. It actually runs.", 478, 400, 320, 55, { size: 22, bold: true, color: C.ink });
    card(slide, 850, 340, 382, 150, { fill: C.bluePale, line: C.bluePale });
    text(slide, "TRUSTED LINEAGE", 878, 365, 200, 17, { size: 10, bold: true, color: C.blue });
    text(slide, "PAVO paper · pavo-bench\nGroundtruth · Lifeline · MCPobs", 878, 400, 320, 55, { size: 18, bold: true, color: C.ink });
    text(slide, "github.com/vnmoorthy/rxrelay", 50, 530, 500, 24, { size: 18, bold: true, color: C.blue });
    text(slide, "vnmoorthy.github.io/rxrelay", 50, 560, 500, 22, { size: 16, bold: true, color: C.teal });
    text(slide, "openreview.net/forum?id=zrneoIxlFx  ·  Pitch: deck/output/RxRelay_Hackathon_Pitch.pptx", 50, 600, 900, 18, { size: 12, color: C.muted });
    footer(slide, "RxRelay · Proof, not promises.");
    note(slide, "End on conviction. Invite judges to try the live board and the safety stop. Point to the website and the research lineage so this does not look like a one-weekend toy.", [
      "https://github.com/vnmoorthy/rxrelay",
      "https://vnmoorthy.github.io/rxrelay/",
      "https://openreview.net/forum?id=zrneoIxlFx",
      "https://github.com/vnmoorthy/pavo-bench",
      "https://github.com/vnmoorthy/groundtruth",
      "https://github.com/vnmoorthy/lifeline",
      "https://github.com/vnmoorthy/mcpobservatory"
    ]);
  });
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const presentation = Presentation.create({ slideSize: { width: W, height: H } });
  [slide1, slide2, slide3, slide4, slide5, slide6, slide7, slide8, slide9, slide10].forEach((builder) => builder(presentation));
  for (const [index, slide] of presentation.slides.items.entries()) {
    const stem = `slide-${String(index + 1).padStart(2, "0")}`;
    await writeBlob(`${stem}.png`, await presentation.export({ slide, format: "png", scale: 1 }));
    await fs.writeFile(new URL(`${stem}.layout.json`, OUT), await (await slide.export({ format: "layout" })).text());
  }
  await writeBlob("deck-montage.webp", await presentation.export({ format: "webp", montage: true, scale: 1 }));
  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(fileURLToPath(new URL("RxRelay_Hackathon_Pitch.pptx", OUT)));
  console.log(`Wrote ${presentation.slides.items.length} slides to ${fileURLToPath(OUT)}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
