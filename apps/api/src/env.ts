/**
 * Env loading for pi-finance-api.
 *
 * DATABASE_URL is optional in V1 (in-memory is the dev/test fallback).
 * When set, the API uses Postgres. Same env shape works in dev, test,
 * and prod. Connection string parsing is delegated to node-postgres.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const loadDotEnv = (): void => {
  // Tiny .env loader: KEY=VALUE, # comments, blank lines. No escaping.
  // Intentionally minimal — we don't add dotenv as a dep for one file.
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    join(dir, '..', '.env'),
    join(dir, '..', '..', '.env'),
    process.cwd() + '/.env',
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    break;
  }
};
loadDotEnv();

export type AppConfig = {
  port: number;
  host: string;
  databaseUrl: string | null;
  defaultHouseholdId: string;
  betterAuthSecret: string;
  betterAuthUrl: string;
  trustedOrigins: string[];
  disableSignUp: boolean;
  disableDeviceRegistration: boolean;
  adminEmails: string[];
  agentConnectionSecret: string;
  agentConfigToken: string;
  agentAuthServiceToken: string;
  agentRuntimeOrigin: string;
  agentRuntimeAdminToken: string;
  inviteDeliveryUrl: string | null;
  inviteDeliveryToken: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  smtpPass: string | null;
  smtpFrom: string | null;
  smtpSecure: boolean;
  inviteAcceptUrl: string | null;
};

export const loadConfig = (source: NodeJS.ProcessEnv = process.env): AppConfig => {
  const production = source.NODE_ENV === 'production';
  const requiredProduction = (name: string): string => {
    const value = source[name]?.trim();
    if (!value) throw new Error(`FATAL: ${name} is required in production; refusing to start with unsafe defaults.`);
    return value;
  };
  const requiredProductionSecret = (name: string): string => {
    const value = requiredProduction(name);
    if (value.length < 32 || /^dev[-_]/i.test(value)) {
      throw new Error(`FATAL: ${name} must be a non-development secret of at least 32 characters in production.`);
    }
    return value;
  };
  const port = Number(source.PORT ?? 3001);
  const host = source.HOST ?? '0.0.0.0';
  const databaseUrl = production ? requiredProduction('DATABASE_URL') : (source.DATABASE_URL?.trim() || null);
  const defaultHouseholdId = production ? requiredProduction('DEFAULT_HOUSEHOLD_ID') : (source.DEFAULT_HOUSEHOLD_ID?.trim() || '11111111-1111-4111-8111-111111111111');
  const betterAuthSecret = production ? requiredProductionSecret('BETTER_AUTH_SECRET') : (source.BETTER_AUTH_SECRET?.trim() || 'pi-financeiro-dev-secret-at-least-32-chars!');
  const betterAuthUrl = source.BETTER_AUTH_URL?.trim() || source.API_BASE_URL?.trim() || (production ? requiredProduction('BETTER_AUTH_URL') : `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  // Non-production placeholder defaults (DEBT2 origin migration): production
  // REQUIRES TRUSTED_ORIGINS env fail-closed above, so these never serve
  // production traffic — they only let dev/test boot without env.
  const defaultOrigins = [
    'https://pwa.example',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3001',
  ];
  const envOrigins = source.TRUSTED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean);
  const trustedOrigins = production ? (envOrigins && envOrigins.length > 0 ? envOrigins : (() => { throw new Error('FATAL: TRUSTED_ORIGINS is required in production; refusing to start.'); })()) : (envOrigins && envOrigins.length > 0 ? envOrigins : defaultOrigins);
  if (production) {
    for (const origin of trustedOrigins) {
      let parsed: URL;
      try { parsed = new URL(origin); } catch { throw new Error(`FATAL: invalid trusted origin in production: ${origin}`); }
      if (parsed.protocol !== 'https:' || /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(parsed.hostname)) {
        throw new Error(`FATAL: insecure trusted origin in production: ${origin}`);
      }
    }
    if (new URL(betterAuthUrl).protocol !== 'https:') throw new Error('FATAL: BETTER_AUTH_URL must use HTTPS in production.');
  }
  const disableSignUp = source.DISABLE_SIGN_UP !== 'false';
  const disableDeviceRegistration = source.DISABLE_DEVICE_REGISTRATION !== 'false';
  // Non-production placeholder (DEBT2): production requires ADMIN_EMAILS env.
  const adminEmails = (production ? requiredProduction('ADMIN_EMAILS') : (source.ADMIN_EMAILS ?? 'admin@example.com'))
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const smtpHost = source.SMTP_HOST?.trim() || null;
  const smtpPortRaw = source.SMTP_PORT?.trim();
  const smtpPort = smtpPortRaw ? Number(smtpPortRaw) : null;
  const smtpUser = source.SMTP_USER?.trim() || null;
  const smtpPass = source.SMTP_PASS?.trim() || null;
  const smtpFrom = source.SMTP_FROM?.trim() || null;
  const smtpSecure = source.SMTP_SECURE?.trim().toLowerCase() === 'true' || (smtpPort === 465);
  const rawInviteAcceptUrl = source.INVITE_ACCEPT_URL?.trim() || null;
  const pwaOrigin = source.PWA_ORIGIN?.trim() || null;
  const inviteAcceptUrl = rawInviteAcceptUrl ?? (pwaOrigin ? `${pwaOrigin.replace(/\/$/, '')}/convite` : null);

  return {
    port,
    host,
    databaseUrl,
    defaultHouseholdId,
    betterAuthSecret,
    betterAuthUrl,
    trustedOrigins,
    disableSignUp,
    disableDeviceRegistration,
    adminEmails,
    agentConnectionSecret: production ? requiredProductionSecret('AGENT_CONNECTION_TOKEN_SECRET') : (source.AGENT_CONNECTION_TOKEN_SECRET?.trim() || 'dev-agent-connection-secret-at-least-32-chars!'),
    agentConfigToken: production ? requiredProductionSecret('AGENT_CONFIG_TOKEN') : (source.AGENT_CONFIG_TOKEN?.trim() || 'dev-agent-config-token-32-chars-minimum!'),
    agentAuthServiceToken: production ? requiredProductionSecret('AGENT_AUTH_SERVICE_TOKEN') : (source.AGENT_AUTH_SERVICE_TOKEN?.trim() || 'dev-agent-auth-service-token-32-chars!'),
    agentRuntimeOrigin: production ? requiredProduction('AGENT_RUNTIME_ORIGIN') : (source.AGENT_RUNTIME_ORIGIN?.trim() || 'https://agent.example'),
    agentRuntimeAdminToken: production ? requiredProductionSecret('AGENT_RUNTIME_ADMIN_TOKEN') : (source.AGENT_RUNTIME_ADMIN_TOKEN?.trim() || 'dev-agent-runtime-admin-token-32-chars!'),
    inviteDeliveryUrl: source.INVITE_DELIVERY_URL?.trim() || null,
    inviteDeliveryToken: source.INVITE_DELIVERY_TOKEN?.trim() || null,
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass,
    smtpFrom,
    smtpSecure,
    inviteAcceptUrl,
  };
};
