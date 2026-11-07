// Proposal intents — process-local handoff from the native tool loop to the
// authenticated PWA. NOT a financial record: an intent is metadata the browser
// sends back to the Agent broker, which is the only component allowed to mint
// `financial.approval.propose` (A4). Nothing here writes money, calls HTTP, or
// survives a restart; a lost intent is re-derivable by a new user turn.
//
// One pending intent per native session (turns are serialized per session):
// record() overwrites, take() is destructive, clear() runs at turn start so a
// failed turn can never leak an intent into the next one.

function createRegistry() {
  const store = new Map();

  return {
    record(sessionID, intent) {
      if (typeof sessionID !== 'string' || sessionID.length === 0) {
        throw new Error('proposal intent: sessionID is required');
      }
      if (!intent || typeof intent !== 'object') throw new Error('proposal intent: intent is required');
      store.set(sessionID, Object.freeze({ ...intent }));
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

export function createProposalIntentRegistry() {
  return createRegistry();
}

// Product singleton: the plugin records, the gateway server takes. Both live
// in the same isolated TED process (the SDK runs in-process).
export const proposalIntentRegistry = createRegistry();
