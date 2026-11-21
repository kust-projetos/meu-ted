// Action intents — process-local handoff from the native tool loop to the
// gateway executor. NOT a financial record: an intent is metadata consumed by
// the gateway in the same turn; the API remains the sole financial authority.
// Nothing here writes money, calls HTTP, or survives a restart; a lost intent
// is re-derivable by a new user turn.
//
// One intent per native session (turns are serialized per session):
// record() overwrites, take() is destructive, clear() runs at turn start so a
// failed turn can never leak an intent into the next one.

function createRegistry() {
  const store = new Map();

  return {
    record(sessionID, intent) {
      if (typeof sessionID !== 'string' || sessionID.length === 0) {
        throw new Error('action intent: sessionID is required');
      }
      if (!intent || typeof intent !== 'object') throw new Error('action intent: intent is required');
      store.set(sessionID, Object.freeze({ ...intent }));
    },
    peek(sessionID) {
      if (typeof sessionID !== 'string' || sessionID.length === 0) return null;
      return store.get(sessionID) ?? null;
    },
    take(sessionID) {
      if (typeof sessionID !== 'string' || sessionID.length === 0) return null;
      const intent = store.get(sessionID);
      if (!intent) return null;
      store.delete(sessionID);
      return intent;
    },
    clear(sessionID) {
      if (typeof sessionID !== 'string' || sessionID.length === 0) return;
      store.delete(sessionID);
    },
    clearAll() {
      store.clear();
    },
    size() {
      return store.size;
    },
  };
}

export function createActionIntentRegistry() {
  return createRegistry();
}

// Product singleton: the plugin records, the gateway server takes. Both live
// in the same isolated TED process (the SDK runs in-process).
export const actionIntentRegistry = createRegistry();
