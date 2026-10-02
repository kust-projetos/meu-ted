import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DEVICE_TOKEN_HEADER } from "../auth/device-token.js";
import type { AuthResolver } from "./auth.js";
import type { Pool } from "pg";
import { findDuplicate } from "../transactions/duplicate-detector.js";
import { createPool } from "../db/pool.js";
import { isoDateSchema as isoDate } from "../shared/iso-date.js";

export const detectSchema = z.object({
  kind: z.enum(["expense", "income", "transfer"]),
  description: z.string().min(1),
  amountCents: z.number().int().min(1),
  date: isoDate,
  accountId: z.string().uuid().optional(),
  fromAccountId: z.string().uuid().optional(),
  toAccountId: z.string().uuid().optional(),
  idempotencyKey: z.string().optional(),
});

export const registerDuplicateDetectRoutes = (
  app: FastifyInstance,
  opts: { resolveToken: AuthResolver; pool?: Pool }
): void => {
  const resolve = async (req: import("fastify").FastifyRequest) => {
    if (req.authenticatedContext) return req.authenticatedContext;
    const token = req.headers[DEVICE_TOKEN_HEADER];
    return opts.resolveToken(Array.isArray(token) ? token[0] : token);
  };

  app.post("/transactions/detect-duplicate", async (req, reply) => {
    let ctx;
    try {
      ctx = await resolve(req);
    } catch (e: any) {
      const status = e.statusCode ?? 401;
      return reply.code(status).send({ code: e.code ?? "auth.unauthorized", message: e.message });
    }
    const parsed = detectSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ code: "validation.error", issues: parsed.error.issues });

    // Duplicate state is unknown without a database; never report a negative.
    let pool = opts.pool;
    if (!pool && process.env.DATABASE_URL) {
      try {
        pool = createPool({ connectionString: process.env.DATABASE_URL });
      } catch {
        pool = undefined;
      }
    }
    if (!pool) {
      return reply.code(503).send({ code: "duplicate_detection_unavailable", message: "A verificação de duplicidade está indisponível." });
    }

    try {
      const match = await findDuplicate(pool, {
        householdId: ctx.householdId,
        kind: parsed.data.kind,
        description: parsed.data.description,
        amountCents: parsed.data.amountCents,
        date: parsed.data.date,
        accountId: parsed.data.accountId,
        fromAccountId: parsed.data.fromAccountId,
        toAccountId: parsed.data.toAccountId,
        idempotencyKey: parsed.data.idempotencyKey,
      });
      if (!match) return reply.code(200).send({ duplicate_detected: false });
      return reply.code(200).send({
        duplicate_detected: true,
        match: { id: match.id, description: match.description, amount_cents: match.amount_cents, date: match.date, match_type: match.match_type, similarity: match.similarity },
      });
    } catch (err) {
      req.log?.error?.(err);
      return reply.code(503).send({ code: "duplicate_detection_unavailable", message: "A verificação de duplicidade está indisponível." });
    }
  });
};
