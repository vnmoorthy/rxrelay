#!/usr/bin/env node
/**
 * Optional LiveKit + OpenAI Realtime SIP inbound scaffold.
 *
 * This does NOT replace TeXML. Keep `npm run live:inbound` as the demo path.
 * Realtime needs: LiveKit Cloud, a direct OpenAI Realtime key (a1 PAVO gateway
 * is chat/Responses only — no /realtime websocket), and a1 SIP creds from
 * /api/numbers/me after switching the claimed number into SIP mode.
 *
 * Usage: npm run voice:realtime
 */
import { spawn } from "node:child_process";

const required = [
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "OPENAI_API_KEY",
];
const missing = required.filter((key) => !String(process.env[key] || "").trim());

const sipUser = process.env.A1_SIP_USERNAME || process.env.SIP_USERNAME;
const sipPass = process.env.A1_SIP_PASSWORD || process.env.SIP_PASSWORD;
const sipHost = process.env.A1_SIP_HOST || process.env.SIP_HOST || "sip.telnyx.com";

console.log("RxRelay voice:realtime (additive; TeXML stays primary)\n");

if (missing.length) {
  console.error("Missing required env for Realtime SIP path:");
  for (const key of missing) console.error(`  - ${key}`);
  console.error(`
Also needed to answer +1… on a1mobile rails:
  - A1_SIP_USERNAME / A1_SIP_PASSWORD / A1_SIP_HOST (from GET /api/numbers/me)
  - Claimed number switched to SIP mode (portal / docs), then LiveKit inbound trunk
  - Direct OPENAI_API_KEY with Realtime access — hack.a1mobile.com/gw/v1 has NO /realtime
    (probed: 404; models are sol/terra/luna chat only)

Tonight: use TeXML instead:
  npm run live:inbound

Post-hackathon: see README § Optional LiveKit + OpenAI Realtime
`);
  process.exit(2);
}

if (!sipUser || !sipPass) {
  console.error("LIVEKIT + OPENAI keys present, but SIP credentials are missing.");
  console.error("Fetch them (redacted) via: curl -H \"X-Team-Key: $A1MOBILE_TEAM_KEY\" \"$A1MOBILE_API_BASE_URL/api/numbers/me\"");
  console.error("Set A1_SIP_USERNAME, A1_SIP_PASSWORD, A1_SIP_HOST — then configure LiveKit inbound trunk.");
  process.exit(2);
}

console.log("Credentials look present. Next steps (manual / agent worker):");
console.log(`  1. LiveKit inbound trunk → ${sipHost} auth as ${sipUser}`);
console.log("  2. Dispatch rule → agent room");
console.log("  3. Run a LiveKit Agents worker with openai.realtime.RealtimeModel");
console.log("  4. Switch a1 number mode from webhook → SIP (do not drop TeXML until proven)");
console.log("");
console.log("No in-repo Python/Node LiveKit agent worker is bundled yet — this script is a gate.");
console.log("TeXML remains the proven path for the a1mobile claimed number.");

// Optional: if a local worker path is configured, spawn it.
const worker = process.env.LIVEKIT_AGENT_CMD;
if (worker) {
  console.log(`\nSpawning LIVEKIT_AGENT_CMD: ${worker}`);
  const child = spawn(worker, { stdio: "inherit", shell: true, env: process.env });
  child.on("exit", (code) => process.exit(code || 0));
} else {
  console.log("\nSet LIVEKIT_AGENT_CMD to your agent worker start command when ready.");
  process.exit(0);
}
