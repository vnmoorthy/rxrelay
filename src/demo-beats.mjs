/**
 * Dead-simple 4-beat judge demo.
 * Speech OR keypad 1→2→3→4 advances the same scripted path.
 */

export const DEMO_OPEN =
  "Hi, this is Maya with RxRelay. Say your request, or press 1 on the keypad to begin.";

export const DEMO_BEATS = {
  1: {
    transcript: "Please help — I've been stuck at CVS on my metformin.",
    reply: "Got it — I've got your okay and I'm checking status with CVS on your metformin now. What did they tell you? Say it, or press 2.",
  },
  2: {
    transcript: "They need prior authorization.",
    reply: "I've logged that CVS needs prior auth. Has your doctor filed it yet? Say it, or press 3.",
  },
  3: {
    transcript: "My doctor filed the PA.",
    reply: "Perfect — I've recorded the clinic filed the PA, and I'm pushing fill confirmation to the pharmacy. Tell me when it's ready, or press 4.",
  },
  4: {
    transcript: "It's ready for pickup.",
    reply: "Great news — I've confirmed it's ready for pickup and sent your status update. You can pick it up at CVS today. You're all set. Goodbye.",
  },
};

/** Map keypad digit or free speech onto a demo beat transcript. */
export function resolveDemoInput({ speech = "", digits = "" } = {}) {
  const d = String(digits || "").trim();
  if (d === "1" || d === "2" || d === "3" || d === "4") {
    const beat = DEMO_BEATS[d];
    return { beat: Number(d), transcript: beat.transcript, fixedReply: beat.reply, via: "dtmf" };
  }

  const t = String(speech || "").toLowerCase();
  if (!t.trim()) return null;

  if (/\bstuck\b/.test(t) || /\bmetformin\b/.test(t) || (/\bhelp\b/.test(t) && /\bcvs\b/.test(t)) || (/\bplease help\b/.test(t) && /\bprescription|medication|cvs\b/.test(t))) {
    return { beat: 1, transcript: DEMO_BEATS[1].transcript, fixedReply: DEMO_BEATS[1].reply, via: "speech" };
  }
  if (/\bprior auth|\bprior authorization|\bneed(?:s)? (?:a )?pa\b|\bpa needed\b/.test(t)) {
    return { beat: 2, transcript: DEMO_BEATS[2].transcript, fixedReply: DEMO_BEATS[2].reply, via: "speech" };
  }
  if (/\bdoctor filed|\bclinic (?:filed|submitted)|\bfiled the pa\b|\bmy doctor\b/.test(t)) {
    return { beat: 3, transcript: DEMO_BEATS[3].transcript, fixedReply: DEMO_BEATS[3].reply, via: "speech" };
  }
  if (/\bready for pickup\b|\bit'?s ready\b|\bready to pick/.test(t)) {
    return { beat: 4, transcript: DEMO_BEATS[4].transcript, fixedReply: DEMO_BEATS[4].reply, via: "speech" };
  }
  return null;
}

export function fixedReplyForAction(action) {
  if (action === "start_coordination" || action === "consent") return DEMO_BEATS[1].reply;
  if (action === "pharmacy_blocker") return DEMO_BEATS[2].reply;
  if (action === "clinic_submission") return DEMO_BEATS[3].reply;
  if (action === "pharmacy_ready") return DEMO_BEATS[4].reply;
  return null;
}
