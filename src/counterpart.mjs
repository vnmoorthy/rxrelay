import crypto from "node:crypto";

/**
 * Magic-link counterpart attestations.
 * Pharmacy/clinic staff open a token URL and attest blocker / PA submitted /
 * ready — replacing patient-spoken stand-ins with third-party confirmation.
 */

const tokens = new Map();

export function issueCounterpartToken({ caseId, role, ttlMs = 1000 * 60 * 60 * 24 }) {
  const token = crypto.randomBytes(18).toString("base64url");
  const record = {
    token,
    caseId,
    role, // pharmacy | clinic | insurer
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    usedAt: null,
  };
  tokens.set(token, record);
  return record;
}

export function peekCounterpartToken(token) {
  const record = tokens.get(token);
  if (!record) return null;
  if (record.usedAt) return { ...record, status: "used" };
  if (Date.parse(record.expiresAt) < Date.now()) return { ...record, status: "expired" };
  return { ...record, status: "open" };
}

export function consumeCounterpartToken(token) {
  const record = peekCounterpartToken(token);
  if (!record || record.status !== "open") return record;
  record.usedAt = new Date().toISOString();
  tokens.set(token, record);
  return { ...record, status: "consumed" };
}

export function listOpenTokensForCase(caseId) {
  return [...tokens.values()].filter((item) => item.caseId === caseId && !item.usedAt && Date.parse(item.expiresAt) >= Date.now());
}

/** Test helper */
export function _resetCounterpartTokens() {
  tokens.clear();
}
