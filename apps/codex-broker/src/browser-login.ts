import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AuthCacheManager } from './auth-status.js';

export const LoginBeginSchema = z
  .object({ callbackUrl: z.string().trim().url().max(500).optional() })
  .strict();

export const LoginCallbackSchema = z
  .object({
    code: z.string().trim().min(4).max(500),
    state: z.string().trim().min(8).max(128).optional(),
  })
  .strict();

export type CodeExchangeResult = {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  email?: string;
};

export type PendingLogin = {
  state: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
};

export const LOGIN_TTL_MS = 10 * 60_000;

/**
 * Bound on concurrent pending browser logins (BRK-02, T12e). The operator
 * flow creates entries one human at a time; the cap keeps a burst of
 * unfinished logins from growing the in-memory map without bound.
 */
export const MAX_PENDING_LOGINS = 100;

/** Injectable wall clock (BRK-02): defaults to Date.now, tests inject fakes. */
export type BrowserLoginClock = () => number;

const systemClock: BrowserLoginClock = () => Date.now();

const newUserCode = (): string => {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const pick = () => alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${pick()}${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}${pick()}`;
};

/**
 * Minimal viable browser login (refactor item 6): the operator starts a login
 * on the broker, completes authorization in the browser (ChatGPT Coding plan,
 * same flow as pi dev / opencode), and the broker persists the resulting
 * session via the atomic 0600 cache write. Tokens NEVER appear in logs or
 * responses — only the opaque state/userCode travel the wire.
 *
 * The real ChatGPT OAuth exchange is injected (`exchangeCode`); the default
 * rejects with `exchange_not_configured` so a bare broker cannot pretend a
 * login succeeded. Tests and ops tooling inject the real exchange.
 */
export class BrowserLoginManager {
  private readonly pending = new Map<string, PendingLogin>();

  constructor(
    private readonly authManager: AuthCacheManager,
    private readonly exchangeCode: (code: string) => Promise<CodeExchangeResult> = async () => {
      throw new Error('exchange_not_configured');
    },
    private readonly clock: BrowserLoginClock = systemClock,
  ) {}

  beginLogin(callbackUrl?: string): PendingLogin {
    this.purgeExpired();
    if (this.pending.size >= MAX_PENDING_LOGINS) {
      throw Object.assign(new Error('pending login store is full'), {
        statusCode: 429,
        code: 'login_pending_limit_exceeded',
      });
    }
    const state = randomUUID().replace(/-/g, '');
    const deviceCode = randomUUID().replace(/-/g, '');
    const login: PendingLogin = {
      state,
      deviceCode,
      userCode: newUserCode(),
      verificationUri: `https://chatgpt.com/auth/login?state=${encodeURIComponent(state)}${
        callbackUrl ? `&callback=${encodeURIComponent(callbackUrl)}` : ''
      }`,
      expiresAt: this.clock() + LOGIN_TTL_MS,
    };
    this.pending.set(state, login);
    return login;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /** Drop expired entries using the injected clock; returns the swept count. */
  purgeExpired(now: number = this.clock()): number {
    let purged = 0;
    for (const [key, login] of this.pending) {
      if (now >= login.expiresAt) {
        this.pending.delete(key);
        purged += 1;
      }
    }
    return purged;
  }

  async completeLogin(code: string, state?: string): Promise<{ email?: string; expiresAt?: number }> {
    let login: PendingLogin | undefined;
    if (state) {
      login = this.pending.get(state);
      if (!login) throw Object.assign(new Error('unknown login state'), { statusCode: 400, code: 'login_unknown_state' });
      // Single consumption (BRK-02): claim the entry before the exchange so
      // a repeated callback with the same state cannot re-execute it. A
      // failed exchange consumes the login — the operator begins a new one.
      this.pending.delete(state);
      if (this.clock() >= login.expiresAt) {
        throw Object.assign(new Error('login session expired'), { statusCode: 410, code: 'login_expired' });
      }
    }
    // The opaque code is exchanged server-side; it is never logged or stored.
    const exchanged = await this.exchangeCode(code);
    if (!exchanged.accessToken || exchanged.accessToken.trim() === '') {
      throw Object.assign(new Error('code exchange returned no token'), { statusCode: 502, code: 'login_exchange_failed' });
    }
    this.authManager.saveAuthCacheAtomic({
      accessToken: exchanged.accessToken,
      ...(exchanged.refreshToken ? { refreshToken: exchanged.refreshToken } : {}),
      ...(typeof exchanged.expiresIn === 'number' ? { expiresAt: this.clock() + exchanged.expiresIn * 1000 } : {}),
      ...(exchanged.email ? { email: exchanged.email } : {}),
    });
    const status = this.authManager.getAuthStatus();
    return { ...(status.email ? { email: status.email } : {}), ...(status.expiresAt ? { expiresAt: status.expiresAt } : {}) };
  }

  revokeLocalSession(): void {
    this.authManager.saveAuthCacheAtomic({ reauthRequired: true });
  }
}
