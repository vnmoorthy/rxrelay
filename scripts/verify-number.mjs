#!/usr/bin/env node
/**
 * Request an OTP for a recipient phone via a1mobile.
 * Usage: node --env-file=.env scripts/verify-number.mjs +1XXXXXXXXXX
 */
const phone = process.argv[2];
const teamKey = process.env.A1MOBILE_TEAM_KEY;
const apiBase = (process.env.A1MOBILE_API_BASE_URL || "https://hack.a1mobile.com").replace(/\/$/, "");

if (!phone || !/^\+[1-9]\d{7,14}$/.test(phone)) {
  console.error("Usage: node --env-file=.env scripts/verify-number.mjs +1XXXXXXXXXX");
  process.exit(1);
}
if (!teamKey) {
  console.error("A1MOBILE_TEAM_KEY is required.");
  process.exit(1);
}

const response = await fetch(`${apiBase}/api/verified-numbers`, {
  method: "POST",
  headers: { "content-type": "application/json", "X-Team-Key": teamKey },
  body: JSON.stringify({ phone }),
});
const payload = await response.json().catch(async () => ({ raw: await response.text() }));
if (!response.ok) {
  console.error("OTP request failed:", response.status, payload);
  process.exit(1);
}
console.log("OTP sent to", phone);
console.log("Next: node --env-file=.env scripts/confirm-number.mjs", phone, "<code>");
