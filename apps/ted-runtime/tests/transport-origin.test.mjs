import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HttpFinanceTransport } from '../src/transport.mjs';

describe('transport internal-origin allowlist', () => {
  it('loopback works without an allowlist', () => {
    assert.doesNotThrow(() => new HttpFinanceTransport({ baseUrl: 'http://127.0.0.1:3001' }));
  });

  it('an allowlisted internal origin is accepted', () => {
    assert.doesNotThrow(
      () =>
        new HttpFinanceTransport({
          baseUrl: 'http://pi-finance-api:3001',
          allowedOrigins: ['http://pi-finance-api:3001'],
        }),
    );
  });

  it('a non-allowlisted origin is refused before any request', () => {
    assert.throws(
      () => new HttpFinanceTransport({ baseUrl: 'http://pi-finance-api:3001' }),
      /loopback or an explicitly allowlisted internal origin/,
    );
    assert.throws(
      () =>
        new HttpFinanceTransport({
          baseUrl: 'http://evil:3001',
          allowedOrigins: ['http://pi-finance-api:3001'],
        }),
      /explicitly allowlisted/,
    );
  });

  it('the allowlist never admits a path-bearing base (route diversion)', () => {
    assert.throws(
      () =>
        new HttpFinanceTransport({
          baseUrl: 'http://pi-finance-api:3001/api',
          allowedOrigins: ['http://pi-finance-api:3001'],
        }),
      /bare origin/,
    );
  });
});
