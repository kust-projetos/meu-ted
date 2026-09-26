export type TransactionKind = "expense" | "income" | "transfer";

export interface Transaction {
  id: string;
  description: string;
  amountCents: number;
  date: string; // YYYY-MM-DD
  kind: TransactionKind;
  categoryId: string;
  accountId: string;
  method?: string;
  recipientName?: string;
  senderName?: string;
  installmentsTotal?: number;
  installmentsCurrent?: number;
  /** Free-form observation from "Mais detalhes" (item 10/B4). */
  notes?: string;
}

export type AccountKind =
  | "checking"
  | "savings"
  | "investment"
  | "credit_card"
  | "bank"
  | "cash";

export interface Account {
  id: string;
  name: string;
  balanceCents: number;
  kind: AccountKind;
  /** Card balance semantics discriminator (credit-card only; absent = unknown → statement fallback). */
  balanceSemantics?: "outstanding_debt" | "legacy_calculated";
  creditLimitCents?: number;
  closingDay?: number;
  dueDay?: number;
  color?: string;
  /** From API response */
  status?: string;
  initialBalanceCents?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface Category {
  id: string;
  name: string;
  kind: "expense" | "income";
  icon: string;
  color?: string | null;
  subcategories?: string[];
  parentId?: string;
  status?: string;
  /** True when the row came from the default template (badge in the UI). */
  isDefault?: boolean;
  /** Display order among siblings. */
  sortOrder?: number;
}

/** Canonical tree node from GET /categories/tree (macros with nested subs). */
export interface CategoryTreeSub {
  id: string;
  name: string;
  icon: string | null;
  kind: "sub";
  parentId: string;
}

export interface CategoryTreeMacro {
  id: string;
  name: string;
  icon: string | null;
  kind: "macro";
  type: "expense" | "income";
  isDefault: boolean;
  subcategories: CategoryTreeSub[];
}

export interface Payable {
  id: string;
  description: string;
  amountCents: number;
  dueDate: string;
  status: "pending" | "paid" | "overdue" | "cancelled";
  categoryId?: string;
  paidDate?: string;
  // V4.1 REVIEWFIX F2: the linked payment transaction id, required by
  // POST /payables/:id/unpay (D4 contract).
  paidTransactionId?: string;
  accountId?: string;
  type?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Budget {
  id: string;
  categoryId: string;
  name: string;
  amountCents: number;
  spentCents: number;
  period: "weekly" | "monthly" | "quarterly" | "yearly";
}

export interface Goal {
  id: string;
  name: string;
  goalType: "savings" | "debt_payoff" | "emergency_fund" | "purchase";
  targetAmountCents: number;
  currentAmountCents: number;
  targetDate?: string;
}

export interface Subscription {
  id: string;
  name: string;
  amountCents: number;
  cycle: "monthly" | "yearly" | "weekly";
  day: number;
  paymentMethod: string;
  status: "active" | "cancelled";
  createdAt?: string;
  cancelledAt?: string;
}

export interface Debt {
  id: string;
  name: string;
  totalAmountCents: number;
  paidAmountCents: number;
  interestRate: number; // monthly % (0.01 = 1%)
  installmentsTotal: number;
  installmentsPaid: number;
  startDate: string;
  categoryId?: string;
}

export interface DebtInstallment {
  id: string;
  debtId: string;
  index: number; // 1-based
  dueDate: string;
  amountCents: number;
  paid: boolean;
  paidDate?: string;
}

// ── Card / Statement types (API) ────────────────────────────────────

export type StatementStatus =
  | "open" | "closed" | "paid" | "partial" | "overdue" | "cancelled";

export interface CardStatement {
  id: string;
  accountId: string;
  cycleYearMonth: string;
  closingDate: string;
  dueDate: string;
  totalCents: number;
  paidCents: number;
  status: StatementStatus;
}

export interface StatementPurchase {
  id: string;
  description: string;
  amountCents: number;
  date: string;
  categoryId?: string;
  categoryName?: string;
  installmentNumber?: number;
  installmentsTotal?: number;
  isRecurring?: boolean;
}

export interface StatementDetail extends CardStatement {
  purchases: StatementPurchase[];
}

export interface QuickInsight {
  id: string;
  title: string;
  body: string;
  severity: "info" | "warn" | "good";
}

// ── Household profile (Slice B / Resumo) ─────────────────────────────

export interface Profile {
  householdId: string;
  name: string;
  email: string;
  phone: string;
  avatarColor: string;
  greetingStyle: "auto" | "minimal" | "verbose";
  updatedAt: string;
  isAdmin?: boolean;
}

// ── Pending Operations (approvals) ───────────────────────────────

export type PendingOperationStatus = "pending" | "approved" | "rejected" | "expired";

export interface PendingOperation {
  id: string;
  householdId: string;
  chatId?: string;
  requesterId: string;
  operation: string;
  payload: unknown;
  reason: "high_value" | "destructive";
  idempotencyKey: string;
  status: PendingOperationStatus;
  createdAt: string;
  expiresAt: string;
}

// ── Dashboard Summary (Server-owned Aggregates) ─────────────────────

export interface DashboardSummary {
  householdId: string;
  generatedAt: string;
  totalBalanceCents: number;
  monthIncomeCents: number;
  monthExpenseCents: number;
  monthNetCents: number;
  cashFlowLast30DaysCents: number;
  topExpenses: Array<{
    transactionId: string;
    description: string;
    amountCents: number;
    date: string;
    categoryName?: string;
  }>;
  topExpenseCategories: Array<{
    categoryId?: string;
    categoryName: string;
    totalCents: number;
  }>;
  topIncomeCategories: Array<{
    categoryId?: string;
    categoryName: string;
    totalCents: number;
  }>;
  monthOverMonth: {
    incomeChangePercent: number | null;
    expenseChangePercent: number | null;
    netChangeCents: number;
  };
  alerts: Array<{
    id: string;
    message: string;
    severity: "info" | "warn" | "good";
  }>;
}
