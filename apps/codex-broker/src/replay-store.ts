import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export type HmacEnvelope = {
  kid: string;
  aud: 'pi-codex-broker';
  timestamp: number;
  nonce: string;
  requestId: string;
  bodySha256: string;
};

export type NonceReplayStore = {
  consume(nonce: string, timestamp: number, now?: number): boolean;
  clear(): void;
};

export const createInMemoryNonceReplayStore = (): NonceReplayStore => {
  const seen = new Map<string, number>();

  return {
    consume(nonce: string, timestamp: number, now: number = Date.now()): boolean {
      // Purge expired nonces (>60s old) with the caller-supplied clock so
      // the sweep stays coherent with the skew check in verifyEnvelope
      // (BRK-02): the envelope carries its own timestamp, never wall time.
      for (const [k, exp] of seen) {
        if (exp < now) {
          seen.delete(k);
        }
      }

      if (seen.has(nonce)) {
        return false;
      }

      seen.set(nonce, timestamp + 60_000);
      return true;
    },
    clear() {
      seen.clear();
    },
  };
};

export const computeBodySha256 = (body: string | Buffer): string => {
  return createHash('sha256').update(body).digest('hex');
};

export const signEnvelope = (envelope: HmacEnvelope, secret: string): string => {
  const payload = `${envelope.kid}.${envelope.aud}.${envelope.timestamp}.${envelope.nonce}.${envelope.requestId}.${envelope.bodySha256}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
};

export const verifyEnvelope = (
  envelope: HmacEnvelope,
  signature: string,
  secret: string,
  rawBody: string | Buffer,
  replayStore: NonceReplayStore,
  now = Date.now(),
): { valid: boolean; reason?: string } => {
  if (!envelope || !signature || !secret) {
    return { valid: false, reason: 'missing_parameters' };
  }

  if (envelope.aud !== 'pi-codex-broker') {
    return { valid: false, reason: 'invalid_audience' };
  }

  // Max 30 seconds clock skew / validity
  if (Math.abs(now - envelope.timestamp) > 30_000) {
    return { valid: false, reason: 'timestamp_out_of_bounds' };
  }

  // Verify body hash matches
  const actualHash = computeBodySha256(rawBody);
  if (actualHash !== envelope.bodySha256) {
    return { valid: false, reason: 'body_hash_mismatch' };
  }

  // Verify HMAC signature
  const expectedSig = signEnvelope(envelope, secret);
  const expectedBuffer = Buffer.from(expectedSig, 'hex');
  const providedBuffer = Buffer.from(signature, 'hex');

  if (expectedBuffer.length !== providedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) {
    return { valid: false, reason: 'invalid_signature' };
  }

  // Atomically consume nonce, forwarding the skew-check clock so the
  // purge inside the store cannot diverge from it (BRK-02).
  const consumed = replayStore.consume(envelope.nonce, envelope.timestamp, now);
  if (!consumed) {
    return { valid: false, reason: 'nonce_replayed' };
  }

  return { valid: true };
};
