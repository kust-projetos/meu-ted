/**
 * In-memory implementation of CardStore.
 *
 * Works with the same InMemoryState used by the rest of the app.
 * Statement IDs use deterministic UUIDs based on cycle+account so
 * multiple purchases in the same cycle find the same statement.
 */

import { randomUUID, createHash } from 'node:crypto';
import type { Account, Transaction, Statement, StatementPurchase, RecurringPurchase } from '../types/domain.js';

interface CardPurchase {
  id: string;
  householdId: string;
  statementId: string;
  description: string;
  amountCents: number;
  date: string;
  categoryId?: string;
  categoryName?: string;
  subcategoryId?: string;
  notes?: string;
  installmentsTotal?: number;
  installmentNumber?: number;
  isRecurring?: boolean;
  transactionId?: string;
}
import type { CardStore } from './store.js';
import type { InMemoryState } from '../writes/in-memory.js';
import { resolveSubcategory } from '../writes/in-memory.js';
import { domainErrors } from '../writes/errors.js';
import { CARD_EXPENSE_KIND_MESSAGE, resolveCategoryForWrite } from '../categories/resolve.js';
import { installmentDates } from '../shared/billing-month.js';
import { splitInstallmentAmounts } from './installments.js';

function stableId(prefix: string, accountId: string, cycle: string): string {
  const h = createHash('sha256').update(`${prefix}:${accountId}:${cycle}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function getClosingDate(purchaseDate: string, closingDay: number): string {
  const d = new Date(purchaseDate + 'T00:00:00.000Z');
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  if (d.getUTCDate() > closingDay) { m += 1; if (m > 11) { m = 0; y += 1; } }
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(closingDay, lastDay);
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function getDueDate(closingDate: string, dueDay: number): string {
  const d = new Date(closingDate + 'T00:00:00.000Z');
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  const cDay = d.getUTCDate();
  if (dueDay <= cDay) { m += 1; if (m > 11) { m = 0; y += 1; } }
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(dueDay, lastDay);
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function cycleYearMonth(closingDate: string): string {
  return closingDate.slice(0, 7);
}

function computeStatus(s: Statement, today: string): Statement['status'] {
  if (s.status === 'cancelled') return 'cancelled';
  if (s.paidCents >= s.totalCents) return 'paid';
  if (s.paidCents > 0 && today > s.dueDate) return 'overdue';
  if (s.paidCents > 0) return 'partial';
  if (today > s.dueDate) return 'overdue';
  if (today >= s.closingDate) return 'closed';
  return 'open';
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Helper: spread conditional optional properties to satisfy exactOptionalPropertyTypes. */
function opt<T extends Record<string, unknown>>(obj: T, props: Partial<T>): T {
  const result = { ...obj };
  for (const [k, v] of Object.entries(props)) {
    if (v !== undefined && v !== null) (result as any)[k] = v;
  }
  return result;
}

export const createInMemoryCardStore = (state: InMemoryState): CardStore => {
  // Ensure state has card-specific containers.
  if (!(state as any)._statements) (state as any)._statements = [] as Statement[];
  if (!(state as any)._recurring) (state as any)._recurring = [] as RecurringPurchase[];
  if (!(state as any)._cardPurchases) (state as any)._cardPurchases = [] as CardPurchase[];
  const statements = (state as any)._statements as Statement[];
  const recurring = (state as any)._recurring as RecurringPurchase[];
  const cardPurchases = (state as any)._cardPurchases as CardPurchase[];

  const findAccount = (id: string, householdId: string): Account => {
    const a = state.accounts.find(x => x.id === id && x.householdId === householdId);
    if (!a) throw domainErrors.notFound('Conta');
    if (a.status !== 'active') throw domainErrors.notFound('Conta');
    if (a.kind !== 'credit_card') throw domainErrors.invalid('accountId', 'não é cartão de crédito');
    return a;
  };

  const findOrCreateStatement = (accountId: string, householdId: string, purchaseDate: string, card: Account): Statement => {
    if (!card.closingDay || !card.dueDay) throw domainErrors.invalid('accountId', 'cartão sem fechamento/vencimento configurado');
    const closing = getClosingDate(purchaseDate, card.closingDay);
    const cycle = cycleYearMonth(closing);
    let s = statements.find(x => x.accountId === accountId && x.cycleYearMonth === cycle);
    if (s) return s;

    const due = getDueDate(closing, card.dueDay);
    s = {
      id: stableId('stmt', accountId, cycle),
      householdId,
      accountId,
      cycleYearMonth: cycle,
      closingDate: closing,
      dueDate: due,
      totalCents: 0,
      paidCents: 0,
      status: 'open',
    };
    statements.push(s);
    return s;
  };

  const recalcTotal = (statementId: string, householdId: string): void => {
    const stmt = statements.find(s => s.householdId === householdId && s.id === statementId);
    if (!stmt) return;
    const total = state.transactions
      .filter(t => (t as any).statementId === statementId && !state.deletedTransactions.has(t.id))
      .reduce((sum, t) => sum + t.amountCents, 0);
    stmt.totalCents = total;
    stmt.status = computeStatus(stmt, todayISO());
  };

  const findCardForHousehold = (id: string, householdId: string): Account => {
    const a = state.accounts.find(x => x.id === id && x.householdId === householdId);
    if (!a) throw domainErrors.notFound('Cartão');
    if (a.status !== 'active') throw domainErrors.notFound('Cartão');
    if (a.kind !== 'credit_card') throw domainErrors.invalid('id', 'não é cartão de crédito');
    return a;
  };

  /** Canonical debt (ADR-018): fail closed when a write would drive card debt below zero. */
  const assertCardDebtAllowed = (card: Account, deltaCents: number): void => {
    if (!Number.isSafeInteger(deltaCents) || !Number.isSafeInteger(card.balanceCents)) {
      throw domainErrors.invalid('amountCents', 'valor fora do intervalo suportado');
    }
    const next = card.balanceCents + deltaCents;
    if (!Number.isSafeInteger(next) || next < 0) {
      throw domainErrors.invalid('amountCents', 'saldo devedor do cartão não permite a operação');
    }
  };
  /** M-05: same active/expense-kind category rule as plain entries. */
  const resolveCardCategory = (householdId: string, categoryId: string): void => {
    // V4.1 Task 2.14: delegated to the central resolver — same 404/400
    // shapes and the preserved card kind message.
    resolveCategoryForWrite(state.categories, {
      householdId,
      categoryId,
      expectedKind: 'expense',
      wrongKindMessage: CARD_EXPENSE_KIND_MESSAGE,
    });
  };

  /** M-04: audit link row mirroring the card_purchases table. */
  const linkCardPurchase = (input: {
    householdId: string; accountId: string; statementId: string; description: string;
    amountCents: number; date: string; categoryId?: string; subcategoryId?: string;
    notes?: string; installmentsTotal?: number; installmentNumber?: number; transactionId: string;
  }): void => {
    cardPurchases.push({ id: randomUUID(), ...input });
  };

  return {
    async listCreditCardAccounts(householdId) {
      return state.accounts.filter(a => a.householdId === householdId && a.kind === 'credit_card' && a.status === 'active');
    },

    async listStatements(householdId, accountId, opts) {
      let list = statements.filter(s => s.householdId === householdId);
      if (accountId) list = list.filter(s => s.accountId === accountId);
      if (opts?.status) list = list.filter(s => s.status === opts.status);
      list.sort((a, b) => b.closingDate.localeCompare(a.closingDate));
      if (opts?.limit) list = list.slice(0, opts.limit);
      return list;
    },

    async getStatementDetail(householdId, statementId) {
      const s = statements.find(x => x.id === statementId && x.householdId === householdId);
      if (!s) return null;

      // Helper: map a purchase source to StatementPurchase[]
      const toPurchases = (items: { id: string; description: string; amountCents: number; date: string; categoryId?: string; categoryName?: string; installmentsTotal?: number; installmentNumber?: number; isRecurring?: boolean }[]): StatementPurchase[] =>
        items.map(p => opt<StatementPurchase>(
          { id: p.id, description: p.description, amountCents: p.amountCents, date: p.date, isRecurring: p.isRecurring ?? false },
          {
            categoryId: p.categoryId,
            categoryName: p.categoryName,
            ...(p.installmentNumber != null ? { installmentNumber: p.installmentNumber } : {}),
            ...(p.installmentsTotal != null ? { installmentsTotal: p.installmentsTotal } : {}),
          } as Partial<StatementPurchase>,
        ));

      // 1. Primary source: card_purchases (legacy Agent Pi era)
      const cps = cardPurchases.filter(cp => cp.statementId === statementId);
      if (cps.length > 0) {
        return { ...s, purchases: toPurchases(cps) };
      }

      // 2. Secondary: transactions by statement_id (new API inserts)
      const txsByStmt: StatementPurchase[] = state.transactions
        .filter(t => (t as any).statementId === statementId && !state.deletedTransactions.has(t.id))
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(t => {
          const instNum = (t as any).installmentNumber;
          const instTotal = (t as any).installmentsTotal;
          const catName = (t as any).categoryName;
          return opt<StatementPurchase>(
            { id: t.id, description: t.description, amountCents: t.amountCents, date: t.date, isRecurring: false },
            {
              categoryId: t.categoryId,
              categoryName: catName as string | undefined,
              ...(instNum != null ? { installmentNumber: instNum as number } : {}),
              ...(instTotal != null ? { installmentsTotal: instTotal as number } : {}),
            } as Partial<StatementPurchase>,
          );
        });

      if (txsByStmt.length > 0) {
        return { ...s, purchases: txsByStmt };
      }

      // 3. Tertiary: transactions by account + cycle period (unlinked legacy)
      const closing = new Date(s.closingDate + 'T00:00:00.000Z');
      const prevClosing = new Date(closing);
      prevClosing.setUTCMonth(prevClosing.getUTCMonth() - 1);
      const periodStart = prevClosing.toISOString().slice(0, 10);

      const txsByPeriod: StatementPurchase[] = state.transactions
        .filter(t => {
          if (state.deletedTransactions.has(t.id)) return false;
          if (t.accountId !== s.accountId) return false;
          if (t.date <= periodStart || t.date > s.closingDate) return false;
          return true;
        })
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(t => {
          const instNum = (t as any).installmentNumber;
          const instTotal = (t as any).installmentsTotal;
          const catName = (t as any).categoryName;
          return opt<StatementPurchase>(
            { id: t.id, description: t.description, amountCents: t.amountCents, date: t.date, isRecurring: false },
            {
              categoryId: t.categoryId,
              categoryName: catName as string | undefined,
              ...(instNum != null ? { installmentNumber: instNum as number } : {}),
              ...(instTotal != null ? { installmentsTotal: instTotal as number } : {}),
            } as Partial<StatementPurchase>,
          );
        });

      return { ...s, purchases: txsByPeriod };
    },

    async createCardPurchase(householdId, input) {
      const card = findAccount(input.accountId, householdId);
      if (input.categoryId) {
        resolveCardCategory(householdId, input.categoryId);
      }
      if (input.subcategoryId) {
        resolveSubcategory(state, householdId, input.subcategoryId, 'expense', input.categoryId);
      }
      const stmt = findOrCreateStatement(input.accountId, householdId, input.date, card);

      const tx = opt<Transaction & { statementId: string }>(
        {
          id: randomUUID(), householdId, kind: 'expense' as const,
          description: input.description, amountCents: input.amountCents,
          date: input.date, accountId: input.accountId,
          statementId: stmt.id,
        },
        {
          categoryId: input.categoryId,
          subcategoryId: input.subcategoryId,
          notes: input.notes,
          ...(input.installmentsTotal != null ? { installmentsTotal: input.installmentsTotal } as any : {}),
          ...(input.installmentNumber != null ? { installmentNumber: input.installmentNumber } as any : {}),
        } as any,
      );
      state.transactions.push(tx);
      // M-04: mandatory audit link (in-memory cannot fail, but the link row
      // must exist for parity with the postgres stores).
      linkCardPurchase({
        householdId, accountId: input.accountId, statementId: stmt.id,
        description: input.description, amountCents: input.amountCents, date: input.date,
        transactionId: tx.id,
        ...(input.categoryId ? { categoryId: input.categoryId } : {}),
        ...(input.subcategoryId ? { subcategoryId: input.subcategoryId } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.installmentsTotal != null ? { installmentsTotal: input.installmentsTotal } : {}),
        ...(input.installmentNumber != null ? { installmentNumber: input.installmentNumber } : {}),
      });
      // Canonical debt (ADR-018): purchase adds exact amount once, same unit of work.
      card.balanceCents += input.amountCents;
      recalcTotal(stmt.id, householdId);
      return [tx];
    },

    async createCardInstallments(householdId, input) {
      const card = findAccount(input.accountId, householdId);
      if (input.categoryId) {
        resolveCardCategory(householdId, input.categoryId);
      }
      if (input.subcategoryId) {
        resolveSubcategory(state, householdId, input.subcategoryId, 'expense', input.categoryId);
      }
      // L-01: single distribution rule (remainder absorbed by the last parcel).
      const amounts = splitInstallmentAmounts(input.totalAmountCents, input.installmentsTotal);
      // V4.1 Task 2.16: clamped billing-month arithmetic (no setUTCMonth
      // overflow: 2026-01-31 + 1 → 2026-02-28, not 2026-03-03).
      const dates = installmentDates(input.purchaseDate, input.installmentsTotal);
      const txs: Transaction[] = [];

      for (let i = 0; i < input.installmentsTotal; i++) {
        const dateStr = dates[i]!;
        const amount = amounts[i]!;

        const stmt = findOrCreateStatement(input.accountId, householdId, dateStr, card);
        const tx = opt<Transaction & { statementId: string; installmentsTotal: number; installmentNumber: number }>(
          {
            id: randomUUID(), householdId, kind: 'expense' as const,
            description: input.description, amountCents: amount,
            date: dateStr, accountId: input.accountId,
            statementId: stmt.id,
            installmentsTotal: input.installmentsTotal,
            installmentNumber: i + 1,
          },
          {
            categoryId: input.categoryId,
            subcategoryId: input.subcategoryId,
            notes: input.notes,
          } as any,
        );
        state.transactions.push(tx);
        // M-04: mandatory audit link on every parcel.
        linkCardPurchase({
          householdId, accountId: input.accountId, statementId: stmt.id,
          description: input.description, amountCents: amount, date: dateStr,
          installmentsTotal: input.installmentsTotal, installmentNumber: i + 1,
          transactionId: tx.id,
          ...(input.categoryId ? { categoryId: input.categoryId } : {}),
          ...(input.subcategoryId ? { subcategoryId: input.subcategoryId } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        });
        txs.push(tx);
        // Canonical debt: each installment adds its exact parcel once.
        card.balanceCents += amount;
        recalcTotal(stmt.id, householdId);
      }
      return txs;
    },
    async listRecurringPurchases(householdId, opts) {
      return recurring.filter((item) =>
        item.householdId === householdId &&
        (opts?.accountId === undefined || item.accountId === opts.accountId) &&
        (opts?.status === undefined || item.status === opts.status),
      );
    },


    async createRecurringPurchase(householdId, input) {
      // Task 2.18: same validation as the normal purchase path — card must
      // exist, be active and be a credit card; category must be an active
      // expense-kind category.
      findAccount(input.accountId, householdId);
      if (input.categoryId) {
        resolveCardCategory(householdId, input.categoryId);
      }
      const r = opt<RecurringPurchase>(
        {
          id: randomUUID(), householdId, accountId: input.accountId,
          description: input.description, amountCents: input.amountCents,
          frequency: input.frequency, startDate: input.startDate,
          status: 'active' as const,
        },
        { endDate: input.endDate, categoryId: input.categoryId } as Partial<RecurringPurchase>,
      );
      recurring.push(r);
      return r;
    },

    async payStatement(householdId, statementId, input) {
      const s = statements.find(x => x.id === statementId && x.householdId === householdId);
      if (!s) throw domainErrors.notFound('Fatura');

      // Task 2.9: remaining is computed BEFORE any mutation so overpay and
      // double-pay are rejected. (Single-threaded in-memory needs no row
      // lock; the Postgres stores serialize this under SELECT ... FOR UPDATE.)
      const remaining = s.totalCents - s.paidCents;
      if (remaining <= 0) throw domainErrors.invalid('amountCents', 'fatura já está paga');
      if (input.amountCents > remaining) throw domainErrors.invalid('amountCents', 'valor excede o restante da fatura');

      // Validate source account is not a credit card
      const from = state.accounts.find(a => a.id === input.fromAccountId && a.householdId === householdId);
      if (!from) throw domainErrors.notFound('Conta de origem');
      if (from.kind === 'credit_card') throw domainErrors.invalid('fromAccountId', 'não pode pagar fatura com cartão de crédito');

      // Canonical debt (ADR-018): payment subtracts exact amount from the
      // card. Fail closed before any mutation so a short debt never clamps.
      const card = state.accounts.find(a => a.householdId === householdId && a.id === s.accountId);
      if (!card || card.kind !== 'credit_card' || card.status !== 'active') throw domainErrors.notFound('Cartão');
      assertCardDebtAllowed(card, -input.amountCents);

      // Deduct from source account. Negative-balance rule
      // (user-approved): a bank/cash payer may cross below zero.
      from.balanceCents -= input.amountCents;

      // D3-pattern: the payment creates its own expense record (parity with
      // the Postgres stores, which INSERT `Pagamento fatura {cycle}`).
      // V056 structured origin: the canonical payment links to the paid
      // statement (statementPaymentId). Manual expenses sharing the display
      // text carry no link and never satisfy canonical coverage.
      state.transactions.push({
        id: randomUUID(), householdId, kind: 'expense',
        description: `Pagamento fatura ${s.cycleYearMonth}`,
        amountCents: input.amountCents, date: todayISO(), accountId: from.id,
        ...{ statementPaymentId: s.id } as unknown as Partial<Transaction>,
      });

      // Apply to statement
      s.paidCents += input.amountCents;
      s.status = computeStatus(s, todayISO());

      // Canonical debt: payment subtracts from the card; payer debited separately above.
      card.balanceCents -= input.amountCents;

      return s;
    },

    async createCard(householdId, input) {
      const card: Account = {
        id: randomUUID(),
        householdId,
        name: input.name,
        kind: 'credit_card',
        balanceCents: 0,
        status: 'active',
        creditLimitCents: input.creditLimitCents,
        closingDay: input.closingDay,
        dueDay: input.dueDay,
      };
      state.accounts.push(card);
      return card;
    },

    async updateCard(householdId, id, input) {
      const card = findCardForHousehold(id, householdId);
      if (input.name !== undefined) card.name = input.name;
      if (input.creditLimitCents !== undefined) card.creditLimitCents = input.creditLimitCents;
      if (input.closingDay !== undefined) card.closingDay = input.closingDay;
      if (input.dueDay !== undefined) card.dueDay = input.dueDay;
      return card;
    },

    async updatePurchase(householdId, purchaseId, input) {
      if (input.categoryId) {
        resolveCardCategory(householdId, input.categoryId);
      }
      // In-memory: transactions store purchases linked by statement_id
      const tx = state.transactions.find(t => t.id === purchaseId && t.householdId === householdId && !state.deletedTransactions.has(t.id));
      if (tx) {
        // V4.1 REVIEWFIX F7 [major]: mirror cancelPurchase — PATCH only
        // edits purchases of an open statement.
        const txStatementId = (tx as unknown as { statementId?: string }).statementId;
        const txStmt = statements.find(s => s.householdId === householdId && s.id === txStatementId);
        if (!txStmt) throw domainErrors.notFound('Compra');
        if (txStmt.status !== 'open') throw domainErrors.conflict('Fatura não está aberta para edição.');
        // REVIEWFIX (MEDIUM): resolve the debt card BEFORE any mutation so
        // a missing / inactive / wrong-household card fails closed instead
        // of silently skipping the amount delta while the ledger mutates.
        const delta = input.amountCents !== undefined ? input.amountCents - tx.amountCents : 0;
        let debtCard: Account | undefined;
        if (delta !== 0 || input.date !== undefined) {
          const found = state.accounts.find(a => a.id === tx.accountId && a.householdId === householdId);
          if (!found) throw domainErrors.notFound('Cartão');
          if (found.status !== 'active') throw domainErrors.notFound('Cartão');
          if (found.kind !== 'credit_card') throw domainErrors.notFound('Cartão');
          debtCard = found;
        }
        // REVIEWFIX (Security — PATCH date cycle): reject a date that
        // resolves to a different statement cycle BEFORE any mutation —
        // the purchase would otherwise stay linked to the old statement
        // while its date belongs to a new one.
        if (input.date !== undefined) {
          const card = debtCard!;
          if (!card.closingDay) {
            throw domainErrors.invalid('accountId', 'cartão sem fechamento/vencimento configurado');
          }
          const newCycle = cycleYearMonth(getClosingDate(input.date, card.closingDay));
          if (newCycle !== txStmt.cycleYearMonth) {
            throw domainErrors.invalid('date', 'nova data pertence a outro ciclo de fatura; cancele e recrie a compra');
          }
        }
        // Canonical debt (ADR-018): PATCH amount applies the delta. Fail
        // closed before any mutation so a short debt never clamps.
        if (debtCard && delta !== 0) {
          assertCardDebtAllowed(debtCard, delta);
        }
        if (input.description !== undefined) tx.description = input.description;
        if (input.amountCents !== undefined) tx.amountCents = input.amountCents;
        if (input.date !== undefined) tx.date = input.date;
        if (input.categoryId !== undefined) tx.categoryId = input.categoryId;
        if (debtCard && delta !== 0) debtCard.balanceCents += delta;

        // Task 2.7 (D2): ledger = transactions → keep the card_purchases
        // projection row in sync inside the same unit of work.
        const linked = cardPurchases.filter(cp => cp.householdId === householdId && (cp.transactionId === purchaseId || cp.id === purchaseId));
        for (const cp of linked) {
          if (input.description !== undefined) cp.description = input.description;
          if (input.amountCents !== undefined) cp.amountCents = input.amountCents;
          if (input.date !== undefined) cp.date = input.date;
          if (input.categoryId !== undefined) cp.categoryId = input.categoryId;
        }

        const stmt = statements.find(s => s.householdId === householdId && s.id === (tx as any).statementId);
        if (stmt) {

          recalcTotal(stmt.id, householdId);
          const purchases: StatementPurchase[] = state.transactions
            .filter(t2 => (t2 as any).statementId === stmt.id && !state.deletedTransactions.has(t2.id))
            .map(t2 => ({
              id: t2.id,
              description: t2.description,
              amountCents: t2.amountCents,
              date: t2.date,
              categoryId: t2.categoryId,
              isRecurring: false,
            } as StatementPurchase));
          return { ...stmt, purchases };
        }
      }

      throw domainErrors.notFound('Compra');
    },

    async cancelPurchase(householdId, purchaseId) {
      // Idempotência: se já deletado, considerar sucesso.
      const deletedTx = state.transactions.find(t => t.id === purchaseId && t.householdId === householdId);
      if (deletedTx && state.deletedTransactions.has(purchaseId)) return;
      const cpDeleted = (state as any)._deletedCardPurchases as Set<string> | undefined;
      if (cpDeleted?.has(purchaseId)) return;

      // Tentar encontrar transação ativa
      const tx = state.transactions.find(t => t.id === purchaseId && t.householdId === householdId && !state.deletedTransactions.has(t.id));
      if (tx) {
        const stmt = statements.find(s => s.householdId === householdId && s.id === (tx as any).statementId);
        if (!stmt) throw domainErrors.notFound('Compra');
        if (stmt.status !== 'open') throw domainErrors.conflict('Fatura não está aberta para cancelamento.');
        // Canonical debt (ADR-018): cancel subtracts the amount once. Fail
        // closed before any mutation so a short debt never clamps.
        const debtCard = state.accounts.find(a => a.id === tx.accountId && a.householdId === householdId);
        if (!debtCard || debtCard.kind !== 'credit_card' || debtCard.status !== 'active') throw domainErrors.notFound('Cartão');
        assertCardDebtAllowed(debtCard, -tx.amountCents);
        state.deletedTransactions.add(tx.id);
        // M-04: the audit link lives in cardPurchases keyed by its own id —
        // also drop the row linked by transaction_id so the canceled
        // purchase disappears from statement detail.
        const idx = cardPurchases.findIndex(cp => cp.id === purchaseId || cp.transactionId === purchaseId);
        if (idx >= 0) cardPurchases.splice(idx, 1);
        debtCard.balanceCents -= tx.amountCents;
        recalcTotal(stmt.id, householdId);
        return;
      }

      // Tentar card_purchases legado
      const cpIndex = cardPurchases.findIndex(cp => cp.id === purchaseId);
      if (cpIndex >= 0) {
        const cp = cardPurchases[cpIndex]!;
        const stmt = statements.find(s => s.id === cp.statementId && s.householdId === householdId);
        if (!stmt) throw domainErrors.notFound('Compra');
        if (stmt.status !== 'open') throw domainErrors.conflict('Fatura não está aberta para cancelamento.');
        // Simular vínculo legado: verificar transações compatíveis (mesma fatura, valor, data)
        // Se houver ambiguidade, falhar sem mutação.
        const candidates = state.transactions.filter(t => !state.deletedTransactions.has(t.id) && t.householdId === householdId && (t as any).statementId === stmt.id && t.amountCents === cp.amountCents && t.date === cp.date);
        if (candidates.length !== 1) throw domainErrors.conflict('Compra legada sem vínculo único: intervenção manual necessária.');
        // Cancelar ambos
        const legacyCard = state.accounts.find(a => a.id === candidates[0]!.accountId && a.householdId === householdId);
        if (!legacyCard || legacyCard.kind !== 'credit_card' || legacyCard.status !== 'active') throw domainErrors.notFound('Cartão');
        assertCardDebtAllowed(legacyCard, -cp.amountCents);
        if (!(state as any)._deletedCardPurchases) (state as any)._deletedCardPurchases = new Set<string>();
        (state as any)._deletedCardPurchases.add(purchaseId);
        cardPurchases.splice(cpIndex, 1);
        state.deletedTransactions.add(candidates[0]!.id);
        legacyCard.balanceCents -= cp.amountCents;
        recalcTotal(stmt.id, householdId);
        return;
      }

      // Se não encontrado no household, lançar 404
      throw domainErrors.notFound('Compra');
    },
  };
};
