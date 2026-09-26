import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { DEVICE_TOKEN_HEADER } from "../auth/device-token.js";
import type { AuthenticatedContext } from "../auth/request-context.js";
import type { IdempotencyStore } from "../writes/idempotency.js";
import { httpIdempotencyPayload } from "../writes/idempotency.js";
import { domainErrors } from "../writes/errors.js";
import type { PushSubscriptionStore } from "../push/store.js";
import type { PushDelivery, PushPayload } from "../push/delivery.js";
import type { AdoptionStore } from "../observability/adoption.js";
import type { AuthResolver } from "./auth.js";

const subscriptionSchema = z.object({
  endpoint: z
    .string()
    .url()
    .refine((value) => value.startsWith("https://"), "endpoint must use HTTPS"),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
  userAgent: z.string().trim().max(512).optional(),
});

const removeSubscriptionSchema = z.object({
  endpoint: z
    .string()
    .url()
    .refine((value) => value.startsWith("https://"), "endpoint must use HTTPS"),
});

const pushNotificationSchema = z.object({
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().max(240).optional(),
  url: z
    .string()
    .regex(/^\/(?!\/)/)
    .optional(),
});

const requireIdempotencyKey = (headers: FastifyRequest["headers"]): string => {
  const value = headers["idempotency-key"];
  if (typeof value !== "string" || !value.trim())
    throw domainErrors.required("idempotency-key");
  return value.trim();
};

type PushAuth = AuthenticatedContext & { ownerId: string };

const resolveAuth = async (
  req: FastifyRequest,
  resolveToken: AuthResolver,
): Promise<PushAuth> => {
  if (req.authenticatedContext) {
    const ctx = req.authenticatedContext;
    return { ...ctx, ownerId: ctx.authUserId ?? ctx.deviceId };
  }
  const token = req.headers[DEVICE_TOKEN_HEADER];
  const resolved = await resolveToken(Array.isArray(token) ? token[0] : token);
  const ownerId = resolved.userId ?? resolved.deviceId;
  return {
    householdId: resolved.householdId,
    actorId: resolved.deviceId,
    actorType: "device",
    deviceId: resolved.deviceId,
    ownerId,
  };
};

const handleError = (error: unknown, reply: FastifyReply) => {
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === "number") {
    return reply.code(statusCode).send({
      code: (error as { code?: string }).code ?? "auth.error",
      message: (error as Error).message,
    });
  }
  throw error;
};

const publicSubscription = (row: {
  id: string;
  endpoint: string;
  active?: boolean;
  userAgent?: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}) => ({
  id: row.id,
  endpoint: row.endpoint,
  active: row.active ?? true,
  ...(row.userAgent ? { userAgent: row.userAgent } : {}),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});



export const registerPushRoutes = (
  app: FastifyInstance,
  opts: {
    pushStore: PushSubscriptionStore;
    idempotency: IdempotencyStore;
    resolveToken: AuthResolver;
    vapidPublicKey?: string;
    delivery?: PushDelivery;
    adoption?: AdoptionStore;
  },
): void => {
  app.get("/push/vapid-public-key", async (req, reply) => {
    try {
      await resolveAuth(req, opts.resolveToken);
    } catch (error) {
      return handleError(error, reply);
    }
    const publicKey = opts.vapidPublicKey?.trim();
    if (!publicKey)
      return reply.code(503).send({ code: "push.vapid_unavailable" });
    return reply.code(200).send({ publicKey });
  });

  app.post("/push/subscriptions", async (req, reply) => {
    let ctx: PushAuth;
    try {
      ctx = await resolveAuth(req, opts.resolveToken);
    } catch (error) {
      return handleError(error, reply);
    }

    const parsed = subscriptionSchema.safeParse(req.body ?? {});
    if (!parsed.success)
      return reply
        .code(400)
        .send({ code: "validation.error", issues: parsed.error.issues });
    try {
      const key = requireIdempotencyKey(req.headers);
      const result = await opts.idempotency.lookupOrRecord(
        ctx.householdId,
        key,
        httpIdempotencyPayload({ route: 'POST /push/subscriptions' }, parsed.data),
        async () => ({
          status: 201 as const,
          body: publicSubscription(
            await opts.pushStore.upsert({
              workspaceId: ctx.householdId,
              userId: ctx.ownerId,
              endpoint: parsed.data.endpoint,
              p256dh: parsed.data.keys.p256dh,
              auth: parsed.data.keys.auth,
              ...(parsed.data.userAgent
                ? { userAgent: parsed.data.userAgent }
                : {}),
            }),
          ),
        }),
      );
      if (result.replayed) reply.header("Idempotent-Replayed", "true");
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/push/notifications", async (req, reply) => {
    let ctx: PushAuth;
    try {
      ctx = await resolveAuth(req, opts.resolveToken);
    } catch (error) {
      return handleError(error, reply);
    }

    if (!opts.delivery)
      return reply.code(503).send({ code: "push.delivery_unavailable" });
    const parsed = pushNotificationSchema.safeParse(req.body ?? {});
    if (!parsed.success)
      return reply
        .code(400)
        .send({ code: "validation.error", issues: parsed.error.issues });
    try {
      const payload: PushPayload = {
        title: parsed.data.title,
        ...(parsed.data.body ? { body: parsed.data.body } : {}),
        ...(parsed.data.url ? { url: parsed.data.url as `/${string}` } : {}),
      };
      const key = requireIdempotencyKey(req.headers);
      const result = await opts.idempotency.lookupOrRecord(
        ctx.householdId,
        key,
        httpIdempotencyPayload({ route: 'POST /push/notifications' }, payload),
        async () => {
          const body = await opts.delivery!.sendToWorkspace(
            ctx.householdId,
            payload,
            key,
          );
          if (body.sent > 0) {
            await opts.adoption?.record({
              workspaceId: ctx.householdId,
              actorId: ctx.actorId,
              eventType: "notification_delivered",
              occurredAt: new Date(),
              dedupeKey: `push:${key}`,
            });
          }
          return { status: 202 as const, body };
        },
      );
      if (result.replayed) reply.header("Idempotent-Replayed", "true");
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.delete("/push/subscriptions", async (req, reply) => {
    let ctx: PushAuth;
    try {
      ctx = await resolveAuth(req, opts.resolveToken);
    } catch (error) {
      return handleError(error, reply);
    }

    const parsed = removeSubscriptionSchema.safeParse(req.body ?? {});
    if (!parsed.success)
      return reply
        .code(400)
        .send({ code: "validation.error", issues: parsed.error.issues });
    try {
      const key = requireIdempotencyKey(req.headers);
      const result = await opts.idempotency.lookupOrRecord(
        ctx.householdId,
        key,
        httpIdempotencyPayload({ route: 'DELETE /push/subscriptions' }, parsed.data),
        async () => {
          const removed = await opts.pushStore.remove(
            ctx.householdId,
            ctx.ownerId,
            parsed.data.endpoint,
          );
          if (!removed)
            return {
              status: 404 as const,
              body: { code: "push.subscription_not_found" },
            };
          return { status: 204 as const, body: undefined };
        },
      );
      if (result.replayed) reply.header("Idempotent-Replayed", "true");
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return handleError(error, reply);
    }
  });
};
