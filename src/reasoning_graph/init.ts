import type { StorePersistence } from "./persistence.js";

export function initializeReasoningGraphStore(persistence: StorePersistence) {
  return persistence.initialize();
}
