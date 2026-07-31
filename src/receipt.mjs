import crypto from "node:crypto";

/**
 * Hash-chained proof receipts.
 * Each closed case exports a verifiable JSON receipt: consent text, provider
 * action ids, route decisions, and a chain hash. Pure Node crypto — no deps.
 */

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashPayload(payload) {
  return crypto.createHash("sha256").update(stable(payload)).digest("hex");
}

export function buildProofReceipt(caseRecord, { issuer = "RxRelay", secret = process.env.RXRELAY_RECEIPT_SECRET || "rxrelay-demo-receipt" } = {}) {
  const events = (caseRecord.events || []).slice().reverse().map((event, index, list) => {
    const body = {
      index,
      type: event.type,
      summary: event.summary,
      lane: event.lane,
      createdAt: event.createdAt,
      data: event.data || {},
    };
    const prev = index === 0 ? "genesis" : list[index - 1]._hash;
    const _hash = hashPayload({ prev, body });
    return { ...body, prev, _hash };
  });
  // Attach hashes onto working copy without mutating callers' originals twice.
  for (let i = 0; i < events.length; i += 1) {
    const body = {
      index: events[i].index,
      type: events[i].type,
      summary: events[i].summary,
      lane: events[i].lane,
      createdAt: events[i].createdAt,
      data: events[i].data,
    };
    const prev = i === 0 ? "genesis" : events[i - 1]._hash;
    events[i].prev = prev;
    events[i]._hash = hashPayload({ prev, body });
  }

  const core = {
    schema: "rxrelay.proof-receipt.v1",
    issuer,
    caseId: caseRecord.id,
    patientAlias: caseRecord.patient?.alias,
    medication: caseRecord.medication,
    source: caseRecord.source,
    createdAt: caseRecord.createdAt,
    closedAt: new Date().toISOString(),
    status: caseRecord.status,
    evidence: caseRecord.evidence,
    proof: caseRecord.proof,
    lastRoute: caseRecord.lastRoute,
    communications: (caseRecord.communications || []).map((item) => ({
      id: item.id,
      mode: item.mode,
      type: item.type,
      createdAt: item.createdAt,
      textHash: hashPayload(item.text),
    })),
    chain: events,
    tip: events.at(-1)?._hash || hashPayload({ caseId: caseRecord.id, empty: true }),
  };

  const signature = crypto.createHmac("sha256", secret).update(stable({ tip: core.tip, caseId: core.caseId, evidence: core.evidence })).digest("hex");
  return { ...core, signature, signedWith: "hmac-sha256" };
}

export function verifyProofReceipt(receipt, { secret = process.env.RXRELAY_RECEIPT_SECRET || "rxrelay-demo-receipt" } = {}) {
  if (!receipt || receipt.schema !== "rxrelay.proof-receipt.v1") return { ok: false, reason: "unsupported schema" };
  let prev = "genesis";
  for (const [index, event] of (receipt.chain || []).entries()) {
    const body = {
      index: event.index,
      type: event.type,
      summary: event.summary,
      lane: event.lane,
      createdAt: event.createdAt,
      data: event.data || {},
    };
    const expected = hashPayload({ prev, body });
    if (event._hash !== expected || event.prev !== prev || event.index !== index) {
      return { ok: false, reason: `chain break at index ${index}` };
    }
    prev = event._hash;
  }
  if (receipt.tip !== (receipt.chain?.at(-1)?._hash || receipt.tip)) {
    return { ok: false, reason: "tip mismatch" };
  }
  const expectedSig = crypto.createHmac("sha256", secret).update(stable({ tip: receipt.tip, caseId: receipt.caseId, evidence: receipt.evidence })).digest("hex");
  if (expectedSig !== receipt.signature) return { ok: false, reason: "bad signature" };
  return { ok: true, tip: receipt.tip };
}
