import type { FastifyInstance } from 'fastify';

const isWellFormedOrigin = (value: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.pathname !== '' && parsed.pathname !== '/') return false;
  if (parsed.search !== '' || parsed.hash !== '') return false;
  return true;
};

const parseOrigins = (env: string): string[] =>
  env.split(',').map((s) => s.trim()).filter((s) => s !== '' && isWellFormedOrigin(s));

const LOCAL_DEVELOPMENT_ORIGINS = 'http://localhost:3000,http://127.0.0.1:3000';

const isOriginAllowed = (requestOrigin: string | undefined, allowed: string[]): string | null => {
  if (!requestOrigin) return null;
  const match = allowed.find((o) => o === requestOrigin);
  return match ?? null;
};

export const registerCors = (app: FastifyInstance): void => {
  const raw = process.env.CORS_ORIGIN ??
    (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test'
      ? LOCAL_DEVELOPMENT_ORIGINS
      : undefined);
  if (!raw) return;
  const allowed = parseOrigins(raw);
  if (allowed.length === 0) return;

  app.addHook('onRequest', async (req, reply) => {
    const matched = isOriginAllowed(req.headers.origin, allowed);
    if (matched) {
      reply.header('Access-Control-Allow-Origin', matched);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Access-Control-Expose-Headers', 'set-auth-token');
    }
  });

  app.options('*', async (req, reply) => {
    const matched = isOriginAllowed(req.headers.origin, allowed);
    if (matched) {
      reply.header('Access-Control-Allow-Origin', matched);
      reply.header('Access-Control-Allow-Credentials', 'true');
    }
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, X-Device-Token, Idempotency-Key, Accept, Authorization, X-Workspace-Id');
    reply.header('Access-Control-Expose-Headers', 'set-auth-token');
    return reply.code(204).send();
  });
};
