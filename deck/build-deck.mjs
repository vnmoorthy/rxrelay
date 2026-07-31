#!/usr/bin/env node
/**
 * RxRelay pitch deck — pure Node.js PPTX generator (no external deps).
 * Also documents deck/pitch.html for fullscreen HTML presentation.
 */
import fs from "node:fs/promises";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const OUT_DIR = fileURLToPath(new URL("./output/", import.meta.url));
const OUT_FILE = `${OUT_DIR}/RxRelay_Hackathon_Pitch.pptx`;

/** Slide size: standard 16:9 widescreen (EMUs) */
const W = 9144000;
const H = 5143500;
const M = 457200; // 0.5"

const C = {
  ink: "04131F",
  ink2: "0B2436",
  muted: "8EA0AE",
  teal: "0F9F8C",
  tealBright: "39D6C0",
  paper: "F4F7F9",
  white: "FFFFFF",
  red: "C24B45",
  amber: "D8892A",
};

/** @type {Array<{kicker:string,num:number,title:string,body:string[],footer:string,notes:string,dark?:boolean,bullets?:string[]}>} */
const SLIDES = [
  {
    kicker: "a1mobile Voice AI Hackathon 2026",
    num: 1,
    title: "RxRelay",
    body: ["Proof, not promises.", "A consent-first voice coordinator for prescription access — refuses resolution without evidence."],
    footer: "Make the calls. Bring the proof.",
    notes: "Open with the outcome, not 'an AI agent.' One consented request, followed until evidence exists. Pause on 'Proof, not promises.'",
    dark: true,
    bullets: ["PAVO routing", "Evidence-gated", "Consent-first"],
  },
  {
    kicker: "The human cost",
    num: 2,
    title: "The patient becomes the switchboard.",
    body: ["When a prescription stalls, the person who needs it repeats the same story across pharmacy, clinic, and insurer."],
    bullets: [
      "Pharmacy: \"We need a prior authorization.\"",
      "Clinic: \"We sent it — call your insurer.\"",
      "Insurer: \"Ask the pharmacy for the status.\"",
      "The patient: calling again — no shared state, no owner.",
    ],
    footer: "Authorization friction turns patients into unpaid coordinators.",
    notes: "Community voices make the burden concrete — people call 10, even 20 pharmacies because coordination failed, not because they wanted an agent.",
    dark: false,
  },
  {
    kicker: "The missing layer",
    num: 3,
    title: "LLMs narrate completion. Access problems need evidence.",
    body: ["Today: call → hold → repeat → hope. No proof the next actor acted.", "With RxRelay: consent → coordinate → verify. One case owns the handoffs."],
    footer: "From conversational agent to accountable coordination system.",
    notes: "Land the insight: a smoother bot is not the answer. Operational memory plus an honest completion gate.",
    dark: true,
  },
  {
    kicker: "The product",
    num: 4,
    title: "A consent-first voice coordinator.",
    body: ["One consented voice request becomes a case with an owner — coordinating status, not medicine."],
    bullets: ["01 Ask once — narrow, explicit coordination consent", "02 Coordinate — non-clinical status follow-up only", "03 Prove — case open until outcome + patient update"],
    footer: "The voice layer earns trust by visibly narrowing its authority.",
    notes: "Walk three verbs slowly. The distinctive thing is the proof condition in step three.",
    dark: false,
  },
  {
    kicker: "Resolution gate",
    num: 5,
    title: "A case turns green only when all four proofs arrive.",
    body: ["Deterministic close gate — activity is not resolution."],
    bullets: ["consent ∧ permitted action ∧ counterpart outcome ∧ patient update", "00:00 Consent · 00:20 Pharmacy blocker · 00:45 Clinic · 01:10 Verify · 01:22 Patient SMS"],
    footer: "No evidence missing. Case can turn green.",
    notes: "Every green check is a deterministic state transition, not an LLM confidence score. Run the dashboard live.",
    dark: true,
  },
  {
    kicker: "PAVO routing",
    num: 6,
    title: "The coupling cliff: joint ASR, capture, and reasoning.",
    body: ["A stronger LLM cannot repair a misheard authorization number."],
    bullets: [
      "FAST — greetings / yes-no · compact reasoning",
      "BALANCED — routine coordination · reliable speech → tools",
      "VERIFIED — names, dates, prior auth · TeXML speech + DTMF, strong model (not multi-vendor ASR theater)",
      "SAFE STOP — clinical / unsafe → human queue, no action",
    ],
    footer: "Demand-conditioned routing · confidence · noise · critical entities · action risk",
    notes: "Be honest: verified tier uses TeXML speech + DTMF and a strong model. The coupling cliff is real — joint capture and reasoning matter.",
    dark: true,
  },
  {
    kicker: "Live surfaces",
    num: 7,
    title: "Every stakeholder sees the same evidence.",
    bullets: [
      "Proof board — lanes, timeline, 4/4 gate",
      "Counterpart portal — structured pharmacy / clinic outcomes",
      "Signed receipts — audit trail for consent and action",
      "Human ops queue — escalation for ambiguous / clinical",
      "SSE stream — live case updates, no pre-baked animation",
    ],
    footer: "UI actions hit the real demo state machine.",
    notes: "Walk each surface: proof board, counterpart portal, signed receipts, human queue, SSE.",
    dark: false,
  },
  {
    kicker: "Architecture",
    num: 8,
    title: "Voice-server blast radius. Dashboard stays local.",
    body: ["LLM proposes language. Policy + evidence decide what may happen. Public tunnel never reaches dashboard."],
    bullets: [
      "Public edge: OTP caller · Cloudflare → :3001 · a1mobile TeXML",
      "Voice process: voice-server.mjs · consent parse · safe stop",
      "Core: PAVO router · inference · CaseStore proof gate",
      "Dashboard local :3000 · MCP/API · telephony sandbox default",
      "Proof flags never set by model text alone",
    ],
    footer: "Blast radius of public URL = three TeXML routes.",
    notes: "Walk left→right. Red safe-stop path never touches live outreach. Live requires OTP allowlist.",
    dark: true,
  },
  {
    kicker: "Trust by construction",
    num: 9,
    title: "What we refuse.",
    body: ["Aggressively useful inside a narrow boundary — visibly humble outside it."],
    bullets: [
      "CAN: record consent · check status · document outcomes · send consented updates",
      "WILL NOT: clinical advice · Rx changes · controlled inventory · unconsented contact",
    ],
    footer: "The wow factor is knowing when not to act.",
    notes: "Product position, not disclaimer. A safe stop is success when automation would be wrong.",
    dark: false,
  },
  {
    kicker: "Demo path",
    num: 10,
    title: "Sandbox E2E + live call flow.",
    bullets: [
      "Dashboard: npm run dev → proof board → counterpart actions → 4/4 gate → SSE",
      "Voice: npm run voice → tunnel :3001 → TeXML → consent → PAVO → case transitions",
      "Safe branch → green · unsafe branch → human queue · call the claimed number",
    ],
    footer: "Judged flow is deterministic, visible, and safe end-to-end.",
    notes: "Offer live path: reset sandbox, walk full flow, call demo line, show unsafe branch stays red.",
    dark: true,
  },
  {
    kicker: "Company opportunity",
    num: 11,
    title: "A real company wedge: medication-access coordination.",
    body: [
      "TAM: AI voice agents in healthcare ~$0.5–2.1B (2025; definition-dependent).",
      "Pain pool / SAM signal: ~$93B navigating utilization management (Health Affairs); CAQH ~$89B admin transactions.",
      "SOM beachhead: specialty pharmacies, patient hubs, digital pharmacies — priced per resolved case, not per chat.",
    ],
    bullets: [
      "Charge for resolved access cases — not words spoken",
      "Wedge: evidence-gated coordination where PA / status loops already burn staff",
      "Sources: Towards Healthcare · Healthcare Foresights · Health Affairs · CAQH Index 2023 (directional)",
    ],
    footer: "Own the proof-gated access workflow.",
    notes: "Company slide: do not claim we capture $93B. TAM is voice AI in healthcare; $93B is the pain pool that justifies budget. Beachhead is specialty access desks that already buy telephony.",
    dark: true,
  },
  {
    kicker: "Why invest / Catalyst fit",
    num: 12,
    title: "Evidence culture. Load-bearing network. Open research.",
    bullets: [
      "Evidence culture — proof gates, signed receipts, Groundtruth / MCP Observatory discipline",
      "a1 network — TeXML voice, OTP SMS, number verify — real telco primitives",
      "Open research PAVO — paper + pavo-bench benchmark alongside product",
    ],
    footer: "Real problem · real voice UX · real safety · it actually runs.",
    notes: "Catalyst fit: evidence over demo theater, a1 as load-bearing infra, open PAVO research lineage.",
    dark: false,
  },
  {
    kicker: "Ask",
    num: 13,
    title: "A prescription should not fail because coordination did.",
    body: ["RxRelay turns a consented call into a verifiable outcome."],
    bullets: [
      "github.com/vnmoorthy/rxrelay",
      "openreview.net/forum?id=zrneoIxlFx · PAVO paper",
      "Next: live OTP SMS + production tunnel · beachhead = specialty access",
    ],
    footer: "RxRelay · Proof, not promises.",
    notes: "End on conviction. Invite judges to live board and safety stop. Next: OTP SMS + production tunnel + specialty access pilots.",
    dark: true,
  },
];

// ── CRC32 ──────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── ZIP writer (store method 0 + deflate method 8) ─────────────────────────
class ZipWriter {
  /** @type {{name:string,data:Buffer}[]} */
  #files = [];

  add(name, data) {
    this.#files.push({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8") });
  }

  toBuffer() {
    const locals = [];
    const central = [];
    let offset = 0;

    for (const { name, data } of this.#files) {
      const nameBuf = Buffer.from(name, "utf8");
      const compressed = zlib.deflateRawSync(data, { level: 9 });
      const checksum = crc32(data);
      const local = Buffer.alloc(30 + nameBuf.length + compressed.length);
      let p = 0;
      local.writeUInt32LE(0x04034b50, p); p += 4;
      local.writeUInt16LE(20, p); p += 2;
      local.writeUInt16LE(0x0800, p); p += 2; // UTF-8 flag
      local.writeUInt16LE(8, p); p += 2; // deflate
      local.writeUInt16LE(0, p); p += 2;
      local.writeUInt16LE(0, p); p += 2;
      local.writeUInt32LE(checksum, p); p += 4;
      local.writeUInt32LE(compressed.length, p); p += 4;
      local.writeUInt32LE(data.length, p); p += 4;
      local.writeUInt16LE(nameBuf.length, p); p += 2;
      local.writeUInt16LE(0, p); p += 2;
      nameBuf.copy(local, p); p += nameBuf.length;
      compressed.copy(local, p);
      locals.push(local);

      const cen = Buffer.alloc(46 + nameBuf.length);
      p = 0;
      cen.writeUInt32LE(0x02014b50, p); p += 4;
      cen.writeUInt16LE(20, p); p += 2;
      cen.writeUInt16LE(20, p); p += 2;
      cen.writeUInt16LE(0x0800, p); p += 2;
      cen.writeUInt16LE(8, p); p += 2;
      cen.writeUInt16LE(0, p); p += 2;
      cen.writeUInt16LE(0, p); p += 2;
      cen.writeUInt32LE(checksum, p); p += 4;
      cen.writeUInt32LE(compressed.length, p); p += 4;
      cen.writeUInt32LE(data.length, p); p += 4;
      cen.writeUInt16LE(nameBuf.length, p); p += 2;
      cen.writeUInt16LE(0, p); p += 2;
      cen.writeUInt16LE(0, p); p += 2;
      cen.writeUInt16LE(0, p); p += 2;
      cen.writeUInt16LE(0, p); p += 2;
      cen.writeUInt32LE(0, p); p += 4;
      cen.writeUInt32LE(offset, p); p += 4;
      nameBuf.copy(cen, p);
      central.push(cen);
      offset += local.length;
    }

    const centralSize = central.reduce((s, b) => s + b.length, 0);
    const centralStart = offset;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.#files.length, 8);
    end.writeUInt16LE(this.#files.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...locals, ...central, end]);
  }
}

// ── OOXML helpers ──────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function solidFill(hex) {
  return `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;
}

/** @param {{text:string,size?:number,bold?:boolean,color?:string,italic?:boolean}[]} runs */
function paragraph(runs, align = "l") {
  const algn = { l: "l", r: "r", ctr: "ctr", left: "l", right: "r", center: "ctr" }[align] || "l";
  const rs = runs
    .map((r) => {
      const sz = r.size ?? 1600;
      const attrs = [
        `lang="en-US"`,
        `sz="${sz}"`,
        r.bold ? `b="1"` : "",
        r.italic ? `i="1"` : "",
      ]
        .filter(Boolean)
        .join(" ");
      const fill = r.color ? `<a:solidFill><a:srgbClr val="${r.color}"/></a:solidFill>` : "";
      return `<a:r><a:rPr ${attrs}>${fill}<a:latin typeface="Calibri"/></a:rPr><a:t>${esc(r.text)}</a:t></a:r>`;
    })
    .join("");
  return `<a:p><a:pPr algn="${algn}"/>${rs}</a:p>`;
}

function textBody(paragraphs) {
  return `<p:txBody><a:bodyPr wrap="square" rtlCol="0"/><a:lstStyle/>${paragraphs.join("")}</p:txBody>`;
}

function shape(id, name, x, y, cx, cy, paragraphs, { fill = "none", line = "none" } = {}) {
  const spPr =
    fill === "none"
      ? `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>`
      : `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${solidFill(fill)}<a:ln><a:solidFill><a:srgbClr val="${line}"/></a:solidFill></a:ln></p:spPr>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>${spPr}${textBody(paragraphs)}</p:sp>`;
}

function slideBackground(dark) {
  const color = dark ? C.ink : C.paper;
  return `<p:bg><p:bgPr>${solidFill(color)}<a:effectLst/></p:bgPr></p:bg>`;
}

function buildSlideXml(slide, slideNum) {
  const dark = slide.dark !== false;
  const fg = dark ? C.white : C.ink;
  const muted = dark ? C.muted : "5C6B78";
  const accent = C.tealBright;
  let id = 2;
  const shapes = [];

  shapes.push(
    shape(
      id++,
      "Kicker",
      M,
      180000,
      W - 2 * M,
      220000,
      [paragraph([{ text: slide.kicker.toUpperCase(), size: 900, bold: true, color: accent }])],
    ),
  );

  shapes.push(
    shape(
      id++,
      "SlideNum",
      W - M - 1200000,
      180000,
      1200000,
      220000,
      [paragraph([{ text: `RXRELAY  /  ${String(slide.num).padStart(2, "0")}`, size: 900, bold: true, color: muted }], "r")],
    ),
  );

  shapes.push(
    shape(
      id++,
      "Title",
      M,
      520000,
      W - 2 * M,
      900000,
      [paragraph([{ text: slide.title, size: slide.num === 1 ? 5200 : 3600, bold: true, color: fg }])],
    ),
  );

  let y = 1500000;
  for (const line of slide.body ?? []) {
    shapes.push(
      shape(id++, "Body", M, y, W - 2 * M, 360000, [
        paragraph([{ text: line, size: 1800, color: slide.num === 1 && line.startsWith("Proof") ? accent : muted, italic: line.startsWith("Proof") }]),
      ]),
    );
    y += 380000;
  }

  for (const bullet of slide.bullets ?? []) {
    shapes.push(
      shape(id++, "Bullet", M + 80000, y, W - 2 * M - 80000, 320000, [
        paragraph([{ text: `• ${bullet}`, size: 1500, color: fg }]),
      ]),
    );
    y += 340000;
  }

  shapes.push(
    shape(
      id++,
      "Footer",
      M,
      H - 420000,
      W - 2 * M,
      260000,
      [paragraph([{ text: slide.footer, size: 900, color: muted }])],
    ),
  );

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  ${slideBackground(dark)}
  <p:cSld name="Slide ${slideNum}">
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${W}" cy="${H}"/><a:chOff x="0" y="0"/><a:chExt cx="${W}" cy="${H}"/></a:xfrm></p:grpSpPr>
      ${shapes.join("\n      ")}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function buildNotesXml(slide) {
  const paras = slide.notes.split(/\n+/).map((t) => paragraph([{ text: t, size: 1400, color: C.ink }]));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
         xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
         xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6858000" cy="9144000"/><a:chOff x="0" y="0"/><a:chExt cx="6858000" cy="9144000"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="5943600" cy="8229600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
        ${textBody(paras)}
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:notes>`;
}

function rel(id, type, target) {
  return `<Relationship Id="rId${id}" Type="${type}" Target="${target}"/>`;
}

function buildPptx() {
  const zip = new ZipWriter();
  const slideCount = SLIDES.length;

  const contentTypes = [`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>`];

  for (let i = 1; i <= slideCount; i++) {
    contentTypes.push(`  <Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
    contentTypes.push(`  <Override PartName="/ppt/notesSlides/notesSlide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`);
  }
  contentTypes.push("</Types>");

  zip.add("[Content_Types].xml", contentTypes.join("\n"));

  zip.add(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${rel(1, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument", "ppt/presentation.xml")}
  ${rel(2, "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml")}
  ${rel(3, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties", "docProps/app.xml")}
</Relationships>`,
  );

  zip.add(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>RxRelay Hackathon Pitch</dc:title>
  <dc:creator>RxRelay</dc:creator>
  <dc:description>Proof, not promises — consent-first voice coordination</dc:description>
  <cp:lastModifiedBy>build-deck.mjs</cp:lastModifiedBy>
</cp:coreProperties>`,
  );

  zip.add(
    "docProps/app.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>Node.js</Application>
  <Slides>${slideCount}</Slides>
  <PresentationFormat>On-screen Show (16:9)</PresentationFormat>
</Properties>`,
  );

  zip.add(
    "ppt/theme/theme1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="RxRelay">
  <a:themeElements>
    <a:clrScheme name="RxRelay">
      <a:dk1><a:srgbClr val="${C.ink}"/></a:dk1>
      <a:lt1><a:srgbClr val="${C.white}"/></a:lt1>
      <a:dk2><a:srgbClr val="${C.ink2}"/></a:dk2>
      <a:lt2><a:srgbClr val="${C.paper}"/></a:lt2>
      <a:accent1><a:srgbClr val="${C.teal}"/></a:accent1>
      <a:accent2><a:srgbClr val="${C.tealBright}"/></a:accent2>
      <a:accent3><a:srgbClr val="${C.amber}"/></a:accent3>
      <a:accent4><a:srgbClr val="${C.red}"/></a:accent4>
      <a:accent5><a:srgbClr val="2F6FBF"/></a:accent5>
      <a:accent6><a:srgbClr val="${C.muted}"/></a:accent6>
      <a:hlink><a:srgbClr val="${C.tealBright}"/></a:hlink>
      <a:folHlink><a:srgbClr val="${C.teal}"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="RxRelay">
      <a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
      <a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Office">
      <a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
      <a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
      <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
      <a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>`,
  );

  zip.add(
    "ppt/slideMasters/slideMaster1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${W}" cy="${H}"/><a:chOff x="0" y="0"/><a:chExt cx="${W}" cy="${H}"/></a:xfrm></p:grpSpPr>
  </p:spTree></p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`,
  );

  zip.add(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${rel(1, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout", "../slideLayouts/slideLayout1.xml")}
  ${rel(2, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme", "../theme/theme1.xml")}
</Relationships>`,
  );

  zip.add(
    "ppt/slideLayouts/slideLayout1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
  <p:cSld name="Blank"><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${W}" cy="${H}"/><a:chOff x="0" y="0"/><a:chExt cx="${W}" cy="${H}"/></a:xfrm></p:grpSpPr>
  </p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`,
  );

  zip.add(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${rel(1, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster", "../slideMasters/slideMaster1.xml")}
</Relationships>`,
  );

  zip.add(
    "ppt/notesMasters/notesMaster1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notesMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6858000" cy="9144000"/><a:chOff x="0" y="0"/><a:chExt cx="6858000" cy="9144000"/></a:xfrm></p:grpSpPr>
  </p:spTree></p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
</p:notesMaster>`,
  );

  zip.add(
    "ppt/notesMasters/_rels/notesMaster1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${rel(1, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme", "../theme/theme1.xml")}
</Relationships>`,
  );

  for (let i = 0; i < slideCount; i++) {
    const n = i + 1;
    zip.add(`ppt/slides/slide${n}.xml`, buildSlideXml(SLIDES[i], n));
    zip.add(`ppt/notesSlides/notesSlide${n}.xml`, buildNotesXml(SLIDES[i]));
  }

  for (let i = 0; i < slideCount; i++) {
    const n = i + 1;
    zip.add(
      `ppt/slides/_rels/slide${n}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${rel(1, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout", "../slideLayouts/slideLayout1.xml")}
  ${rel(2, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide", "../notesSlides/notesSlide${n}.xml")}
</Relationships>`,
    );
    zip.add(
      `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${rel(1, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster", "../notesMasters/notesMaster1.xml")}
  ${rel(2, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide", "../slides/slide${n}.xml")}
</Relationships>`,
    );
  }

  const slideIdBase = 256;
  const sldIdLst = SLIDES.map((_, i) => `<p:sldId id="${slideIdBase + i}" r:id="rId${i + 1}"/>`).join("");
  const presRels = SLIDES.map((_, i) =>
    rel(i + 1, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide", `slides/slide${i + 1}.xml`),
  ).join("\n  ");
  const masterRelId = slideCount + 1;
  const themeRelId = slideCount + 2;

  zip.add(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId${masterRelId}"/></p:sldMasterIdLst>
  <p:sldIdLst>${sldIdLst}</p:sldIdLst>
  <p:sldSz cx="${W}" cy="${H}" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
  <p:defaultTextStyle>
    <a:defPPr><a:defRPr lang="en-US"/></a:defPPr>
  </p:defaultTextStyle>
</p:presentation>`,
  );

  zip.add(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${presRels}
  ${rel(masterRelId, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster", "slideMasters/slideMaster1.xml")}
  ${rel(themeRelId, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme", "theme/theme1.xml")}
</Relationships>`,
  );

  return zip.toBuffer();
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const buf = buildPptx();
  await fs.writeFile(OUT_FILE, buf);
  const stat = await fs.stat(OUT_FILE);
  console.log(`Wrote ${SLIDES.length} slides → ${OUT_FILE} (${stat.size} bytes)`);
  console.log(`HTML deck: deck/pitch.html (open fullscreen, ← → navigate, N for notes)`);
  if (stat.size < 4096) {
    console.warn("Warning: output file seems unusually small");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
