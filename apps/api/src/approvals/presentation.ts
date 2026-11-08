/**
 * SPEC §16 (T3.4, H-10, INV-02): server-side approval-card projection.
 *
 * `buildPendingOperationPresentation` derives a
 * `PendingOperationPresentation` from the STORED canonical/hash-bound
 * `normalizedArgs` that will execute — never from an LLM summary. Labels
 * (`accountLabel`/`categoryLabel`) are display-only hints supplied by the
 * caller that already performed the authoritative READ (the Agent attaches
 * them at propose time from the entity-resolver lists — the path with the
 * least new transport; GET /v2/active stays a lean, label-free projection
 * for disambiguation). The result is schema-validated; incomplete args
 * (impossible post-T1.4, asserted defensively) yield `null` — an
 * incomplete operation must never reach a card.
 *
 * Attestation/authority material never appears here by construction: the
 * builder only picks display fields off `normalizedArgs`.
 */
import {
  pendingOperationPresentationSchema,
  type PendingOperationPresentation,
} from '@pi-finance/llm-contracts';
import { getClosingDate, getDueDate } from '../cards/billing.js';
import { splitInstallmentAmounts } from '../cards/installments.js';

export const derivePresentationTitle = (tool: string): string =>
  tool === 'cards.statement.pay'
    ? 'Pagamento de fatura'
    : tool === 'cards.purchase.create'
    ? 'Confirmar compra no cartão'
    : tool === 'transactions.transfer.create'
      ? 'Transferência'
    : tool === 'transactions.update'
    ? 'Alterar descrição do lançamento'
    : tool === 'accounts.deactivate'
    ? 'Desativar conta'
    : tool === 'accounts.update'
      ? 'Renomear conta'
      : tool === 'categories.create'
        ? 'Criar categoria'
      : tool === 'categories.update'
          ? 'Renomear categoria'
          : tool === 'categories.deactivate'
            ? 'Desativar categoria'
          : tool.includes('income')
          ? 'Confirmar receita'
          : tool.includes('expense')
            ? 'Confirmar despesa'
            : tool.includes('account')
              ? 'Confirmar conta'
              : 'Confirmar operação';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const formatAmountBRL = (amountCents: number): string =>
  `R$ ${(amountCents / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

const MONTHS_PT = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
] as const;

const formatStatementPeriod = (cycleYearMonth: string): string => {
  const match = /^(\d{4})-(\d{2})$/.exec(cycleYearMonth);
  if (!match) return cycleYearMonth;
  const month = Number(match[2]);
  if (!Number.isInteger(month) || month < 1 || month > 12) return cycleYearMonth;
  return `${MONTHS_PT[month - 1]}/${match[1]}`;
};

export const buildPendingOperationPresentation = (input: {
  id: string;
  status: string;
  tool: string;
  normalizedArgs: unknown;
  expiresAt: string;
  accountLabel?: string;
  fromAccountLabel?: string;
  toAccountLabel?: string;
  categoryLabel?: string;
  categoryKind?: string;
  categoryParentLabel?: { id: string; name: string };
  transactionTarget?: { id:string; amountCents:number; date:string; accountId:string; accountName:string };
  /**
   * Card billing cycle, resolved server-side from the authoritative card
   * account. Used only to name the first invoice of an installment purchase;
   * the PWA never computes it.
   */
  cardCycle?: { closingDay: number; dueDay: number };
  /**
   * Authoritative statement snapshot for `cards.statement.pay`. Resolved
   * server-side from the CardStore; the PWA never recomputes the remaining
   * balance. Absent/divergent ⇒ the card fails closed.
   */
  statementContext?: {
    id: string;
    accountId: string;
    cycleYearMonth: string;
    totalCents: number;
    paidCents: number;
    remainingCents: number;
    dueDate: string;
    status: string;
  };
  warnings?: string[];
}): PendingOperationPresentation | null => {
  const args = isRecord(input.normalizedArgs) ? input.normalizedArgs : null;
  if (!args) return null;
  if (input.tool === 'transactions.transfer.create') {
    // Internal transfer card: amount + description + date + BOTH server-
    // resolved account labels. No category exists by definition (an internal
    // transfer is neither income nor expense). A missing label means one of
    // the accounts is gone/changed in this workspace; the card renders
    // degraded and the shared predicate fails closed — Confirm is never
    // offered for an unverifiable transfer.
    const { amountCents, description, date, fromAccountId, toAccountId } = args as {
      amountCents?: unknown;
      description?: unknown;
      date?: unknown;
      fromAccountId?: unknown;
      toAccountId?: unknown;
    };
    if (typeof amountCents !== 'number' || !Number.isFinite(amountCents) || amountCents <= 0) return null;
    if (typeof description !== 'string' || !description) return null;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    if (typeof fromAccountId !== 'string' || !fromAccountId) return null;
    if (typeof toAccountId !== 'string' || !toAccountId) return null;
    if (fromAccountId === toAccountId) return null;
    const candidate: Record<string, unknown> = {
      id: input.id,
      status: input.status,
      tool: input.tool,
      title: `Transferência de ${formatAmountBRL(amountCents)}`,
      amountCents,
      description,
      date,
      expiresAt: input.expiresAt,
      warnings: Array.isArray(input.warnings) ? input.warnings.filter((w): w is string => typeof w === 'string') : [],
    };
    if (typeof input.fromAccountLabel === 'string' && input.fromAccountLabel) {
      candidate.fromAccount = { id: fromAccountId, label: input.fromAccountLabel };
    }
    if (typeof input.toAccountLabel === 'string' && input.toAccountLabel) {
      candidate.toAccount = { id: toAccountId, label: input.toAccountLabel };
    }
    const parsed = pendingOperationPresentationSchema.safeParse(candidate);
    if (!parsed.success) return null;
    return parsed.data as PendingOperationPresentation;
  }
  if (input.tool === 'accounts.deactivate') {
    const { accountId, accountName, accountKind, balanceCents } = args as {
      accountId?: unknown;
      accountName?: unknown;
      accountKind?: unknown;
      balanceCents?: unknown;
    };
    if (typeof accountId !== 'string' || accountId.length === 0) {
      return null;
    }
    // Display label: ONLY the server-resolved label (authoritative read
    // model) may populate `account`. The hash-bound display-only snapshot
    // (`accountName`) rides along as a card field below, but it must never
    // synthesize `account` — otherwise a never-existing id carrying a
    // snapshot name would project an actionable card, confirm, and execute
    // into a false receipt (the executor converges `not_found` to success
    // for post-crash reconcile). Unknown account ⇒ no `account` ⇒ the
    // shared isActionable predicate fails closed (409, never Confirm).
    const candidate: Record<string, unknown> = {
      id: input.id,
      status: input.status,
      tool: input.tool,
      title: derivePresentationTitle(input.tool),
      expiresAt: input.expiresAt,
      warnings: Array.isArray(input.warnings) ? input.warnings.filter((w): w is string => typeof w === 'string') : [],
      ...(typeof accountName === 'string' && accountName ? { accountName } : {}),
      ...(typeof accountKind === 'string' && accountKind ? { accountKind } : {}),
      ...(typeof balanceCents === 'number' && Number.isFinite(balanceCents) ? { balanceCents } : {}),
    };
    if (
      typeof input.accountLabel === 'string' &&
      input.accountLabel
    ) {
      candidate.account = { id: accountId, label: input.accountLabel };
    }
    const parsed = pendingOperationPresentationSchema.safeParse(candidate);
    if (!parsed.success) return null;
    return parsed.data as PendingOperationPresentation;
  }
  if (input.tool === 'accounts.create') {
    const { name, kind, initialBalanceCents } = args;
    if (
      typeof name !== 'string' ||
      typeof kind !== 'string' ||
      typeof initialBalanceCents !== 'number'
    ) {
      return null;
    }
    const candidate: Record<string, unknown> = {
      id: input.id,
      status: input.status,
      tool: input.tool,
      title: derivePresentationTitle(input.tool),
      accountName: name,
      accountKind: kind,
      initialBalanceCents,
      expiresAt: input.expiresAt,
      warnings: Array.isArray(input.warnings) ? input.warnings.filter((w): w is string => typeof w === 'string') : [],
    };
    const parsed = pendingOperationPresentationSchema.safeParse(candidate);
    if (!parsed.success) return null;
    return parsed.data as PendingOperationPresentation;
  }
  if (input.tool === 'categories.create') {
    // Category card: new name + kind (hash-bound normalizedArgs). The parent
    // label is display-only from the server-resolved read model
    // (`categoryLabel` = parent name).
    //
    // R7-F7a (explicit root vs required parent): a parentId WITHOUT a
    // server-resolved label means the required parent is gone (or never
    // existed here) — the card MUST NOT render actionable. Return null so
    // the shared predicate never sees it and the API gate fails closed
    // (409, no Confirm/Retry), exactly like an incomplete operation.
    // Root categories (no parentId) render without parent and stay
    // actionable — kind/name gate Confirm via the shared predicate.
    // A label is never invented for an unresolved parent.
    const { name, kind, parentId } = args as {
      name?: unknown;
      kind?: unknown;
      parentId?: unknown;
    };
    if (typeof name !== 'string' || !name) return null;
    if (kind !== 'expense' && kind !== 'income') return null;
    if (parentId !== undefined && (typeof parentId !== 'string' || !parentId)) return null;
    if (typeof parentId === 'string' && parentId && !input.categoryLabel) {
      return null;
    }
    const candidate: Record<string, unknown> = {
      id: input.id,
      status: input.status,
      tool: input.tool,
      title: derivePresentationTitle(input.tool),
      categoryName: name,
      categoryKind: kind,
      expiresAt: input.expiresAt,
      warnings: Array.isArray(input.warnings) ? input.warnings.filter((w): w is string => typeof w === 'string') : [],
    };
    if (typeof parentId === 'string' && parentId && typeof input.categoryLabel === 'string' && input.categoryLabel) {
      candidate.category = { id: parentId, label: input.categoryLabel };
    }
    const parsed = pendingOperationPresentationSchema.safeParse(candidate);
    if (!parsed.success) return null;
    return parsed.data as PendingOperationPresentation;
  }
  if (input.tool === 'accounts.update') {
    // Rename card: De (current, server-resolved) → Para (new). The account
    // label is actionable ONLY when the server-resolved CURRENT name still
    // equals the hash-bound expectedName — a concurrent rename in between
    // degrades the card instead of confirming into a stale precondition
    // (the executor would fail closed with account.name_conflict). Never
    // invent existence: an unknown/inactive target yields no `account` and
    // the shared predicate fails the card closed.
    const { accountId, name, expectedName } = args as {
      accountId?: unknown;
      name?: unknown;
      expectedName?: unknown;
    };
    if (typeof accountId !== 'string' || !accountId || typeof name !== 'string' || !name) {
      return null;
    }
    if (typeof expectedName !== 'string' || !expectedName) {
      return null;
    }
    const candidate: Record<string, unknown> = {
      id: input.id,
      status: input.status,
      tool: input.tool,
      title: derivePresentationTitle(input.tool),
      accountName: name,
      expiresAt: input.expiresAt,
      warnings: Array.isArray(input.warnings) ? input.warnings.filter((w): w is string => typeof w === 'string') : [],
    };
    if (
      typeof input.accountLabel === 'string' &&
      input.accountLabel &&
      input.accountLabel === expectedName
    ) {
      candidate.account = { id: accountId, label: input.accountLabel };
    }
    const parsed = pendingOperationPresentationSchema.safeParse(candidate);
    if (!parsed.success) return null;
    return parsed.data as PendingOperationPresentation;
  }
  if (input.tool === 'categories.update') {
    const { categoryId, name, expectedName } = args as {
      categoryId?: unknown;
      name?: unknown;
      expectedName?: unknown;
    };
    if (typeof categoryId !== 'string' || !categoryId || typeof name !== 'string' || !name) {
      return null;
    }
    if (typeof expectedName !== 'string' || !expectedName) {
      return null;
    }
    const candidate: Record<string, unknown> = {
      id: input.id,
      status: input.status,
      tool: input.tool,
      title: derivePresentationTitle(input.tool),
      categoryName: name,
      expiresAt: input.expiresAt,
      warnings: Array.isArray(input.warnings) ? input.warnings.filter((w): w is string => typeof w === 'string') : [],
    };
    if (
      typeof input.categoryLabel === 'string' &&
      input.categoryLabel &&
      input.categoryLabel === expectedName
    ) {
      candidate.category = { id: categoryId, label: input.categoryLabel };
    }
    const parsed = pendingOperationPresentationSchema.safeParse(candidate);
    if (!parsed.success) return null;
    return parsed.data as PendingOperationPresentation;
  }
  if (input.tool === 'transactions.update') {
    const { transactionId, description, expectedDescription } = args as {
      transactionId?: unknown; description?: unknown; expectedDescription?: unknown;
    };
    if (typeof transactionId !== 'string' || !transactionId || typeof description !== 'string' || !description || typeof expectedDescription !== 'string' || !expectedDescription) return null;
    const target = input.transactionTarget;
    const parsed = pendingOperationPresentationSchema.safeParse({
      id: input.id, status: input.status, tool: input.tool, title: derivePresentationTitle(input.tool),
      description, expectedDescription, transactionTargetId: transactionId,
      ...(target && target.id===transactionId ? { transactionAmountCents:target.amountCents, transactionDate:target.date, transactionAccount:{id:target.accountId,label:target.accountName} } : {}),
      expiresAt: input.expiresAt,
      warnings: Array.isArray(input.warnings) ? input.warnings.filter((w): w is string => typeof w === 'string') : [],
    });
    return parsed.success ? parsed.data as PendingOperationPresentation : null;
  }
  if (input.tool === 'categories.deactivate') {
    const { categoryId, expectedName } = args as { categoryId?: unknown; expectedName?: unknown };
    if (typeof categoryId !== 'string' || !categoryId || typeof expectedName !== 'string' || !expectedName) return null;
    const candidate: Record<string, unknown> = {
      id: input.id,
      status: input.status,
      tool: input.tool,
      title: derivePresentationTitle(input.tool),
      categoryName: expectedName,
      ...(input.categoryKind ? { categoryKind: input.categoryKind } : {}),
      ...(input.categoryParentLabel ? { categoryParent: { id: input.categoryParentLabel.id, label: input.categoryParentLabel.name } } : {}),
      expiresAt: input.expiresAt,
      warnings: Array.isArray(input.warnings) ? input.warnings.filter((w): w is string => typeof w === 'string') : [],
    };
    if (input.categoryLabel === expectedName) candidate.category = { id: categoryId, label: input.categoryLabel };
    const parsed = pendingOperationPresentationSchema.safeParse(candidate);
    if (!parsed.success) return null;
    return parsed.data as PendingOperationPresentation;
  }
  if (input.tool === 'cards.statement.pay') {
    // P3.6 statement payment: the invoice + the CARD + the PAYER account are
    // the context. The amount paid NOW is explicit (never a "total" sentinel)
    // and must not exceed the authoritative remaining balance at presentation
    // time; a stale card renders non-actionable instead of confirming into an
    // overpay (the executor re-checks under the statement row lock).
    const { statementId, fromAccountId, amountCents } = args as {
      statementId?: unknown;
      fromAccountId?: unknown;
      amountCents?: unknown;
    };
    if (typeof statementId !== 'string' || !statementId) return null;
    if (typeof fromAccountId !== 'string' || !fromAccountId) return null;
    if (typeof amountCents !== 'number' || !Number.isInteger(amountCents) || amountCents <= 0) return null;
    const statement = input.statementContext;
    if (!statement || statement.id !== statementId) return null;
    if (statement.remainingCents <= 0 || amountCents > statement.remainingCents) return null;
    if (statement.paidCents + statement.remainingCents !== statement.totalCents) return null;
    if (typeof input.accountLabel !== 'string' || !input.accountLabel) return null;
    if (typeof input.fromAccountLabel !== 'string' || !input.fromAccountLabel) return null;
    const candidate: Record<string, unknown> = {
      id: input.id,
      status: input.status,
      tool: input.tool,
      title: `Pagamento de fatura — ${formatAmountBRL(amountCents)}`,
      amountCents,
      statement: { id: statementId, label: formatStatementPeriod(statement.cycleYearMonth) },
      statementTotalCents: statement.totalCents,
      statementPaidCents: statement.paidCents,
      statementRemainingCents: statement.remainingCents,
      statementDueDate: statement.dueDate,
      statementStatus: statement.status,
      account: { id: statement.accountId, label: input.accountLabel },
      fromAccount: { id: fromAccountId, label: input.fromAccountLabel },
      expiresAt: input.expiresAt,
      warnings: Array.isArray(input.warnings) ? input.warnings.filter((w): w is string => typeof w === 'string') : [],
    };
    const parsed = pendingOperationPresentationSchema.safeParse(candidate);
    if (!parsed.success) return null;
    return parsed.data as PendingOperationPresentation;
  }
  if (input.tool === 'cards.purchase.create') {
    // P3.4 card purchase (1x): the card is the credit-card account
    // (`accountId`) and the category is OPTIONAL - an unclassified purchase
    // is still confirmable, so only the card label gates Confirm. The
    // actionable predicate below mirrors exactly that tuple.
    const { amountCents, description, date, accountId, categoryId, installmentsTotal } = args;
    if (
      typeof amountCents !== 'number' ||
      typeof description !== 'string' ||
      !description ||
      typeof date !== 'string' ||
      !date ||
      typeof accountId !== 'string' ||
      !accountId
    ) {
      return null;
    }
    // P3.5: an explicitly declared split must be a real parcel count. A
    // malformed value is NOT silently treated as 1x — the card fails closed.
    if (installmentsTotal !== undefined) {
      if (
        typeof installmentsTotal !== 'number' ||
        !Number.isInteger(installmentsTotal) ||
        installmentsTotal < 1 ||
        installmentsTotal > 48
      ) {
        return null;
      }
    }
    const installmentsCount = typeof installmentsTotal === 'number' ? installmentsTotal : 1;
    const isInstallmentPurchase = installmentsCount > 1;
    const candidate: Record<string, unknown> = {
      id: input.id,
      status: input.status,
      tool: input.tool,
      title: isInstallmentPurchase ? 'Confirmar compra parcelada' : derivePresentationTitle(input.tool),
      amountCents,
      description,
      date,
      expiresAt: input.expiresAt,
      warnings: Array.isArray(input.warnings) ? input.warnings.filter((w): w is string => typeof w === 'string') : [],
    };
    if (isInstallmentPurchase) {
      // Same financial rule the executor uses — the preview is never a second
      // rounding implementation.
      const amounts = splitInstallmentAmounts(amountCents, installmentsCount);
      // A declared split must produce real parcels (>= 1 cent each); otherwise
      // the card fails closed instead of previewing zero-cent rows.
      if (amounts.some((amount) => amount <= 0)) return null;
      candidate.installmentsTotal = installmentsCount;
      candidate.installmentAmountsCents = amounts;
      if (input.cardCycle) {
        const closing = getClosingDate(date, input.cardCycle.closingDay);
        candidate.firstStatementClosingDate = closing;
        candidate.firstStatementDueDate = getDueDate(closing, input.cardCycle.dueDay);
      }
    }
    if (typeof input.accountLabel === 'string' && input.accountLabel) {
      candidate.account = { id: accountId, label: input.accountLabel };
    }
    if (typeof categoryId === 'string' && categoryId && typeof input.categoryLabel === 'string' && input.categoryLabel) {
      candidate.category = { id: categoryId, label: input.categoryLabel };
    }
    const parsed = pendingOperationPresentationSchema.safeParse(candidate);
    if (!parsed.success) return null;
    return parsed.data as PendingOperationPresentation;
  }
  const { amountCents, description, date, accountId, categoryId } = args;
  if (
    typeof amountCents !== 'number' ||
    typeof description !== 'string' ||
    typeof date !== 'string' ||
    typeof accountId !== 'string' ||
    typeof categoryId !== 'string'
  ) {
    return null;
  }
  const candidate: Record<string, unknown> = {
    id: input.id,
    status: input.status,
    tool: input.tool,
    title: derivePresentationTitle(input.tool),
    amountCents,
    description,
    date,
    expiresAt: input.expiresAt,
    warnings: Array.isArray(input.warnings) ? input.warnings.filter((w): w is string => typeof w === 'string') : [],
  };
  if (typeof input.accountLabel === 'string' && input.accountLabel) {
    candidate.account = { id: accountId, label: input.accountLabel };
  }
  if (typeof input.categoryLabel === 'string' && input.categoryLabel) {
    candidate.category = { id: categoryId, label: input.categoryLabel };
  }
  const parsed = pendingOperationPresentationSchema.safeParse(candidate);
  if (!parsed.success) return null;
  // The strict schema is the authority: its output carries exactly the
  // contract fields. The cast bridges zod's inferred optionals to the
  // hand-written contract interface (exactOptionalPropertyTypes).
  return parsed.data as PendingOperationPresentation;
};
