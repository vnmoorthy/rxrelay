# Contributing to RxRelay

Thanks for helping keep medication-access coordination honest.

## Ground rules

Two invariants matter more than style:

1. **No code path may set an evidence flag from model output.**  
   `consentRecorded`, `permittedActionCompleted`, `counterpartOutcomeRecorded`, and `patientNotificationSent` are set only by deterministic state transitions.
2. **No outreach without recorded, scope-limited consent.**  
   Live recipients must be OTP-verified and present in `LIVE_ALLOWED_RECIPIENTS`.

If a change violates either rule, it will be rejected.

## Setup

```bash
git clone https://github.com/vnmoorthy/rxrelay.git
cd rxrelay
cp .env.example .env
npm test
npm run check
npm run dev
```

No `npm install` step — Node 20+ is enough for the sandbox.

## Pull requests

1. Keep diffs focused.
2. Add or update a test in `test/rxrelay.test.mjs` for any proof-gate / consent / routing change.
3. Run:

```bash
npm run check
npm test
```

4. Never commit `.env`, `data/`, credentials, phone numbers, or tunnel tokens.

## What we especially want

- Stronger TeXML edge-case coverage
- Better redaction / expiry for shared case persistence
- Clearer PAVO routing tests for critical-entity turns
- Docs and demo polish that help judges and operators understand the proof gate in under a minute
