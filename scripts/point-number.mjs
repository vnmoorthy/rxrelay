#!/usr/bin/env node
/**
 * Point the claimed a1mobile number at a public TeXML webhook URL.
 * Usage: node --env-file=.env scripts/point-number.mjs <public-https-base-url>
 */
const base = (process.argv[2] || "").replace(/\/$/, "");
const token = process.env.VOICE_WEBHOOK_TOKEN;
const teamKey = process.env.A1MOBILE_TEAM_KEY;
const apiBase = (process.env.A1MOBILE_API_BASE_URL || "https://hack.a1mobile.com").replace(/\/$/, "");

if (!base.startsWith("https://")) {
  console.error("Provide the public HTTPS base URL, e.g. https://xyz.trycloudflare.com");
  process.exit(1);
}
if (!token || !teamKey) {
  console.error("VOICE_WEBHOOK_TOKEN and A1MOBILE_TEAM_KEY are required in .env");
  process.exit(1);
}

const webhookUrl = `${base}/voice?token=${encodeURIComponent(token)}`;
const response = await fetch(`${apiBase}/api/numbers/point`, {
  method: "POST",
  headers: { "content-type": "application/json", "X-Team-Key": teamKey },
  body: JSON.stringify({ webhook_url: webhookUrl }),
});
const payload = await response.json().catch(async () => ({ raw: await response.text() }));
if (!response.ok) {
  console.error("Point failed:", response.status, payload);
  process.exit(1);
}
console.log("Pointed", payload.phone_number || process.env.A1MOBILE_PHONE_NUMBER, "→", redact(payload.pointed_to || webhookUrl));

function redact(url) {
  return String(url).replaceAll(token, "[token]");
}
