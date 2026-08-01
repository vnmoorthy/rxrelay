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

let publicUrl = null;
let tunnel = null;
let tunnelAttempts = 0;
const MAX_TUNNEL_ATTEMPTS = 5;
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { voice.kill("SIGTERM"); } catch { /* ignore */ }
  try { tunnel?.kill("SIGTERM"); } catch { /* ignore */ }
  setTimeout(() => process.exit(code), 300);
}

function attachTunnelExit(child) {
  child.on("exit", (code) => {
    if (shuttingDown) return;
    if (publicUrl) {
      console.error(`cloudflared exited (${code}) after pointing; shutting down`);
      shutdown(code || 1);
      return;
    }
    scheduleTunnelRetry(code);
  });
}

async function scheduleTunnelRetry(code) {
  if (tunnelAttempts >= MAX_TUNNEL_ATTEMPTS) {
    console.error(`cloudflared failed ${tunnelAttempts} times (last code ${code}). Voice stays local on :${voicePort}.`);
    console.error("Retry later with: npm run live:inbound");
    return;
  }
  const waitMs = Math.min(30_000, 4000 * tunnelAttempts);
  console.error(`cloudflared exited (${code}) before URL; retrying in ${waitMs}ms…`);
  await sleep(waitMs);
  if (shuttingDown || publicUrl) return;
  tunnel = startTunnel();
  attachTunnelExit(tunnel);
}

function startTunnel() {
  tunnelAttempts += 1;
  console.log(`Opening Cloudflare quick tunnel (attempt ${tunnelAttempts}/${MAX_TUNNEL_ATTEMPTS})…`);
  return spawnLogged(cloudflared, ["tunnel", "--url", `http://127.0.0.1:${voicePort}`], {
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
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

voice.on("exit", (code) => {
  console.error(`voice-server exited (${code}); shutting down`);
  shutdown(code || 1);
});

tunnel = startTunnel();
attachTunnelExit(tunnel);

// Keep the supervisor alive while children run.
await new Promise(() => {});
