import { classifyReadFailure, createEvidenceEnvelope, type EvidenceEnvelope, type EvidenceInput } from './evidence-envelope.js';

/**
 * Producer face of `collectEvidence`, carrying the same per-axis reason
 * discrimination as `EvidenceInput` (A04/R04): a caller cannot hand a failure
 * reason to an `empty` source, nor an absence reason to an `error` one.
 */
export type EvidenceSource = EvidenceInput;
export type EvidenceRequest = {
  required: boolean;
  fetch: () => Promise<readonly EvidenceSource[] | EvidenceSource>;
  allowedFields?: readonly string[];
};

/**
 * Status resolution for one collected source (A04/R04).
 *
 * An EXPLICIT `status` is authoritative and is preserved together with its
 * axis-correct reason. Only the inference variant (no declared status) is
 * classified from `data`. Recomputing unconditionally would demote a declared
 * failure to `empty` and promote a failed read with a residual payload to
 * usable `ok` evidence.
 *
 * A declared failure carries `data: null`: a failed read contributes nothing
 * for grounding, whatever payload the transport happened to return.
 */
const resolveItem = (source: EvidenceSource): EvidenceInput => {
  if (source.status === 'error') {
    return { ref: source.ref, source: source.source, retrievedAt: source.retrievedAt, status: 'error', data: null, ...(source.reason === undefined ? {} : { reason: source.reason }) };
  }
  if (source.status === 'empty') {
    return { ref: source.ref, source: source.source, retrievedAt: source.retrievedAt, status: 'empty', data: source.data, ...(source.reason === undefined ? {} : { reason: source.reason }) };
  }
  if (source.status === 'ok') {
    return { ref: source.ref, source: source.source, retrievedAt: source.retrievedAt, status: 'ok', data: source.data };
  }
  const inferred = source.data == null || (Array.isArray(source.data) && source.data.length === 0) ? 'empty' : 'ok';
  return { ref: source.ref, source: source.source, retrievedAt: source.retrievedAt, status: inferred, data: source.data };
};

export const collectEvidence = async (request: EvidenceRequest): Promise<EvidenceEnvelope> => {
  try {
    const result = await request.fetch();
    const sources = Array.isArray(result) ? result : [result];
    const items: readonly EvidenceInput[] = sources.length === 0
      ? [{ ref: 'empty', source: 'tool', retrievedAt: new Date().toISOString(), status: 'empty', data: [] }]
      : sources.map(resolveItem);
    return createEvidenceEnvelope(items, { allowedFields: request.allowedFields });
  } catch (error) {
    if (request.required) {
      const failure = new Error('Required evidence is unavailable');
      Object.assign(failure, { code: 'evidence.unavailable', reason: classifyReadFailure(error) });
      throw failure;
    }
    // A04/R04: an unavailable fetch is a typed FAILURE, never an absence.
    return createEvidenceEnvelope([{ ref: 'unavailable', source: 'tool', retrievedAt: new Date().toISOString(), status: 'error', reason: classifyReadFailure(error), data: null }]);
  }
};
