// Undo request handoff — process-local metadata from the native tool loop to
// the gateway. The gateway performs the identity check and creates the
// user-visible undo request in the undo store; no money is moved here.
function registry() {
  const values = new Map();
  return {
    record(sessionID, action) {
      if (typeof sessionID !== 'string' || !sessionID || !action || typeof action !== 'object') {
        throw new Error('undo action invalid');
      }
      values.set(sessionID, Object.freeze(action));
    },
    take(sessionID) { const value = values.get(sessionID) ?? null; values.delete(sessionID); return value; },
    clear(sessionID) { values.delete(sessionID); },
  };
}
export function createUndoActionRegistry() { return registry(); }
export const undoActionRegistry = registry();
