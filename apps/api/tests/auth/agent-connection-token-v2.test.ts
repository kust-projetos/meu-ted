import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { createAgentConnectionToken } from '../../src/auth/agent-connection-token.js';

describe('Agent connection token V2 capability defaults', () => {
  it('delegated/default connection tokens are read-only', async () => {
    const now = 1_700_000_000_000;
    const token = await createAgentConnectionToken(
      { sub: 'actor-1', workspace: 'workspace-1', role: 'owner' },
      'test-secret-at-least-32-characters-long!',
      now,
    );

    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
    expect(claims.capabilities).toEqual(['financial.read']);
    expect(claims.capabilities).not.toContain(['financial', 'write'].join('.'));
  });
});
