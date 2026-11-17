import { createHmac } from 'node:crypto';

export class WorkspaceAttestationError extends Error {
  constructor(code) {
    super(code === 'agent.workspace_not_empty' ? 'workspace is not empty' : 'workspace attestation unavailable');
    this.name = 'WorkspaceAttestationError';
    this.code = code;
    this.statusCode = 409;
  }
}

// Mirrors apps/api/src/auth/workspace-deletion.ts::agentEmptyProofCanonical.
// Attachments are zero because this gateway never stores attachments.
// The signed inventory has a five-minute window before deposit; API-side validation rejects stale proofs.
export function agentEmptyProofCanonical(workspaceId, inventoryVersion, counts, expiresAt) {
  const pairs = ['attachments', 'memories', 'messages', 'sessions'].map((key) => [key, counts[key]]);
  return JSON.stringify({ workspaceId, inventoryVersion, counts: pairs, expiresAt });
}

export async function attestEmptyWorkspace({ workspaceId, inventoryVersion, actorId, store, categoryMemoryStore, undoStore, secret, client, signal, now = Date.now() } = {}) {
  if (!secret || !client || typeof store?.inventory !== 'function') throw new WorkspaceAttestationError('agent.attestation_unavailable');
  let local;
  try {
    if (typeof inventoryVersion !== 'string' || !/^[0-9a-f]{64}$/.test(inventoryVersion)) throw new Error('invalid inventory version');
    local = store.inventory({ workspaceId });
    if (local.degraded) throw new Error('degraded');
    if (undoStore?.countByWorkspace(workspaceId) > 0) throw new WorkspaceAttestationError('agent.workspace_not_empty');
    const memories = categoryMemoryStore ? categoryMemoryStore.countByWorkspace(workspaceId) : 0;
    if (!categoryMemoryStore) throw new Error('memory inventory unavailable');
    const counts = { sessions: local.sessions, messages: local.messages, memories, attachments: 0 };
    if (Object.values(counts).some((n) => !Number.isSafeInteger(n) || n < 0)) throw new Error('invalid inventory');
    if (Object.values(counts).some((n) => n !== 0)) throw new WorkspaceAttestationError('agent.workspace_not_empty');
    const expiresAt = new Date(now + 5 * 60_000).toISOString();
    const canonical = agentEmptyProofCanonical(workspaceId, inventoryVersion, counts, expiresAt);
    const proof = { workspaceId, inventoryVersion, counts, expiresAt, hmac: createHmac('sha256', secret).update(canonical, 'utf8').digest('hex') };
    const result = await client.depositEmptyAttestation({ actorId, proof, signal });
    if (!result || typeof result.attestationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.attestationId)) {
      throw new WorkspaceAttestationError('agent.attestation_unavailable');
    }
    return { attestationId: result.attestationId };
  } catch (error) {
    if (error instanceof WorkspaceAttestationError) throw error;
    throw new WorkspaceAttestationError('agent.attestation_unavailable');
  }
}
