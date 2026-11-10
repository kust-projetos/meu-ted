// Deployment origin gates — internal Docker network without weakening the
// default posture.
//
// The default stays loopback-only. A co-located deployment (gateway + API in
// the same private network) is reachable ONLY through the exact-origin
// allowlist and an explicit non-loopback bind opt-in.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assertLoopbackApiOrigin, parseAllowedApiOrigins } from '../src/gateway.mjs';
import { startTedRuntime } from '../src/main.mjs';

describe('parseAllowedApiOrigins', () => {
  it('accepts a bare internal origin', () => {
    assert.deepEqual(parseAllowedApiOrigins('http://pi-finance-api:3001'), ['http://pi-finance-api:3001']);
  });

  it('accepts a CSV list and trims entries', () => {
    assert.deepEqual(
      parseAllowedApiOrigins('http://pi-finance-api:3001 , https://api.internal.example'),
      ['http://pi-finance-api:3001', 'https://api.internal.example'],
    );
  });

  it('empty input means no extra origins', () => {
    assert.deepEqual(parseAllowedApiOrigins(''), []);
    assert.deepEqual(parseAllowedApiOrigins(undefined), []);
  });

  it('rejects a path, credentials, and loopback duplicates', () => {
    assert.throws(() => parseAllowedApiOrigins('http://pi-finance-api:3001/api'), /bare origin/);
    assert.throws(() => parseAllowedApiOrigins('http://user:pass@pi-finance-api:3001'), /credentials/);
    assert.throws(() => parseAllowedApiOrigins('http://127.0.0.1:3001'), /loopback/);
    assert.throws(() => parseAllowedApiOrigins('ftp://pi-finance-api:3001'), /http\(s\)/);
  });
});

describe('assertLoopbackApiOrigin with an explicit allowlist', () => {
  it('loopback stays allowed without any allowlist', () => {
    assert.doesNotThrow(() => assertLoopbackApiOrigin('http://127.0.0.1:3001'));
  });

  it('an allowlisted internal origin is accepted', () => {
    assert.doesNotThrow(() =>
      assertLoopbackApiOrigin('http://pi-finance-api:3001', {
        allowedOrigins: ['http://pi-finance-api:3001'],
      }),
    );
  });

  it('a non-allowlisted origin is refused (exact match only)', () => {
    assert.throws(
      () => assertLoopbackApiOrigin('http://evil:3001', { allowedOrigins: ['http://pi-finance-api:3001'] }),
      /must be loopback or an explicitly allowlisted internal origin/,
    );
    assert.throws(
      () =>
        assertLoopbackApiOrigin('http://pi-finance-api:3001', {
          allowedOrigins: ['http://pi-finance-api:3001.evil'],
        }),
      /explicitly allowlisted/,
    );
  });
});

describe('startTedRuntime transport wiring', () => {
  it('forwards the allowlisted internal origin to the finance transport', async () => {
    let seen = null;
    await assert.rejects(
      () =>
        startTedRuntime({
          env: {
            TED_API_BASE_URL: 'http://pi-finance-api:3001',
            TED_API_ALLOWED_ORIGINS: 'http://pi-finance-api:3001',
            TED_RUNTIME_HOME: 'C:\\Users\\walis\\AppData\\Local\\Temp\\opencode\\ted-transport-wiring',
          },
          deps: {
            HttpFinanceTransport: class {
              constructor(options) {
                seen = options;
              }
              call() {}
            },
            createTedEnvironment: async ({ transportFactory }) => {
              transportFactory();
              throw new Error('stop-after-transport');
            },
          },
        }),
      /stop-after-transport/,
    );
    assert.deepEqual(seen.allowedOrigins, ['http://pi-finance-api:3001']);
    assert.equal(seen.baseUrl, 'http://pi-finance-api:3001');
  });
});

describe('startTedRuntime host posture', () => {
  it('refuses a non-loopback listen host without the explicit opt-in', async () => {
    await assert.rejects(
      () =>
        startTedRuntime({
          env: {
            TED_GATEWAY_HOST: '0.0.0.0',
            TED_API_BASE_URL: 'http://127.0.0.1:9',
            TED_RUNTIME_HOME: 'C:\\Users\\walis\\AppData\\Local\\Temp\\opencode\\ted-host-gate',
            TED_GATEWAY_PORT: '0',
          },
          deps: {
            createTedEnvironment: async () => ({ dirs: { state: 'C:\\Users\\walis\\AppData\\Local\\Temp\\opencode\\ted-host-gate' } }),
          },
        }),
      /TED_GATEWAY_ALLOW_NON_LOOPBACK/,
    );
  });

  it('refuses a non-allowlisted API origin before any boot', async () => {
    await assert.rejects(
      () =>
        startTedRuntime({
          env: {
            TED_API_BASE_URL: 'http://evil:3001',
            TED_RUNTIME_HOME: 'C:\\Users\\walis\\AppData\\Local\\Temp\\opencode\\ted-origin-gate',
          },
          deps: {},
        }),
      /explicitly allowlisted/,
    );
  });
});
