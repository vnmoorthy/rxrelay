# Judge demo — 3 minutes (step by step)

Use this exact path. Do **not** demo from the GitHub Pages brochure.

## Before judges walk up (60 seconds)

1. Confirm both services are up:
   - Proof board: open **http://localhost:3000** — you should see RxRelay, sandbox mode, case list.
   - Voice health: terminal running `npm run live:inbound` should say `Claimed number pointed…`
2. Call number ready: **+1 (802) 676-8127**
3. Split screen for judges:
   - Left: **http://localhost:3000** (proof board)
   - Right: optional site/deck only if asked — product is the board + phone

If the board is down:

```bash
cd /tmp/rxrelay-work
npm run dev
```

If the phone path is down:

```bash
cd /tmp/rxrelay-work
npm run live:inbound
```

---

## The 3-minute script

### 0:00–0:20 — Promise (no clicking yet)

> “Patients become the switchboard between pharmacy, clinic, and insurer.  
> RxRelay is a consent-first voice coordinator. We only call it solved when we can **prove** it: consent, action, counterpart outcome, and patient update.”

Point at the empty/open proof checks on the board.

### 0:20–1:50 — Live phone call (the win)

1. Put the phone on speaker.
2. Dial **+18026768127**.
3. You will hear a **female neural voice** (Joanna) explaining what RxRelay can help with.
4. Say clearly:

> **“I consent to a pharmacy status follow-up and text updates.”**

5. Watch the proof board: a new **voice** case should appear (or refresh the case picker). Consent check turns green.
6. Say:

> **“Please check my prescription status.”**

   Board: coordination / permitted action turns green.

7. Say:

> **“The pharmacy said prior authorization is needed.”**

8. Say:

> **“The clinic submitted the prior authorization.”**

9. Say:

> **“The pharmacy says it is ready for pickup.”**

10. Board should hit **4/4 green** · status **Resolution verified**.

Natural alternatives that also work:
- “You can check my pharmacy status.”
- “They’re waiting on insurance / PA.”
- “My doctor filed the PA.”
- “It’s ready for pickup.”
- “What can you help with?”
- “I want a human.”

### 1:50–2:20 — Receipt (optional wow)

On the board, click **Export signed receipt** on the resolved case.  
> “This is a hash-chained proof receipt — not a chat log claiming success.”

### 2:20–2:45 — Safety / PAVO

In the PAVO lab (bottom of board), paste:  
`What dosage should I take?` → **Safety stop**.  
Or lower ASR confidence on a PA number → **Verified** route (speech + keypad digits).

### 2:45–3:00 — Close

> “a1mobile carries the call. We refuse fake completion. That’s the product.”

---

## Backup if the phone glitches (still win)

Use the board buttons on **RX-1048**:

1. Record consent (if needed)  
2. Call pharmacy → Record blocker → Record clinic → Confirm readiness  
3. Show 4/4 green  

Then say: “Same state machine the phone drives — fail-closed evidence.”

---

## What you should NOT claim live

- Live SMS to a real phone (needs OTP allowlist)  
- A real pharmacy desk was dialed (sandbox outbound for demo reliability)  
- The website *is* the product (it is marketing only)

---

## Phrases cheat-sheet (print this)

| You say | What happens |
| --- | --- |
| I consent to a pharmacy status follow-up and text updates | Consent recorded |
| Check my prescription status | Coordination starts |
| Pharmacy said prior authorization is needed | Blocker recorded |
| Clinic submitted the prior authorization | Clinic step recorded |
| Pharmacy says it is ready for pickup | SMS + 4/4 proof |
| What can you help with? | Options menu |
| I want a human | Safe handoff |
