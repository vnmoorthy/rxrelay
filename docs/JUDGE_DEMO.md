# Judge demo — 3 minutes (natural patient call)

Use this exact path. Do **not** demo from the GitHub Pages brochure.

## Before judges walk up (60 seconds)

1. Confirm both services are up:
   - Proof board: **http://localhost:3000**
   - Voice: terminal running `npm run live:inbound` says `Claimed number pointed…`
2. Call number: **+1 (802) 676-8127**
3. Split screen: left = proof board, right = optional

```bash
cd /tmp/rxrelay-work
npm run dev
# other terminal
npm run live:inbound
```

Maya uses a practical voice-training layer (`src/voice-training/lexicon.json`): ASR repairs, Gather speech hints, intent/consent paraphrases, anti-repeat memory, and few-shot exemplar turns in the LLM prompt. Speak naturally — she should not need legalese.

---

## Patient scenario (memorize this character)

You are **Alex**, calling about **metformin** stuck at **CVS** for about a week. Speak like a normal person — short sentences, no legalese.

Maya should sound human: short answers, no menu dumps, no repeating herself.

---

## The 3-minute script

### 0:00–0:20 — Promise

> “Patients become the switchboard between pharmacy, clinic, and insurer.  
> RxRelay only calls it solved when we can **prove** it: consent, action, counterpart outcome, and patient update.”

### 0:20–1:50 — Live phone call

1. Dial **+18026768127** on speaker.
2. Hear a short greeting (Maya / Joanna Neural).
3. Speak naturally — any line in each step works:

| Beat | Say something like… | Board should… |
| --- | --- | --- |
| 1 · Ask for help | “Hi — please help, I’ve been stuck at CVS for five days on my metformin.” | New voice case · consent green · coordination starts |
| 2 · Pharmacy blocker | “They said they need prior auth before they can fill it.” | Coordination + PA blocker |
| 3 · Clinic filed | “My doctor filed the PA this morning.” | Clinic submission |
| 4 · Ready | “The pharmacy says it’s ready for pickup.” | **4/4 green** · resolved |

**Also fine** (same beats — lexicon covers these paraphrases):
- “Can you check what’s going on with my prescription?”
- “They’re waiting on insurance / PA.” / “Insurance is holding it.”
- “The clinic submitted it.” / “Doc took care of it.”
- “It’s ready.” / “Filled and ready.”
- “I want a human.” → safety handoff

You do **not** need to recite “I consent to a pharmacy status follow-up…” — asking for help with the Rx is enough for the demo path.

### 1:50–2:20 — Receipt (optional)

**Export signed receipt** on the resolved case.

### 2:20–3:00 — Close

> “Consent-first voice, PAVO routing, and a deterministic proof gate — not another chatbot that claims it called the pharmacy.”

---

## If something goes sideways

| Issue | Fix |
| --- | --- |
| Silence / “didn’t catch that” | Speak a bit slower; wait for the tone to end |
| Maya repeats herself | Hang up, call again (new case); anti-repeat + few-shot style are wired in |
| Board doesn’t move | Refresh case picker; confirm shared `data/cases.json` |
| Wrong number / no answer | Re-run `npm run live:inbound` (tunnel URL changes) |

---

## Soft phrases cheat-sheet

- Help / consent: “please help with my prescription”, “you can check my pharmacy status”, “I’ve been stuck at CVS…”
- Start: “what’s going on with my meds?”, “I’ve been waiting”
- PA: “they need prior auth”, “insurance is holding it”, “won’t fill until PA”
- Clinic: “my doctor filed it”, “clinic submitted the PA”, “doc took care of it”
- Ready: “it’s ready for pickup”, “filled and ready”
- Human: “I want a real person”
