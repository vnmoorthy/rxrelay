#!/usr/bin/env node
/**
 * Start the isolated voice gateway, open a Cloudflare quick tunnel to it,
 * and point the claimed a1mobile number at /voice?token=…
 *
 * Usage: node --env-file=.env scripts/live-inbound.mjs
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const voicePort = Number(process.env.VOICE_PORT || 3001);
const cloudflared = process.env.CLOUDFLARED_BIN || "/tmp/rxrelay-cloudflared/cloudflared";
const apiBase = (process.env.A1MOBILE_API_BASE_URL || "https://hack.a1mobile.com").replace(/\/$/, "");
const token = process.env.VOICE_WEBHOOK_TOKEN;
const teamKey = process.env.A1MOBILE_TEAM_KEY;

if (!token || !teamKey) {
  console.error("VOICE_WEBHOOK_TOKEN and A1MOBILE_TEAM_KEY are required.");
  process.exit(1);
}

function redact(url) {
  return String(url).replace(token, "[token]");
}

function spawnLogged(command, args, { onLine } = {}) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  const handle = (chunk) => {
    const text = chunk.toString("utf8");
    process.stdout.write(text);
    for (const line of text.split(/\r?\n/)) if (line.trim()) onLine?.(line.trim());
  };
  child.stdout.on("data", handle);
  child.stderr.on("data", handle);
  child.on("exit", (code) => {
    if (code) console.error(`${command} exited with code ${code}`);
  });
  return child;
}

async function point(publicBase) {
  const webhookUrl = `${publicBase.replace(/\/$/, "")}/voice?token=${encodeURIComponent(token)}`;
  const response = await fetch(`${apiBase}/api/numbers/point`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Team-Key": teamKey },
    body: JSON.stringify({ webhook_url: webhookUrl }),
  });
  const payload = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok) throw new Error(`Point failed (${response.status}): ${JSON.stringify(payload)}`);
  console.log(`\nClaimed number pointed to ${redact(payload.pointed_to || webhookUrl)}`);
  console.log(`Call ${payload.phone_number || process.env.A1MOBILE_PHONE_NUMBER} and say:`);
  console.log('  "Please help — I\'ve been stuck at CVS on my metformin."');
  console.log('  then: PA needed → doctor filed it → ready for pickup');
  console.log("Keep the dashboard running separately with: npm run dev");
  console.log("Voice cases appear on the proof board via shared data/cases.json\n");
}

console.log(`Starting voice gateway on 127.0.0.1:${voicePort}…`);
const voice = spawnLogged(process.execPath, ["--env-file-if-exists=.env", "voice-server.mjs"], {});
await sleep(800);

let publicUrl;
const tunnel = spawnLogged(cloudflared, ["tunnel", "--url", `http://127.0.0.1:${voicePort}`], {
  onLine(line) {
    const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match && !publicUrl) {
      publicUrl = match[0];
      point(publicUrl).catch((error) => {
        console.error(error.message);
        shutdown(1);
      });
    }
  },
});

function shutdown(code = 0) {
  voice.kill("SIGTERM");
  tunnel.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
