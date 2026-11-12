import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEVICE_TOKEN_HEADER } from '../auth/device-token.js';
import type { ReadModelStore } from '../read-models/store.js';
import { buildDashboardSummary } from '../lib/dashboard.js';
import { buildQuickInsights } from '../lib/insights.js';
import type { AuthResolver } from './auth.js';
import type { PayableStore } from '../payables/store.js';
import type { CardStore } from '../cards/store.js';
import { computePaymentScore, parsePeriodQuery } from '../insights/payment-score.js';
import { computeInstallmentScore, parseMonthQuery } from '../insights/installment-score.js';
import { computeMonthlyProjection, parseYearMonthQuery } from '../insights/monthly-projection.js';
import { buildSpendingInsights } from '../lib/spending-insights.js';

export const spendingInsightQuerySchema = z.object({
  yearMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  insightType: z.enum(['all', 'comparison', 'anomalies', 'income-share']).optional(),
  lookbackMonths: z.coerce.number().int().min(1).max(12).optional(),
});

export const registerInsightRoutes = (
  app: FastifyInstance,
  opts: { store: ReadModelStore; resolveToken: AuthResolver; payableStore?: PayableStore; cardStore?: CardStore; clock?: () => Date },
): void => {
  app.get('/insights/quick', async (req, reply) => {
    // auth: prefer already-resolved context (better-auth / delegation), fallback to device token
    let ctx: Awaited<ReturnType<AuthResolver>>;
    if ((req as any).authenticatedContext) {
      ctx = (req as any).authenticatedContext;
    } else {
      const token = req.headers[DEVICE_TOKEN_HEADER];
      try { ctx = await opts.resolveToken(Array.isArray(token) ? token[0] : token); }
      catch (e) {
        const err = e as { statusCode?: number; code?: string; message?: string };
        return reply.code(err.statusCode ?? 401).send({ code: err.code ?? 'auth.error', message: err.message ?? 'unauthorized' });
      }
    }
    const [accounts, categories, transactions] = await Promise.all([
      opts.store.listAccounts(ctx.householdId),
      opts.store.listCategories(ctx.householdId),
      opts.store.listAllTransactions(ctx.householdId),
    ]);
    return reply.code(200).send({ items: buildQuickInsights(buildDashboardSummary(ctx.householdId, accounts, categories, transactions)) });
  });

  app.get('/insights/spending', async (req, reply) => {
    // auth: prefer already-resolved context, fallback to device token
    let ctx: Awaited<ReturnType<AuthResolver>>;
    if ((req as any).authenticatedContext) {
      ctx = (req as any).authenticatedContext;
    } else {
      const token = req.headers[DEVICE_TOKEN_HEADER];
      try { ctx = await opts.resolveToken(Array.isArray(token) ? token[0] : token); }
      catch (e) {
        const err = e as { statusCode?: number; code?: string; message?: string };
        return reply.code(err.statusCode ?? 401).send({ code: err.code ?? 'auth.error', message: err.message ?? 'unauthorized' });
      }
    }
    const parsed = spendingInsightQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    }
    const [transactions, categories] = await Promise.all([
      opts.store.listAllTransactions(ctx.householdId),
      opts.store.listCategories(ctx.householdId),
    ]);
    const now = opts.clock?.() ?? new Date();
    const yearMonth = parsed.data.yearMonth ?? now.toISOString().slice(0, 7);
    const insightType = parsed.data.insightType ?? 'all';
    const lookbackMonths = parsed.data.lookbackMonths ?? 3;
    const result = buildSpendingInsights(transactions, categories, yearMonth, insightType, lookbackMonths);
    const incomeCents = transactions.reduce(
      (sum, transaction) => sum + (transaction.kind === 'income' && transaction.date.slice(0, 7) === yearMonth ? transaction.amountCents : 0),
      0,
    );
    const insights = [
      ...(result.comparisons ?? []).map((comparison) => ({
        type: 'category-comparison',
        category: comparison.category,
        currentCents: comparison.currentCents,
        averageCents: comparison.previousCents,
        deltaCents: comparison.absoluteChange,
        deltaPercent: comparison.percentChange,
        trend: comparison.trend,
      })),
      ...(result.anomalies ?? []).map((anomaly) => ({
        type: 'anomaly',
        category: anomaly.category,
        message: anomaly.message,
        currentCents: anomaly.currentCents,
        averageTransactionCents: anomaly.previousCents,
        deltaPercent: anomaly.percentChange,
      })),
      ...(result.incomeShare ?? []).map((share) => ({
        type: 'income-share',
        category: share.category,
        expenseCents: share.totalCents,
        incomeCents,
        sharePercent: share.sharePercent,
      })),
    ];
    // message reflects only original trend insights; transactionCount covers the household's full history, not this period.
    return reply.code(200).send({
      success: true,
      yearMonth,
      basis: 'competencia',
      lookbackMonths,
      insights,
      transactionCount: transactions.length,
      message: result.message,
    });
  });

  app.get('/insights/payment-score', async (req, reply) => {
    // auth: prefer already-resolved context (better-auth / delegation), fallback to device token
    let ctx: Awaited<ReturnType<AuthResolver>>;
    if ((req as any).authenticatedContext) {
      ctx = (req as any).authenticatedContext;
    } else {
      const token = req.headers[DEVICE_TOKEN_HEADER];
      try {
        ctx = await opts.resolveToken(Array.isArray(token) ? token[0] : token);
      } catch (e) {
        const err = e as { statusCode?: number; code?: string; message?: string };
        return reply.code(err.statusCode ?? 401).send({ code: err.code ?? 'auth.error', message: err.message ?? 'unauthorized' });
      }
    }

    const parsedPeriod = parsePeriodQuery((req.query ?? {}) as Record<string, unknown>);
    if ('error' in parsedPeriod) {
      // Use Zod-style validation.error for consistency
      return reply.code(400).send({
        code: 'validation.error',
        issues: [{ path: ['period'], message: parsedPeriod.error }],
      });
    }

    const { periodDays, periodLabel } = parsedPeriod;

    // fetch payables - requires payableStore; if not provided, treat as empty (no error, score 0)
    let payables: import('../types/domain.js').Payable[] = [];
    if (opts.payableStore) {
      try {
        payables = await opts.payableStore.listPayables(ctx.householdId);
      } catch {
        payables = [];
      }
    }

    const now = opts.clock ? opts.clock() : new Date();
    const result = computePaymentScore(payables, { periodDays, now });

    return reply.code(200).send({
      score: result.score,
      onTimeCount: result.onTimeCount,
      totalCount: result.totalCount,
      period: periodLabel,
    });
  });

  app.get('/insights/installment-score', async (req, reply) => {
    // auth: prefer already-resolved context, fallback to device token
    let ctx: Awaited<ReturnType<AuthResolver>>;
    if ((req as any).authenticatedContext) {
      ctx = (req as any).authenticatedContext;
    } else {
      const token = req.headers[DEVICE_TOKEN_HEADER];
      try {
        ctx = await opts.resolveToken(Array.isArray(token) ? token[0] : token);
      } catch (e) {
        const err = e as { statusCode?: number; code?: string; message?: string };
        return reply.code(err.statusCode ?? 401).send({ code: err.code ?? 'auth.error', message: err.message ?? 'unauthorized' });
      }
    }

    const parsedMonth = parseMonthQuery((req.query ?? {}) as Record<string, unknown>);
    if ('error' in parsedMonth) {
      return reply.code(400).send({
        code: 'validation.error',
        issues: [{ path: ['month'], message: parsedMonth.error }],
      });
    }
    const { month } = parsedMonth;

    // Collect installments for household/month.
    // Priority: cardStore (statements + purchases) -> fallback to store transactions em memória.
    let rawPurchases: Array<{ date: string; status?: string; statementStatus?: string }> = [];

    if (opts.cardStore) {
      try {
        const statements = await opts.cardStore.listStatements(ctx.householdId);
        for (const s of statements) {
          try {
            const detail = await opts.cardStore.getStatementDetail(ctx.householdId, s.id);
            if (!detail) continue;
            for (const p of detail.purchases) {
              rawPurchases.push({ date: p.date, status: s.status, statementStatus: s.status });
            }
          } catch {
            // ignore single statement failure
          }
        }
      } catch {
        rawPurchases = [];
      }
      // Fallback to transactions if no statement-derived purchases but transactions exist for month
      if (rawPurchases.length === 0) {
        try {
          const txs = await opts.store.listAllTransactions(ctx.householdId);
          const mapped = txs.map((t) => ({ date: t.date, status: 'open' as const }));
          // only use fallback if there is at least one tx in the requested month (avoid polluting zero case with old demo data)
          if (mapped.some((m) => m.date.slice(0, 7) === month)) {
            rawPurchases = mapped;
          }
        } catch {
          // keep empty
        }
      }
    } else {
      // No cardStore available: use in-memory transactions as parcelas
      try {
        const txs = await opts.store.listAllTransactions(ctx.householdId);
        rawPurchases = txs.map((t) => ({ date: t.date, status: 'open' as const }));
      } catch {
        rawPurchases = [];
      }
    }

    const result = computeInstallmentScore(rawPurchases, month);
    return reply.code(200).send({
      score: result.score,
      month: result.month,
      installments: {
        total: result.total,
        paid: result.paid,
        overdue: result.overdue,
        score: result.score,
      },
    });
  });

  app.get('/insights/monthly-projection', async (req, reply) => {
    let ctx: Awaited<ReturnType<AuthResolver>>;
    if ((req as any).authenticatedContext) {
      ctx = (req as any).authenticatedContext;
    } else {
      const token = req.headers[DEVICE_TOKEN_HEADER];
      try {
        ctx = await opts.resolveToken(Array.isArray(token) ? token[0] : token);
      } catch (e) {
        const err = e as { statusCode?: number; code?: string; message?: string };
        return reply.code(err.statusCode ?? 401).send({ code: err.code ?? 'auth.error', message: err.message ?? 'unauthorized' });
      }
    }

    const parsed = parseYearMonthQuery((req.query ?? {}) as Record<string, unknown>);
    if ('error' in parsed) {
      return reply.code(400).send({
        code: 'validation.error',
        issues: [{ path: ['yearMonth'], message: parsed.error }],
      });
    }
    const { yearMonth } = parsed;

    let transactions: import('../types/domain.js').Transaction[] = [];
    try {
      transactions = await opts.store.listAllTransactions(ctx.householdId);
    } catch {
      transactions = [];
    }

    let payables: import('../types/domain.js').Payable[] = [];
    if (opts.payableStore) {
      try {
        payables = await opts.payableStore.listPayables(ctx.householdId);
      } catch {
        payables = [];
      }
    }

    const clock = opts.clock ?? (() => new Date());
    const result = computeMonthlyProjection(transactions, payables, yearMonth, clock);

    return reply.code(200).send(result);
  });
};

