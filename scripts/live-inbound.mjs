#!/usr/bin/env node
/**
 * Start the isolated voice gateway, open a public tunnel to it,
 * and point the claimed a1mobile number at /voice?token=…
 *
 * Tunnel order when VOICE_TUNNEL=auto (first that verifies wins):
 *   1. Cloudflare quick tunnel (CLOUDFLARED_BIN) — may 429 under load
 *   2. Serveo SSH reverse tunnel (ssh → serveo.net) — no account; works for TeXML
 *   3. ngrok http (if `ngrok` on PATH + authtoken)
 *   4. localtunnel via `npx localtunnel --port …` (browser interstitial often blocks TeXML)
 *   5. Optional: TUNNEL_PUBLIC_URL already set → verify + point
 *
 * Critical: never point the number until POST /voice returns 200 TeXML <Gather>.
 * Voice stays up if the tunnel flaps; Serveo is auto-restarted and re-verified.
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
// Default: keep voice alive when tunnel dies (avoids silent "application error" from dead webhook).
const keepVoiceOnTunnelExit = !/^(0|false|no)$/i.test(String(process.env.VOICE_KEEP_ON_TUNNEL_EXIT ?? "1"));

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
  return webhookUrl;
}

/**
 * Refuse to point until the public path returns valid TeXML.
 * Catches dead Serveo sessions, CF 502s, loca.lt interstitials, wrong tokens.
 */
async function verifyPublic(publicBase, { attempts = 4 } = {}) {
  const base = publicBase.replace(/\/$/, "");
  let lastErr = "unknown";
  for (let i = 0; i < attempts; i++) {
    try {
      const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(12_000) });
      const healthText = await health.text();
      if (!health.ok || !/"ok"\s*:\s*true/.test(healthText)) {
        lastErr = `health ${health.status}`;
        await sleep(800);
        continue;
      }
      const voiceUrl = `${base}/voice?token=${encodeURIComponent(token)}`;
      const res = await fetch(voiceUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          CallSid: `verify-${Date.now()}`,
          From: "+15551112222",
          To: process.env.A1MOBILE_PHONE_NUMBER || "+18026768127",
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const xml = await res.text();
      if (
        res.status === 200
        && xml.includes("<Response>")
        && xml.includes("<Gather")
        && xml.includes("<Say")
      ) {
        console.log(`Tunnel verified: POST /voice → 200 TeXML <Gather> (${redact(base)})`);
        return true;
      }
      lastErr = `voice ${res.status} body=${xml.slice(0, 120).replace(/\s+/g, " ")}`;
    } catch (error) {
      lastErr = error.message || String(error);
    }
    await sleep(900);
  }
  console.error(`Tunnel verify failed for ${base}: ${lastErr}`);
  return false;
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
let pointed = false;
let activeProvider = null;
const children = [];
/** Candidate URL seen from tunnel logs before verification. */
let candidateUrl = null;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { voice.kill("SIGTERM"); } catch { /* ignore */ }
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }
  setTimeout(() => process.exit(code), 300);
}

function track(child, { onExit } = {}) {
  children.push(child);
  child.on("exit", (code) => {
    if (shuttingDown) return;
    onExit?.(code);
  });
  return child;
}

function extractUrl(line) {
  const match = line.match(
    /https:\/\/[a-z0-9.-]+\.(?:trycloudflare\.com|serveousercontent\.com|serveo\.net|ngrok-free\.app|ngrok\.io|loca\.lt)[^\s"'<>]*/i,
  );
  return match?.[0]?.replace(/\/$/, "") || null;
}

function noteCandidate(url) {
  if (!url || publicUrl || candidateUrl) return;
  candidateUrl = url.replace(/\/$/, "");
  console.log(`Candidate tunnel: ${candidateUrl}`);
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
        if (url) noteCandidate(url);
      },
    }),
    { onExit: (code) => onTunnelExit("cloudflare", code) },
  );
}

function startNgrok() {
  console.log("Opening ngrok tunnel…");
  return track(
    spawnLogged("ngrok", ["http", String(voicePort), "--log=stdout", "--log-format=logfmt"], {
      onLine(line) {
        const fromKv = line.match(/\burl=(https:\/\/[a-z0-9.-]+\.ngrok(?:-free)?\.app)\b/i)?.[1];
        const url = fromKv || extractUrl(line);
        if (url) noteCandidate(url);
        if (/ERR_NGROK_4018|authtoken|authentication failed/i.test(line)) {
          console.error("ngrok needs an authtoken (ngrok config add-authtoken …). Falling back…");
        }
      },
    }),
    { onExit: (code) => onTunnelExit("ngrok", code) },
  );
}

function startLocaltunnel() {
  console.log("Opening localtunnel (npx)…");
  return track(
    spawnLogged("npx", ["--yes", "localtunnel", "--port", String(voicePort)], {
      onLine(line) {
        const fromMsg = line.match(/your url is:\s*(https:\/\/\S+)/i)?.[1];
        const url = fromMsg || extractUrl(line);
        if (url) noteCandidate(url);
      },
    }),
    { onExit: (code) => onTunnelExit("localtunnel", code) },
  );
}

function startServeo() {
  console.log("Opening Serveo SSH reverse tunnel…");
  // Do NOT use ssh -N: Serveo only allocates/prints the public HTTPS URL with a session.
  // Force a PTY (-tt) so the session stays allocated when stdin is redirected.
  // ServerAlive* keeps the forward up for carrier TeXML POSTs.
  return track(
    spawnLogged(
      "ssh",
      [
        "-tt",
        "-o", "StrictHostKeyChecking=no",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=6",
        "-R", `80:localhost:${voicePort}`,
        "serveo.net",
      ],
      {
        onLine(line) {
          const url = extractUrl(line) || (line.match(/Forwarding HTTP traffic from (https:\/\/\S+)/i)?.[1] ?? null);
          if (url) noteCandidate(url);
        },
      },
    ),
    { onExit: (code) => onTunnelExit("serveo", code) },
  );
}

function killTunnelQuiet() {
  try { tunnel?.kill("SIGTERM"); } catch { /* ignore */ }
  tunnel = null;
}

async function waitForCandidate(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!candidateUrl && Date.now() < deadline) {
    await sleep(400);
    if (rateLimited) return "rate_limited";
    if (child?.exitCode != null) return "exited";
  }
  return candidateUrl ? "ok" : "timeout";
}

async function acceptCandidate(provider) {
  if (!candidateUrl) return false;
  const url = candidateUrl;
  const ok = await verifyPublic(url);
  if (!ok) {
    candidateUrl = null;
    return false;
  }
  publicUrl = url;
  activeProvider = provider;
  await point(publicUrl);
  pointed = true;
  return true;
}

async function tryProvider(name, startFn, timeoutMs) {
  if (pointed) return true;
  rateLimited = false;
  candidateUrl = null;
  console.log(`\n→ Trying tunnel provider: ${name}`);
  tunnel = startFn();
  const result = await waitForCandidate(tunnel, timeoutMs);
  if (result !== "ok") {
    console.error(`${name} did not yield a URL (${result}).`);
    killTunnelQuiet();
    await sleep(500);
    return false;
  }
  if (await acceptCandidate(name)) return true;
  console.error(`${name} URL failed TeXML verification — not pointing.`);
  killTunnelQuiet();
  await sleep(500);
  return false;
}

let restarting = false;
async function onTunnelExit(provider, code) {
  if (shuttingDown || !pointed) return;
  console.error(`tunnel (${provider}) exited (${code}) after pointing`);
  if (!keepVoiceOnTunnelExit) {
    shutdown(code || 1);
    return;
  }
  console.error("Voice kept running. Attempting tunnel recovery…");
  if (restarting) return;
  restarting = true;
  try {
    publicUrl = null;
    candidateUrl = null;
    pointed = false;
    killTunnelQuiet();
    await sleep(1200);
    const starters = {
      serveo: () => tryProvider("serveo", startServeo, 20_000),
      cloudflare: () => tryProvider("cloudflare", startCloudflare, 20_000),
      ngrok: () => tryProvider("ngrok", startNgrok, 12_000),
      localtunnel: () => tryProvider("localtunnel", startLocaltunnel, 20_000),
    };
    const order = [provider, "serveo", "cloudflare", "ngrok"].filter((v, i, a) => a.indexOf(v) === i);
    for (const name of order) {
      if (starters[name] && (await starters[name]())) {
        console.log("Tunnel recovered and number re-pointed.");
        return;
      }
    }
    console.error("Tunnel recovery failed. Voice still on :" + voicePort + " — fix tunnel then: npm run point -- https://YOUR-URL");
  } finally {
    restarting = false;
  }
}

async function openTunnel() {
  if (publicUrl) {
    console.log(`Using TUNNEL_PUBLIC_URL=${publicUrl}`);
    if (!(await verifyPublic(publicUrl))) {
      console.error("TUNNEL_PUBLIC_URL failed verification — not pointing.");
      publicUrl = null;
    } else {
      await point(publicUrl);
      pointed = true;
      return;
    }
  }
  if (prefer === "none") {
    console.error("VOICE_TUNNEL=none and no TUNNEL_PUBLIC_URL — voice stays local.");
    return;
  }

  const providers = {
    cloudflare: () => tryProvider("cloudflare", startCloudflare, prefer === "cloudflare" ? 45_000 : 10_000),
    ngrok: () => tryProvider("ngrok", startNgrok, 12_000),
    localtunnel: () => tryProvider("localtunnel", startLocaltunnel, 20_000),
    serveo: () => tryProvider("serveo", startServeo, 20_000),
  };

  if (prefer !== "auto" && providers[prefer]) {
    const ok = await providers[prefer]();
    if (!ok) {
      console.error(`VOICE_TUNNEL=${prefer} failed. Voice is still running on :${voicePort}.`);
      console.error("Point manually once you have a verified public URL:");
      console.error(`  npm run point -- https://YOUR-TUNNEL`);
    }
    return;
  }

  // auto: CF → Serveo → ngrok → localtunnel; verify before every point
  for (const name of ["cloudflare", "serveo", "ngrok", "localtunnel"]) {
    if (await providers[name]()) return;
  }

  console.error("\nAll tunnel providers failed. Voice gateway is STILL running on");
  console.error(`  http://127.0.0.1:${voicePort}/health`);
  console.error("Start a tunnel yourself, verify POST /voice returns <Gather>, then:");
  console.error(`  npm run point -- https://YOUR-PUBLIC-HTTPS-BASE`);
  console.error("Options:");
  console.error(`  ssh -R 80:localhost:${voicePort} serveo.net`);
  console.error(`  ngrok http ${voicePort}`);
  console.error(`  npx --yes localtunnel --port ${voicePort}`);
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
