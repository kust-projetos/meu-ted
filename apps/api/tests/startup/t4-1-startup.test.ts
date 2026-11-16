import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/env.js';
import { validateStartupConfig } from '../../src/server/startup-guard.js';
import { readFileSync } from 'node:fs';

const serverSource = readFileSync(new URL('../../src/server/index.ts', import.meta.url), 'utf8');

const productionEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://user:pass@db.example/pi',
  BETTER_AUTH_SECRET: 'production-secret-that-is-at-least-32-characters',
  BETTER_AUTH_URL: 'https://api.example.com',
  TRUSTED_ORIGINS: 'https://app.example.com',
  DEFAULT_HOUSEHOLD_ID: '11111111-1111-4111-8111-111111111111',
  ADMIN_EMAILS: 'admin@example.com',
  AGENT_CONNECTION_TOKEN_SECRET: 'connection-secret-that-is-at-least-32-chars',
  AGENT_CONFIG_TOKEN: 'config-token-that-is-at-least-32-characters',
  AGENT_AUTH_SERVICE_TOKEN: 'auth-token-that-is-at-least-32-characters',
  AGENT_RUNTIME_ORIGIN: 'https://agent.example.com',
  AGENT_RUNTIME_ADMIN_TOKEN: 'runtime-token-that-is-at-least-32-chars',
};

describe('T4.1 startup fail-closed', () => {
  it('rejects production when required secrets/origin/workspace are absent', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/production/i);
  });

  it('rejects localhost trusted origins in production', () => {
    expect(() => loadConfig({ ...productionEnv, TRUSTED_ORIGINS: 'http://localhost:3000' })).toThrow(/origin/i);
  });

  it('rejects missing database or incompatible schema before readiness', () => {
    expect(() => validateStartupConfig({
      authSecret: productionEnv.BETTER_AUTH_SECRET,
      databaseUrl: null,
      schemaValid: true,
    })).toThrow(/DATABASE_URL/i);
    expect(() => validateStartupConfig({
      authSecret: productionEnv.BETTER_AUTH_SECRET,
      databaseUrl: productionEnv.DATABASE_URL,
      schemaValid: false,
    })).toThrow(/schema/i);
  });

  it('keeps web startup verify-only and verifies schema before auth composition', () => {
    expect(serverSource).not.toMatch(/runMigrations\(/);
    expect(serverSource.indexOf('await verifySchema')).toBeGreaterThanOrEqual(0);
    expect(serverSource.indexOf('await verifySchema')).toBeLessThan(serverSource.indexOf('createBetterAuth({'));
  });
});

describe('loadConfig reads SMTP and invite settings from the given source only', () => {
  it('ignores process.env when an explicit source is passed', () => {
    const before = process.env.SMTP_HOST;
    process.env.SMTP_HOST = 'leak.example';
    try {
      expect(loadConfig({}).smtpHost).toBeNull();
      expect(loadConfig({ SMTP_HOST: 'mail.example', SMTP_PORT: '465' })).toMatchObject({ smtpHost: 'mail.example', smtpPort: 465, smtpSecure: true });
    } finally {
      if (before === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = before;
    }
  });
});
