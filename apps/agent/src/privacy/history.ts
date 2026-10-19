export type MessageRecord = {
  id: string;
  actorId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: string;
};

import { scrubForPersistence } from './dlp.js';

/**
 * P2-DLP-FUNNEL: single funnel — persistence sanitization IS the central DLP
 * scrub (secrets → PAN → CVV → CPF/CNPJ → transcript redaction). The former
 * local SECRET_PATTERNS duplicate was removed in favor of this delegation;
 * behavior is a strict superset (redacts everything it did before, plus
 * card/document patterns, under the shared `[REDACTED]` marker).
 */
export const sanitizeForPersistence = (text: string): string => scrubForPersistence(text ?? '');

export const canActorClearHistory = (
  actorRole: string,
  targetActorId?: string,
  requestingActorId?: string,
): boolean => {
  // Owner can clear workspace history
  if (actorRole === 'owner') return true;

  // Member can only clear their own history, never other members or global workspace
  if (targetActorId && requestingActorId && targetActorId === requestingActorId) {
    return true;
  }

  return false;
};
