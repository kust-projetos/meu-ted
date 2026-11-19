import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { admin, bearer } from 'better-auth/plugins';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

export type BetterAuthConfig = {
  databaseUrl?: string;
  pool?: Pool;
  database?: NonNullable<BetterAuthOptions['database']>;
  advanced?: BetterAuthOptions['advanced'];
  disableSignUp?: boolean;
  transaction?: boolean;
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  sessionExpiresIn?: number;
};

type BetterAuthDatabase = Record<string, Record<string, unknown>>;

export type BetterAuthSessionContext = {
  userId: string;
  sessionId: string;
  email: string;
};

export const getBetterAuthSessionContext = async (
  auth: ReturnType<typeof createBetterAuth>,
  headers: Headers,
): Promise<BetterAuthSessionContext | undefined> => {
  const session = await auth.api.getSession({ headers });
  if (!session) return undefined;
  return {
    userId: session.user.id,
    sessionId: session.session.id,
    email: session.user.email,
  };
};

export const createBetterAuth = (config: BetterAuthConfig) => {
  const pool = config.database ? undefined : config.pool ?? new Pool({ connectionString: config.databaseUrl });
  const database = config.database ?? new Kysely<BetterAuthDatabase>({
    dialect: new PostgresDialect({ pool: pool! }),
  });
  const auth = betterAuth({
    appName: 'Pi Financeiro',
    baseURL: config.baseURL,
    basePath: '/auth',
    secret: config.secret,
    trustedOrigins: config.trustedOrigins,
    advanced: {
      useSecureCookies: config.baseURL.startsWith('https://'),
      disableCSRFCheck: false,
      defaultCookieAttributes: {
        httpOnly: true,
        // Production PWA and API are cross-site; Secure is required by None.
        sameSite: config.baseURL.startsWith('https://') ? 'none' : 'lax',
        secure: config.baseURL.startsWith('https://'),
      },
      ...(config.advanced ?? {}),
    },
    database: config.database ?? {
      db: database,
      type: 'postgres',
      casing: 'snake',
      transaction: config.transaction ?? true,
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: config.disableSignUp ?? true,
    },
    plugins: [
      admin(),
      bearer(),
    ],
    session: {
      expiresIn: config.sessionExpiresIn ?? 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
  });

  return Object.assign(auth, {
    close: async () => {
      if (database instanceof Kysely) await database.destroy();
      if (pool && !config.pool) await pool.end();
    },
  });
};

export type BetterAuth = ReturnType<typeof createBetterAuth>;
