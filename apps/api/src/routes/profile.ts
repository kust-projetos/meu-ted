import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEVICE_TOKEN_HEADER } from '../auth/device-token.js';
import { requireIdempotencyKey, httpIdempotencyPayload, type IdempotencyStore } from '../writes/idempotency.js';
import type { ProfileStore } from '../profile/store.js';
import type { AuthResolver } from './auth.js';

const patchInput = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  email: z.string().trim().email().max(120).or(z.literal('')).optional(),
  phone: z.string().trim().max(40).optional(),
  avatarColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  greetingStyle: z.enum(['auto', 'minimal', 'verbose']).optional(),
});

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export const registerProfileRoutes = (
  app: FastifyInstance,
  opts: { resolveToken: AuthResolver; profileStore: ProfileStore; idempotency?: IdempotencyStore; adminEmails?: string[]; resolveSessionEmail?: (headers: Headers) => Promise<string | undefined> },
): void => {
  // Server-computed admin flag, shared by GET and PATCH so both projections
  // stay consistent. A session that cannot be resolved yields an explicit
  // isAdmin=false (never undefined) — the PWA gate treats missing as false.
  const resolveSessionEmailAddress = async (req: { headers: Record<string, unknown> }): Promise<string | undefined> => {
    if (!opts.resolveSessionEmail) return undefined;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    return opts.resolveSessionEmail(headers).catch(() => undefined);
  };

  const resolveIsAdmin = async (req: { headers: Record<string, unknown> }): Promise<boolean> => {
    const email = await resolveSessionEmailAddress(req);
    return Boolean(opts.adminEmails?.some((admin) => admin.toLowerCase() === (email ?? '').toLowerCase()));
  };

  // Session-first context resolution (unified preHandler), device-token fallback.
  // The unified preHandler sets authenticatedContext for session/delegation
  // requests; legacy device-token clients resolve through the store below.
  const resolveRouteContext = async (
    req: { headers: Record<string, unknown>; authenticatedContext?: { householdId: string } },
  ): Promise<{ householdId: string } | { error: { statusCode?: number; code?: string; message?: string } }> => {
    if (req.authenticatedContext) {
      return { householdId: req.authenticatedContext.householdId };
    }
    const token = req.headers[DEVICE_TOKEN_HEADER];
    try {
      return await opts.resolveToken(Array.isArray(token) ? token[0] : token);
    } catch (e) {
      return { error: e as { statusCode?: number; code?: string; message?: string } };
    }
  };

  app.get('/profile', async (req, reply) => {
    const resolved = await resolveRouteContext(req);
    if ('error' in resolved) {
      const err = resolved.error;
      const status = err.statusCode ?? 500;
      return reply.code(status).send({
        code: err.code ?? (status >= 500 ? 'server.error' : 'auth.error'),
        message: err.message ?? (status >= 500 ? 'server error' : 'unauthorized'),
      });
    }
    const ctx = resolved;
    let existing = await opts.profileStore.get(ctx.householdId);
    // Auto-provision: a household whose device token is valid but has no profile
    // row yet (e.g. second device/personal household) would otherwise get
    // { profile: null } forever — and the client drops server flags like isAdmin
    // along with the null profile. When a session email resolved, seed a minimal
    // profile (email only; stores fill safe defaults) so the response carries the
    // real profile + isAdmin. Without a session we keep null (anonymous reads stay
    // read-only). Upsert failures fall back to null instead of 500ing the read.
    // Tradeoff (write-on-GET): one idempotent row write per unknown household;
    // the alternative — client PATCH on null — was rejected because every client
    // would need the same fallback and older cached PWAs would never recover.
    if (!existing) {
      const email = await resolveSessionEmailAddress(req);
      if (email) {
        existing = await opts.profileStore.upsert(ctx.householdId, { email }).catch(() => null);
      }
    }
    const isAdmin = await resolveIsAdmin(req);
    return reply.code(200).send({ profile: existing ? { ...existing, isAdmin } : null });
  });

  app.patch('/profile', async (req, reply) => {
    const resolved = await resolveRouteContext(req);
    if ('error' in resolved) {
      const err = resolved.error;
      const status = err.statusCode ?? 500;
      return reply.code(status).send({
        code: err.code ?? (status >= 500 ? 'server.error' : 'auth.error'),
        message: err.message ?? (status >= 500 ? 'server error' : 'unauthorized'),
      });
    }
    const ctx = resolved;

    const parsed = patchInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    }

    const data = parsed.data;
    // Defensive: zod's regex is already enforced, but keep a runtime check
    // for defense-in-depth since we'll likely evolve the schema.
    if (data.avatarColor && !HEX_COLOR.test(data.avatarColor)) {
      return reply.code(400).send({ code: 'validation.error', message: 'avatarColor must be #RRGGBB hex' });
    }

    const rawKey = req.headers['idempotency-key'] ?? req.headers['Idempotency-Key'];
    const key = rawKey !== undefined ? requireIdempotencyKey(req.headers) : undefined;
    const fn = async () => {
      const profile = await opts.profileStore.upsert(ctx.householdId, {
        name: data.name,
        email: data.email,
        phone: data.phone,
        avatarColor: data.avatarColor,
        greetingStyle: data.greetingStyle,
      });
      const isAdmin = await resolveIsAdmin(req);
      return { status: 200 as const, body: { profile: { ...profile, isAdmin } } };
    };

    try {
      const result = key && opts.idempotency
        ? await opts.idempotency.lookupOrRecord(ctx.householdId, key, httpIdempotencyPayload({ route: 'PATCH /profile' }, data), fn)
        : { response: await fn(), replayed: false };
      if (result.replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.code(result.response.status).send(result.response.body);
    } catch (e) {
      const err = e as { statusCode?: number; code?: string; message?: string };
      return reply.code(err.statusCode ?? 500).send({ code: err.code ?? 'server.error', message: err.message ?? 'server error' });
    }
  });
};

