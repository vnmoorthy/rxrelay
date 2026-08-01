#!/usr/bin/env node
/**
 * Start the isolated voice gateway, open a public tunnel to it,
 * and point the claimed a1mobile number at /voice?token=…
 *
 * Tunnel order when VOICE_TUNNEL=auto (first that yields a public HTTPS URL wins):
 *   1. Cloudflare quick tunnel (CLOUDFLARED_BIN) — may 429 under load
 *   2. ngrok http (if `ngrok` on PATH)
 *   3. localtunnel via `npx localtunnel --port …`
 *   4. Serveo SSH reverse tunnel (ssh → serveo.net) — no account
 *   5. Optional: TUNNEL_PUBLIC_URL already set → skip tunnel, just point
 *
 * Voice stays up across tunnel retries. Only exits voice when the supervisor
 * shuts down, or when a tunnel that successfully pointed later dies
 * (set VOICE_KEEP_ON_TUNNEL_EXIT=1 to keep voice anyway).
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
const prefer = String(process.env.VOICE_TUNNEL || "auto").toLowerCase(); // auto | cloudflare | ngrok | localtunnel | serveo | none
const keepVoiceOnTunnelExit = /^(1|true|yes)$/i.test(String(process.env.VOICE_KEEP_ON_TUNNEL_EXIT || ""));

if (!token || !teamKey) {
  console.error("VOICE_WEBHOOK_TOKEN and A1MOBILE_TEAM_KEY are required.");
  process.exit(1);
}

function redact(url) {
  return String(url).replaceAll(token, "[token]");
}

function spawnLogged(command, args, { onLine, env } = {}) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: env || process.env });
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
  console.log("  then: PA needed → doctor filed it → ready for pickup");
  console.log("Dashboard (skip npm run dev if already healthy on :3000): http://127.0.0.1:3000");
  console.log("Voice cases appear on the proof board via shared data/cases.json\n");
}

async function waitHealthy(timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${voicePort}/health`);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  return false;
}

console.log(`Starting voice gateway on 127.0.0.1:${voicePort}…`);
const voice = spawnLogged(process.execPath, ["--env-file-if-exists=.env", "voice-server.mjs"], {});
if (!(await waitHealthy())) {
  console.error("voice-server did not become healthy on /health");
  process.exit(1);
}

let publicUrl = process.env.TUNNEL_PUBLIC_URL?.replace(/\/$/, "") || null;
let tunnel = null;
let shuttingDown = false;
let rateLimited = false;
const children = [];

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { voice.kill("SIGTERM"); } catch { /* ignore */ }
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }
  setTimeout(() => process.exit(code), 300);
}

function track(child, { fatalAfterPoint = true } = {}) {
  children.push(child);
  child.on("exit", (code) => {
    if (shuttingDown || !publicUrl) return;
    if (!fatalAfterPoint || keepVoiceOnTunnelExit) {
      console.error(`tunnel process exited (${code}) after pointing; voice kept running (VOICE_KEEP_ON_TUNNEL_EXIT)`);
      return;
    }
    console.error(`tunnel process exited (${code}) after pointing; shutting down`);
    shutdown(code || 1);
  });
  return child;
}

function extractUrl(line) {
  const match = line.match(
    /https:\/\/[a-z0-9.-]+\.(?:trycloudflare\.com|serveousercontent\.com|serveo\.net|ngrok-free\.app|ngrok\.io|loca\.lt)[^\s"'<>]*/i,
  );
  return match?.[0]?.replace(/\/$/, "") || null;
}

function startCloudflare() {
  console.log("Opening Cloudflare quick tunnel…");
  return track(
    spawnLogged(cloudflared, ["tunnel", "--url", `http://127.0.0.1:${voicePort}`], {
      onLine(line) {
        if (/429|1015|Too Many Requests/i.test(line)) {
          rateLimited = true;
          console.error("Cloudflare quick tunnel rate-limited (429/1015). Falling back…");
        }
        const url = extractUrl(line);
        if (url && !publicUrl) onPublicUrl(url);
      },
    }),
  );
}

function startNgrok() {
  console.log("Opening ngrok tunnel…");
  return track(
    spawnLogged("ngrok", ["http", String(voicePort), "--log=stdout", "--log-format=logfmt"], {
      onLine(line) {
        // url=https://….ngrok-free.app or classic extract
        const fromKv = line.match(/\burl=(https:\/\/[a-z0-9.-]+\.ngrok(?:-free)?\.app)\b/i)?.[1];
        const url = fromKv || extractUrl(line);
        if (url && !publicUrl) onPublicUrl(url.replace(/\/$/, ""));
        if (/ERR_NGROK_4018|authtoken|authentication failed/i.test(line)) {
          console.error("ngrok needs an authtoken (ngrok config add-authtoken …). Falling back…");
        }
      },
    }),
  );
}

function startLocaltunnel() {
  console.log("Opening localtunnel (npx)…");
  return track(
    spawnLogged("npx", ["--yes", "localtunnel", "--port", String(voicePort)], {
      onLine(line) {
        // "your url is: https://….loca.lt"
        const fromMsg = line.match(/your url is:\s*(https:\/\/\S+)/i)?.[1];
        const url = fromMsg || extractUrl(line);
        if (url && !publicUrl) onPublicUrl(url.replace(/\/$/, ""));
      },
    }),
  );
}

function startServeo() {
  console.log("Opening Serveo SSH reverse tunnel…");
  return track(
    spawnLogged(
      "ssh",
      [
        "-o", "StrictHostKeyChecking=no",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=30",
        "-R", `80:127.0.0.1:${voicePort}`,
        "serveo.net",
      ],
      {
        onLine(line) {
          const url = extractUrl(line) || (line.match(/Forwarding HTTP traffic from (https:\/\/\S+)/i)?.[1] ?? null);
          if (url && !publicUrl) onPublicUrl(url.replace(/\/$/, ""));
        },
      },
    ),
  );
}

function onPublicUrl(url) {
  if (publicUrl) return;
  publicUrl = url;
  console.log(`Public tunnel: ${publicUrl}`);
  point(publicUrl).catch((error) => {
    console.error(error.message);
    shutdown(1);
  });
}

function killTunnelQuiet() {
  try { tunnel?.kill("SIGTERM"); } catch { /* ignore */ }
  tunnel = null;
}

async function waitForUrlOrExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!publicUrl && Date.now() < deadline) {
    await sleep(400);
    if (rateLimited) return "rate_limited";
    if (child?.exitCode != null) return "exited";
  }
  return publicUrl ? "ok" : "timeout";
}

async function tryProvider(name, startFn, timeoutMs) {
  if (publicUrl) return true;
  rateLimited = false;
  console.log(`\n→ Trying tunnel provider: ${name}`);
  tunnel = startFn();
  const result = await waitForUrlOrExit(tunnel, timeoutMs);
  if (publicUrl) return true;
  console.error(`${name} did not yield a URL (${result}).`);
  killTunnelQuiet();
  await sleep(500);
  return false;
}

async function openTunnel() {
  if (publicUrl) {
    console.log(`Using TUNNEL_PUBLIC_URL=${publicUrl}`);
    await point(publicUrl);
    return;
  }
  if (prefer === "none") {
    console.error("VOICE_TUNNEL=none and no TUNNEL_PUBLIC_URL — voice stays local.");
    return;
  }

  const providers = {
    cloudflare: () => tryProvider("cloudflare", startCloudflare, prefer === "cloudflare" ? 45_000 : 10_000),
    ngrok: () => tryProvider("ngrok", startNgrok, 12_000),
    localtunnel: () => tryProvider("localtunnel", startLocaltunnel, 20_000),
    serveo: () => tryProvider("serveo", startServeo, 15_000),
  };

  if (prefer !== "auto" && providers[prefer]) {
    const ok = await providers[prefer]();
    if (!ok) {
      console.error(`VOICE_TUNNEL=${prefer} failed. Voice is still running on :${voicePort}.`);
      console.error("Point manually once you have a public URL:");
      console.error(`  npm run point -- https://YOUR-TUNNEL`);
    }
    return;
  }

  // auto: CF → ngrok → localtunnel → Serveo; voice stays up the whole time
  for (const name of ["cloudflare", "ngrok", "localtunnel", "serveo"]) {
    if (await providers[name]()) return;
  }

  console.error("\nAll tunnel providers failed. Voice gateway is STILL running on");
  console.error(`  http://127.0.0.1:${voicePort}/health`);
  console.error("Start a tunnel yourself, then:");
  console.error(`  npm run point -- https://YOUR-PUBLIC-HTTPS-BASE`);
  console.error("Options:");
  console.error(`  npx --yes localtunnel --port ${voicePort}`);
  console.error(`  ngrok http ${voicePort}`);
  console.error(`  ssh -R 80:127.0.0.1:${voicePort} serveo.net`);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

voice.on("exit", (code) => {
  console.error(`voice-server exited (${code}); shutting down`);
  shutdown(code || 1);
});

await openTunnel();

// Keep the supervisor alive while children run (voice + optional tunnel).
await new Promise(() => {});
