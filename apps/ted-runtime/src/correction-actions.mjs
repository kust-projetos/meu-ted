function registry() {
  const values = new Map();
  return { record(sessionID, action) { if (typeof sessionID !== 'string' || !sessionID || !action || typeof action !== 'object') throw new Error('correction action invalid'); values.set(sessionID, Object.freeze(action)); }, take(sessionID) { const value=values.get(sessionID) ?? null; values.delete(sessionID); return value; }, clear(sessionID) { values.delete(sessionID); } };
}
export const correctionActionRegistry = registry();
