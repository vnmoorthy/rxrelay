import { EventEmitter } from "node:events";

/** Process-local pub/sub for live proof-board streams (SSE). */
export const caseBus = new EventEmitter();
caseBus.setMaxListeners(100);

export function publishCaseEvent(type, payload = {}) {
  const envelope = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    at: new Date().toISOString(),
    ...payload,
  };
  caseBus.emit("case", envelope);
  return envelope;
}
