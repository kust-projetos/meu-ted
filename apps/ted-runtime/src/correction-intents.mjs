// Process-local, one-turn metadata handoff. Not persistent memory or a
// financial record; values are never sent to the model or logged.
function createRegistry() {
  const store = new Map();
  return {
    record(sessionID, intent) {
      if (typeof sessionID !== 'string' || !sessionID) throw new Error('correction intent: sessionID is required');
      if (!intent || !['description', 'amount', 'date', 'category', 'account'].includes(intent.field) ||
          typeof intent.value !== 'string' || !intent.value) throw new Error('correction intent: valid field/value required');
      store.set(sessionID, Object.freeze({ field: intent.field, value: intent.value }));
    },
    take(sessionID) {
      const intent = store.get(sessionID);
      if (!intent) return null;
      store.delete(sessionID);
      return intent;
    },
    clear(sessionID) { if (typeof sessionID === 'string' && sessionID) store.delete(sessionID); },
  };
}
export function createCorrectionIntentRegistry() { return createRegistry(); }
export const correctionIntentRegistry = createRegistry();
