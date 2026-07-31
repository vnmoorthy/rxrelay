# RxRelay — Cursor continuation handoff

> **Status as of 2026-07-31 (updated):** local product + model gateway + shared case persistence are working. Live inbound TeXML is runnable with `npm run live:inbound` (voice-only Cloudflare quick tunnel + automatic `POST /api/numbers/point`). Outbound live SMS/calls still need OTP-verified recipients and a confirmed call-action endpoint.

## 1. What we are building

**RxRelay** is a consent-first voice coordinator for **prescription-access follow-ups**. It helps a patient stop being the switchboard between a pharmacy, clinic, and insurer. It does *not* give medical advice, prescribe, change prescriptions, determine coverage, or disclose controlled-medication inventory.

The product differentiator is **proof, not promises**. A case can close only when this deterministic gate is true:

```text
explicit consent ∧ permitted action ∧ counterpart outcome ∧ patient update
```

Anything uncertain, clinical, urgent, or outside the authorized action routes to a safe script and human handoff.

## 2. Why PAVO matters

The voice pipeline is informed by the author’s TMLR paper, [PAVO: Pipeline-Aware Voice Orchestration with Demand-Conditioned Inference Routing](https://openreview.net/forum?id=zrneoIxlFx).

Instead of treating every voice turn identically, RxRelay chooses one of four routes:

| Route | When used | Behavior |
| --- | --- | --- |
| Fast | Greeting or simple confirmation | fast ASR → compact reasoning |
| Balanced | Routine coordination | reliable ASR → tool-aware reasoning |
| Verified | Noise, numbers/names/dates, authorization references, contradiction | higher-accuracy ASR → structured verifier |
| Safe stop | Medical advice, emergency, Rx changes, controlled inventory | no autonomous action → human handoff |

Key claim: if the speech is uncertain, both **transcription and reasoning** must upgrade. A stronger language model cannot repair a misheard authorization number.

## 3. Repository map

```text
src/pavo.mjs          PAVO-inspired risk and demand router
src/inference.mjs     OpenAI-compatible Responses client; local safe fallback
src/store.mjs         Consent-gated case state machine and proof gate
src/telephony.mjs     Sandbox adapter + fail-closed a1mobile adapter
server.mjs            Dashboard/API/MCP server (do not expose publicly)
voice-server.mjs      Narrow token-protected TeXML inbound phone server
public/               Proof-board UI and PAVO lab
test/rxrelay.test.mjs Unit/state tests
docs/                 Detailed architecture, setup, and demo script
deck/                 10-slide pitch deck source and rendered PPTX
```

Primary documentation:

- `README.md` — product, demo, architecture diagram, setup.
- `docs/ARCHITECTURE.md` — implementation-level architecture.
- `docs/A1MOBILE_LIVE_SETUP.md` — production safety and a1 setup.
- `docs/DEMO.md` — short judging demo.
- `deck/output/RxRelay_Hackathon_Pitch.pptx` — 10-slide deck.

## 4. Current implementation and verification

### Working now

- Interactive dashboard at `http://localhost:3000` via `npm run dev`.
- Complete sandbox journey: consented case → outbound coordination event → blocker → clinic resolution → counterpart confirmation → consented patient update → deterministic closure.
- Shared local case persistence (`data/cases.json`) so `server.mjs` and `voice-server.mjs` see the same cases. Dashboard case picker prefers voice cases and refreshes.
- MCP endpoint at `POST /mcp`, with `create_rx_case`, `record_consent`, `begin_coordination_call`, `record_external_outcome`, and `get_case_brief`.
- Real OpenAI-compatible a1 gateway confirmed through `PavoInferenceEngine` using the configured `openai.gpt-5.6-terra` model.
- Inbound TeXML speech loop working locally and via temporary Cloudflare quick tunnel:
  - `GET/POST /voice?token=…` creates an inbound case and replies with `<Gather input="speech">`.
  - `GET/POST /voice/turn?token=…` accepts Telnyx form-encoded `SpeechResult`.
  - Explicit scoped consent such as “I consent to a pharmacy status follow-up and text updates” is recorded; vague “yes” is not.
  - The next response is generated through PAVO routing and the configured model gateway.
- Live inbound helper: `npm run live:inbound` starts voice on `VOICE_PORT` (default 3001), opens a quick tunnel, and points the claimed number with `POST https://hack.a1mobile.com/api/numbers/point` `{ webhook_url }`.
- `npm test`: **11 passing, 0 failing**.
- `npm run check`: passing.

### Important correctness choices

- `src/store.mjs` only sets `coordinationStarted` after the telephony adapter returns a successful action. A provider failure cannot falsely satisfy the proof gate.
- `src/telephony.mjs` fails closed in a1 mode: a real provider action must return a 2xx response and provider action id before it is counted as complete.
- Live recipient actions are allowlist-gated. There is no outbound call path without an explicitly configured, confirmed endpoint.
- `voice-server.mjs` is separate from `server.mjs` so a temporary public tunnel never exposes the dashboard, case APIs, or MCP tools.

## 5. Local setup (no credentials committed)

Requirements: Node.js 20+.

```bash
cd "/Users/moorthy/Downloads/Projects/a1mobile voice hac/rxrelay"
cp .env.example .env
npm test
npm run dev
```

Use `npm run voice` for the isolated inbound phone service, **not** `npm run dev`.

All secrets are local-only in `.env` and are ignored by Git. Do not paste, commit, log, or screenshot values for:

- `A1MOBILE_TEAM_KEY`
- `PAVO_OPENAI_API_KEY`
- `VOICE_WEBHOOK_TOKEN`
- any SIP credentials, phone numbers, or recipient numbers

The existing `.env` is populated on this workstation with the hackathon team/model configuration and a strong webhook token. Cursor can use it locally; it must never be pushed.

## 6. a1mobile integration facts

The event supports:

1. Claiming a number with the team key.
2. Pointing it to a public voice webhook.
3. OTP verification before any call/text to a recipient.
4. An OpenAI-compatible **Responses** API gateway.
5. An HTTP MCP server at the event-provided `/mcp/` endpoint.

### Voice protocol (critical)

The claimed number uses **Telnyx TeXML**, not a raw audio WebSocket. a1 points the number at `voice-server.mjs`; RxRelay responds with TeXML `<Gather input="speech">`, and Telnyx posts form-encoded `SpeechResult` to the action URL.

Official references:

- https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/gather
- https://developers.telnyx.com/api-reference/callbacks/texml-gather
- https://developers.telnyx.com/docs/voice/programmable-voice/texml-instruction-fetching

The current event provider supports direct SMS using the team key. It does not document a general REST call-action endpoint, so RxRelay intentionally requires `A1MOBILE_CALL_ACTION_URL` before it marks an outbound coordination call complete. Do **not** weaken that guardrail to create a fake success.

## 7. Remaining steps for a real inbound carrier demo

These are the only steps needed to test a real call from the claimed number.

1. Start the narrow voice server:

   ```bash
   npm run voice
   ```

2. Create an HTTPS public tunnel *only for this process*. It must expose port `3000` while `voice-server.mjs` is running, not the full `server.mjs` dashboard. A Cloudflare Quick Tunnel binary was downloaded locally at `/tmp/rxrelay-cloudflared/cloudflared`.

   ```bash
   /tmp/rxrelay-cloudflared/cloudflared tunnel --url http://127.0.0.1:3000
   ```

3. Point the claimed number to:

   ```text
   https://YOUR-QUICK-TUNNEL.trycloudflare.com/voice?token=YOUR_VOICE_WEBHOOK_TOKEN
   ```

   Use the a1 `POST /api/numbers/point` endpoint with `X-Team-Key`. Keep both values in environment variables or `.env`, not shell history.

4. Call the claimed number from a team member’s phone and say exactly:

   ```text
   I consent to a pharmacy status follow-up and text updates.
   ```

5. Confirm the agent records explicit consent and responds with the PAVO route outcome. The caller can then say a normal follow-up such as “Please check the status of my prescription follow-up.”

6. For any outbound SMS or test coordination action, first complete a1’s OTP verification flow for the recipient. Only then add that recipient to `LIVE_ALLOWED_RECIPIENTS`; no cold outreach and no unverified numbers.

### Public-exposure safety

The temporary tunnel needs the owner’s approval because it creates a public URL. `voice-server.mjs` is intentionally minimized to three routes:

- `/voice` — TeXML start; token required
- `/voice/turn` — TeXML speech callback; token required
- `/health` — non-sensitive readiness status

It exposes no dashboard, MCP server, credentials, case list, or admin APIs. Shut the tunnel down after the demonstration.

## 8. Known gaps / recommended next iteration

1. **Human phone test:** infrastructure is live (tunnel + pointed number). A team member still needs to call the claimed number and speak the consent phrase to prove the carrier path end-to-end.
2. **Counterpart outbound calls:** a1 returns SIP credentials from `/api/numbers/claim`, but there is still no confirmed REST call-action endpoint. Keep the fail-closed adapter; do not invent success.
3. **SMS test:** need an OTP-verified team-member test number (portal flow; no public OTP API discovered) before invoking actual `POST /api/sms`, then set `LIVE_ALLOWED_RECIPIENTS` and `ALLOW_LIVE_TELEPHONY=true`.
4. **GitHub remote:** re-authenticate with `gh auth login`, create/push `vnmoorthy/rxrelay`. Do not use a temporary tunnel URL as the GitHub website field.
5. **Deployment:** durable HTTPS endpoint later; keep voice ingress separate from the dashboard.

## 9. Current git state

Initial local commit:

```text
23e81ee Launch RxRelay consent-first voice coordinator
```

The latest live-a1 hardening is intentionally uncommitted as of this handoff. Review and commit the current changes before pushing:

```bash
git status
git add .env.example README.md docs package.json server.mjs src test voice-server.mjs
git commit -m "Add live a1 TeXML voice gateway"
```

Never include `.env` in that commit.

## 10. Suggested Cursor prompt to resume

```text
Read CURSOR_HANDOFF.md, README.md, docs/A1MOBILE_LIVE_SETUP.md, and the source files it names. Preserve RxRelay's consent-first proof gate and fail-closed telephony semantics. First run npm test and npm run check. Then help me complete the real inbound a1 TeXML test using only an approved temporary voice-only tunnel; do not expose server.mjs publicly, do not use unverified recipients, and do not print or commit .env secrets.
```

