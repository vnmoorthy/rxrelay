# Demo script

## The 100-second story

**0–12 seconds — The promise**

“A prescription can be clinically ready and still be inaccessible. Today, the patient becomes the switchboard between pharmacy, clinic, and insurer. RxRelay gives them one voice entry point—and we only call it solved when we can prove it.”

**12–25 seconds — Consent**

Point to the Patient lane and the first proof check. “This is a consented sandbox case. RxRelay has permission for exactly one thing: non-clinical status coordination and updates.”

**25–45 seconds — Pharmacy blocker**

Click **Call pharmacy**, then **Record blocker**. “The agent does not claim success. It records the pharmacy outcome: a prior authorization is needed. The case stays amber.”

**45–65 seconds — Clinic action**

Click **Record clinic step**. “The clinic action is recorded, but that is not a resolved prescription. We still wait for an independent pharmacy confirmation.”

**65–82 seconds — The patient gets an update**

Click **Confirm readiness**. “Now the pharmacy has confirmed readiness and RxRelay sends a consented status update. The proof board is green because every condition is factual.”

**82–100 seconds — Why PAVO makes it trustworthy**

Use the PAVO lab: lower the ASR confidence or ask for medical advice. “When the audio contains a critical detail, RxRelay upgrades the whole pipeline—ASR plus inference—before acting. If it is a clinical or unsafe request, the agent stops and hands off.”

## Judge checklist

- [ ] Dashboard works locally at `http://localhost:3000`.
- [ ] Full sandbox flow ends with a green deterministic proof.
- [ ] Safe-stop branch stays in human review.
- [ ] `npm test` passes.
- [ ] If live credentials arrive, run the consented smoke test in `A1MOBILE_LIVE_SETUP.md`.
