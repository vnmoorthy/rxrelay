#!/usr/bin/env node
/**
 * Confirm an OTP and append the number to LIVE_ALLOWED_RECIPIENTS in .env.
 * Usage: node --env-file=.env scripts/confirm-number.mjs +1XXXXXXXXXX 123456
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const phone = process.argv[2];
const code = process.argv[3];
const teamKey = process.env.A1MOBILE_TEAM_KEY;
const apiBase = (process.env.A1MOBILE_API_BASE_URL || "https://hack.a1mobile.com").replace(/\/$/, "");
const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");

if (!phone || !code) {
  console.error("Usage: node --env-file=.env scripts/confirm-number.mjs +1XXXXXXXXXX 123456");
  process.exit(1);
}
if (!teamKey) {
  console.error("A1MOBILE_TEAM_KEY is required.");
  process.exit(1);
}

const response = await fetch(`${apiBase}/api/verified-numbers/confirm`, {
  method: "POST",
  headers: { "content-type": "application/json", "X-Team-Key": teamKey },
  body: JSON.stringify({ phone, code }),
});
const payload = await response.json().catch(async () => ({ raw: await response.text() }));
if (!response.ok) {
  console.error("OTP confirm failed:", response.status, payload);
  process.exit(1);
}

let envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const lines = envText.split(/\r?\n/);
let found = false;
const next = lines.map((line) => {
  if (!line.startsWith("LIVE_ALLOWED_RECIPIENTS=")) return line;
  found = true;
  const current = line.slice("LIVE_ALLOWED_RECIPIENTS=".length);
  const list = current.split(",").map((v) => v.trim()).filter(Boolean);
  if (!list.includes(phone)) list.push(phone);
  return `LIVE_ALLOWED_RECIPIENTS=${list.join(",")}`;
});
if (!found) next.push(`LIVE_ALLOWED_RECIPIENTS=${phone}`);
if (!next.some((line) => line.startsWith("A1MOBILE_COORDINATION_RECIPIENT=") && line.split("=")[1])) {
  const idx = next.findIndex((line) => line.startsWith("A1MOBILE_COORDINATION_RECIPIENT="));
  if (idx >= 0) next[idx] = `A1MOBILE_COORDINATION_RECIPIENT=${phone}`;
  else next.push(`A1MOBILE_COORDINATION_RECIPIENT=${phone}`);
}
fs.writeFileSync(envPath, `${next.filter((line, i, arr) => !(line === "" && arr[i - 1] === "")).join("\n").replace(/\n*$/, "\n")}`);
console.log("Verified", phone, "and added to LIVE_ALLOWED_RECIPIENTS.");
console.log("To send a live SMS after enabling ALLOW_LIVE_TELEPHONY=true:");
console.log(`  curl -X POST ${apiBase}/api/sms -H "X-Team-Key: \$A1MOBILE_TEAM_KEY" -H "Content-Type: application/json" -d '{"to":"${phone}","body":"RxRelay status update"}'`);
