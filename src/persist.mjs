import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = path.join(__dirname, "..", "data", "cases.json");

function emptySnapshot() {
  return { version: 1, cases: {}, callSessions: {}, webhookIds: [], updatedAt: null };
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/**
 * Minimal shared persistence for the hackathon demo.
 * Dashboard and voice gateway can share one JSON file so an inbound call
 * appears on the proof board. PII is limited to what CaseStore already keeps;
 * callers should expire/delete the file after the demo.
 */
export class JsonCasePersistence {
  constructor(filePath = process.env.RXRELAY_STORE_PATH || DEFAULT_PATH) {
    this.filePath = filePath;
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return emptySnapshot();
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return {
        version: 1,
        cases: parsed.cases && typeof parsed.cases === "object" ? parsed.cases : {},
        callSessions: parsed.callSessions && typeof parsed.callSessions === "object" ? parsed.callSessions : {},
        webhookIds: Array.isArray(parsed.webhookIds) ? parsed.webhookIds : [],
        updatedAt: parsed.updatedAt || null,
      };
    } catch {
      return emptySnapshot();
    }
  }

  save({ cases, callSessions, webhookIds }) {
    ensureDir(this.filePath);
    const snapshot = {
      version: 1,
      cases: Object.fromEntries(cases instanceof Map ? cases.entries() : Object.entries(cases || {})),
      callSessions: Object.fromEntries(callSessions instanceof Map ? callSessions.entries() : Object.entries(callSessions || {})),
      webhookIds: [...(webhookIds instanceof Set ? webhookIds : webhookIds || [])].slice(0, 500),
      updatedAt: new Date().toISOString(),
    };
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    fs.renameSync(temp, this.filePath);
  }
}

export function defaultStorePath() {
  return process.env.RXRELAY_STORE_PATH || DEFAULT_PATH;
}
