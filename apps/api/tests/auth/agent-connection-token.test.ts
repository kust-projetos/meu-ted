import { describe, expect, it } from 'vitest';
import { createAgentConnectionToken } from '../../src/auth/agent-connection-token.js';

describe('Agent Connection Token (Task 3)', () => {
  const SECRET = 'test-secret-at-least-32-characters-long!';

  const SAMPLE_INPUT = {
    sub: 'user-uuid-1',
    workspace: 'household-uuid-1',
    role: 'owner' as const,
  };

  it('creates a token with canonical claims and 120s TTL', async () => {
    const now = 1_700_000_000_000;
    const token = await createAgentConnectionToken(SAMPLE_INPUT, SECRET, now);
    expect(token).toBeTypeOf('string');
    expect(token.split('.')).toHaveLength(3);

    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
    expect(claims).toMatchObject({
      iss: 'pi-finance-api',
      aud: 'pi-finance-agent',
      sub: 'user-uuid-1',
      workspace: 'household-uuid-1',
      role: 'owner',
      capabilities: ['financial.read'],
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + 120,
    });
    expect(claims.jti).toBeTypeOf('string');
    expect(claims.jti.length).toBeGreaterThan(10);
  });
});
