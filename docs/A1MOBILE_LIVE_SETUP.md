# Live a1mobile setup

This project is safe to demonstrate in its default sandbox mode. The inbound phone implementation uses a **narrow TeXML service**, separate from the dashboard. Do not turn on live SMS or any outbound action until every item below is true.

## 1. Collect team-owned configuration

The team portal must provide the actual a1mobile phone number, current MCP/REST schema, an OpenAI-compatible gateway key, and any callback requirements. Put them in `.env`; never commit them.

```bash
TELEPHONY_PROVIDER=a1mobile
ALLOW_LIVE_TELEPHONY=true
A1MOBILE_API_BASE_URL=https://hack.a1mobile.com
A1MOBILE_TEAM_KEY=team-secret
A1MOBILE_PHONE_NUMBER=+1...
PUBLIC_APP_URL=https://your-public-host.example
A1MOBILE_WEBHOOK_SECRET=long-random-secret
VOICE_WEBHOOK_TOKEN=long-random-unpredictable-token
A1MOBILE_COORDINATION_RECIPIENT=+1... # OTP-verified test number only
LIVE_ALLOWED_RECIPIENTS=+1...
PAVO_OPENAI_BASE_URL=https://gateway.example/openai/v1
PAVO_OPENAI_API_KEY=a1hk_...
PAVO_FAST_MODEL=openai.gpt-5.6-terra
PAVO_STRONG_MODEL=openai.gpt-5.6-terra
```

## 2. OTP-verify every outbound recipient

a1mobile only allows call/text to numbers you have verified:

```bash
npm run verify -- +1XXXXXXXXXX
# check the phone SMS for the code, then:
npm run confirm -- +1XXXXXXXXXX 123456
```

That hits `POST /api/verified-numbers` and `POST /api/verified-numbers/confirm`, then appends the number to `LIVE_ALLOWED_RECIPIENTS` in `.env`. Never cold-outreach.

## 3. Start the isolated voice gateway

```bash
# Dashboard (proof board) on :3000
npm run dev

# Voice-only public path: tunnel + auto point claimed number
npm run live:inbound
```

Or manually:

```bash
npm run voice
```

`live:inbound` binds the TeXML service on `VOICE_PORT` (default 3001), opens a Cloudflare quick tunnel to that process only, and points the claimed number with `POST /api/numbers/point` `{ "webhook_url": "https://…/voice?token=…" }`.

The a1mobile number calls this endpoint as TeXML. RxRelay returns a `<Gather input="speech">` response and receives form-encoded `SpeechResult` callbacks at `/voice/turn`. The endpoint records explicit, scoped consent only when the caller says an unambiguous permission phrase such as “I consent to a pharmacy status follow-up and text updates.”

## 4. Connect the generic event webhook (optional)

Configure the provider to send events to:

```text
POST https://your-public-host.example/api/telephony/a1mobile/events
```

Normalized payload accepted by the adapter:

```json
{
  "eventId": "provider-event-id",
  "type": "call.transcript.final",
  "callId": "provider-call-id",
  "from": "+15550000001",
  "to": "+15550000002",
  "transcript": "I consent to a pharmacy status follow-up and text updates.",
  "asrConfidence": 0.91,
  "noiseLevel": 0.11,
  "occurredAt": "2026-07-31T20:00:00.000Z"
}
```

The server verifies `x-a1mobile-signature` as an HMAC SHA-256 of the raw body when `A1MOBILE_WEBHOOK_SECRET` is configured, and deduplicates event IDs.

## 5. Perform a real consented smoke test

Use only a team member’s OTP-verified test number. Demonstrate: consent → status-request test call → recorded counterpart result → consented text. The live adapter refuses to mark an action successful unless the configured provider returns a provider-issued id. For anything clinical, urgent, ambiguous, or outside the allowed action, show the human handoff instead.

## 6. Assign an escalation owner

The system must have a reachable human coordinator before any live interaction. A human is required for emergency language, medical advice, prescription changes, identity/sensitive-data questions, controlled-inventory questions, contradictions, and timeouts.
