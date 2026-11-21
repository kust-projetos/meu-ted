// TED agent self-confirm (S1 — runtime only).
//
// The gateway may confirm + execute a Pending V2 proposal inside the SAME chat
// turn, but only when ALL of the following hold:
//   1. the operator explicitly enabled TED_AGENT_SELF_CONFIRM=1 (strict parse,
//      default OFF — fail closed everywhere else);
//   2. the agent declared a favorable `assurance` on the propose_* tool call;
//   3. the API accepted the proposal as actionable (no 409 approval.not_actionable).
// The attestation minted by confirm is a one-use capability: it NEVER leaves
// this module. The public `execution` shape is receipt/outcome only, and an
// uncertain/unverified outcome is never promoted to `succeeded`.
//
// No money is moved here directly: every step goes through the existing
// Pending V2 pipeline (pending-client.mjs) with the same delegated identity and
// the same derive-from-intentionId Idempotency-Key the other paths use.

import { proposeIdempotencyKey } from './pending-client.mjs';

export const ASSURANCE_KEYS = Object.freeze(['complete', 'ambiguousEntity', 'explicitIntent']);

// Shared with every propose_* tool input schema. Optional: with the flag OFF
// the old intent-only card flow is byte-identical and needs no assurance.
// Kept deliberately MINIMAL: OpenCode 2.2.4's tool-schema bridge stalls the
// native prompt loop when a nested object carries `description`, `required` or
// `additionalProperties` (proven by tests/p3-propose-loop.test.mjs). Field
// semantics live in the tool's top-level description; STRICT validation lives
// in normalizeAssurance() on the gateway side, never in this JSON schema.
export const ASSURANCE_SCHEMA = {
  type: 'object',
  properties: {
    complete: { type: 'boolean' },
    ambiguousEntity: { type: 'boolean' },
    explicitIntent: { type: 'boolean' },
  },
};

// Strict parse, identical to the other runtime flags: ONLY the literal '1'
// enables it; absent, '0', 'true', numbers, non-objects and throws stay OFF.
export function isSelfConfirmEnabled(env = process.env) {
  try {
    if (!env || typeof env !== 'object') return false;
    return env.TED_AGENT_SELF_CONFIRM === '1';
  } catch {
    return false;
  }
}

// Returns a frozen-shape canonical copy, or null when the declaration is
// missing/malformed. Malformed means: not a plain object, wrong key count,
// missing key or a non-boolean value. Extra keys are rejected too.
export function normalizeAssurance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== ASSURANCE_KEYS.length) return null;
  for (const key of ASSURANCE_KEYS) {
    if (!Object.hasOwn(value, key) || typeof value[key] !== 'boolean') return null;
  }
  return {
    complete: value.complete,
    ambiguousEntity: value.ambiguousEntity,
    explicitIntent: value.explicitIntent,
  };
}

// Favorable assurance: complete data, no material ambiguity, explicit intent.
// Anything else (including a malformed declaration) is NOT actionable.
export function isActionableAssurance(value) {
  const a = normalizeAssurance(value);
  return !!a && a.complete === true && a.ambiguousEntity === false && a.explicitIntent === true;
}

export const SELF_CONFIRM_CLARIFICATION =
  'Não tenho dados suficientes para concluir com segurança. Pode esclarecer o(s) dado(s) faltante(s) ou ambíguo(s)?';
export const SELF_CONFIRM_NOT_ACTIONABLE =
  'Não consegui concluir automaticamente porque a operação não pôde ser apresentada com segurança. Pode esclarecer os dados?';

function isNotActionable(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  return code === 'approval.not_actionable' || code.startsWith('pending.upstream_409_') ||
    (error && error.statusCode === 409);
}

function validSucceededReceipt(receipt, operationId) {
  return !!receipt && typeof receipt === 'object' && !Array.isArray(receipt) &&
    receipt.status === 'succeeded' && receipt.operationId === operationId &&
    typeof receipt.mutationId === 'string' && receipt.mutationId.length > 0 &&
    typeof receipt.mutationKind === 'string' && receipt.mutationKind.length > 0;
}

// Public chat DTO. `outcome`/`receipt` come from the canonical Pending V2
// outcome read (already strict-validated by pending-client.mjs); we re-project
// only allowlisted fields so an attestation can never ride along.
function buildExecution({ id, tool, outcome, aborted }) {
  const safeOutcome = {
    status: outcome && typeof outcome.status === 'string' ? outcome.status : 'unverified',
    ...(outcome && typeof outcome.failureCode === 'string' ? { failureCode: outcome.failureCode } : {}),
  };
  const succeeded = !aborted && !!outcome && safeOutcome.status === 'succeeded' &&
    validSucceededReceipt(outcome.receipt, id);
  const failed = !aborted && safeOutcome.status === 'failed';
  const execution = {
    operationId: id,
    tool,
    status: succeeded ? 'succeeded' : failed ? 'failed' : 'unverified',
    outcome: safeOutcome,
  };
  if (succeeded) execution.receipt = outcome.receipt;
  return execution;
}

export function executionOutput(status, summary) {
  const label = typeof summary === 'string' && summary.trim() ? summary.trim() : 'operação financeira';
  if (status === 'succeeded') return `Concluído: ${label}.`;
  if (status === 'failed') return `Não foi possível concluir: ${label}.`;
  return `Não consegui verificar a conclusão de ${label}.`;
}

// One executor per gateway process. The result is memoized by intentionId: the
// same intention NEVER runs mint/propose/confirm/execute/outcome twice, even if
// a caller somehow reaches this seam again. The turn-level intention registry
// is the outer guard; this map is defense in depth.
export function createSelfConfirmExecutor({ client = null } = {}) {
  const byIntention = new Map();

  async function run({ identity, intentionId, intent, signal } = {}) {
    if (typeof intentionId === 'string' && byIntention.has(intentionId)) {
      return byIntention.get(intentionId);
    }
    const remember = (result) => {
      if (typeof intentionId === 'string' && intentionId.length > 0) byIntention.set(intentionId, result);
      return result;
    };

    const tool = intent && intent.tool;
    const normalizedArgs = intent && intent.normalizedArgs;
    const hasClient = client && ['mintToken', 'propose', 'confirm', 'execute', 'outcome']
      .every((name) => typeof client[name] === 'function');
    if (!hasClient) return remember({ kind: 'skipped', reason: 'client_unavailable' });
    if (typeof tool !== 'string' || !tool || !normalizedArgs || typeof normalizedArgs !== 'object' ||
        Array.isArray(normalizedArgs) || typeof identity?.workspaceId !== 'string' ||
        typeof identity?.actorId !== 'string' || typeof identity?.deviceId !== 'string') {
      return remember({ kind: 'skipped', reason: 'invalid_intent' });
    }

    const fields = {
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId,
    };
    let token;
    let attestation;
    let proposalId;
    try {
      token = await client.mintToken({ ...fields, requestId: intentionId, signal });
      if (typeof token !== 'string' || !token) return remember({ kind: 'skipped', reason: 'mint_failed' });
      const proposal = await client.propose({
        token,
        ...fields,
        tool,
        normalizedArgs,
        idempotencyKey: proposeIdempotencyKey({ workspaceId: fields.workspaceId, intentionId, tool }),
        signal,
      });
      if (!proposal || typeof proposal.id !== 'string' || !proposal.id) {
        return remember({ kind: 'skipped', reason: 'propose_invalid' });
      }
      proposalId = proposal.id;
      const transition = await client.confirm({ token, ...fields, id: proposalId, intentionId, signal });
      if (!transition || typeof transition.attestation !== 'string' || transition.attestation.length < 32) {
        return remember({ kind: 'skipped', reason: 'confirm_failed' });
      }
      attestation = transition.attestation;
    } catch (error) {
      if (isNotActionable(error)) return remember({ kind: 'not_actionable' });
      return remember({ kind: 'skipped', reason: proposalId ? 'execute_uncertain' : 'pipeline_error' });
    }

    // execute may fail after the capability was spent (money may have moved);
    // the canonical outcome read is the ONLY authority for the final status.
    try {
      await client.execute({ token, ...fields, id: proposalId, attestation, intentionId, signal });
    } catch { /* read the outcome below — never invent success */ }
    let outcome = null;
    try {
      outcome = await client.outcome({ token, ...fields, id: proposalId, signal });
    } catch { /* unverified: outcome not provable */ }

    const execution = buildExecution({ id: proposalId, tool, outcome, aborted: !!signal?.aborted });
    return remember({ kind: 'execution', execution });
  }

  return { run, size: () => byIntention.size };
}
