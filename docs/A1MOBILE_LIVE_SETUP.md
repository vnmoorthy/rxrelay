# Live a1mobile setup

This project is safe to demonstrate in its default sandbox mode. Do not turn on live telephony until all items below are true.

## 1. Collect team-owned configuration

The team portal must provide the actual a1mobile phone number, current MCP/REST schema, an OpenAI-compatible gateway key, and any callback requirements. Put them in `.env`; never commit them.

```bash
TELEPHONY_PROVIDER=a1mobile
ALLOW_LIVE_TELEPHONY=true
A1MOBILE_API_BASE_URL=https://provider.example
A1MOBILE_API_KEY=team-secret
A1MOBILE_PHONE_NUMBER=+1...
PUBLIC_APP_URL=https://your-public-host.example
A1MOBILE_WEBHOOK_SECRET=long-random-secret
PAVO_OPENAI_BASE_URL=https://gateway.example
PAVO_OPENAI_API_KEY=team-secret
PAVO_FAST_MODEL=...
PAVO_STRONG_MODEL=...
DEMO_ALLOWED_RECIPIENTS=+1...,+1...
```

## 2. Use only consented test numbers

Before a call or text, verify the recipient with the event’s OTP flow and record explicit permission for the narrow action. RxRelay rejects nonconsensual coordination and non-allowlisted recipients.

## 3. Connect the webhook

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

## 4. Perform a real consented smoke test

Use only a team member’s OTP-verified test number. Demonstrate: consent → pharmacy status request → recorded counterpart result → consented text. For anything clinical, urgent, ambiguous, or outside the allowed action, show the human handoff instead.

## 5. Assign an escalation owner

The system must have a reachable human coordinator before any live interaction. A human is required for emergency language, medical advice, prescription changes, identity/sensitive-data questions, controlled-inventory questions, contradictions, and timeouts.
