/**
 * Domain types — match iphone-finance-app-v1 spec section "Data Contracts".
 * These are the source of truth for app + API; persistence adapter will
 * implement them against Postgres later.
 */

export type MoneyCents = number;
export type ISODate = string; // `${number}-${number}-${number}` at runtime; widened to string for ergonomics.
export type UUID = string;

export type AccountKind = "bank" | "cash" | "credit_card";
export type AccountStatus = "active" | "inactive";

/**
 * Card balance semantics discriminator (card-balance-semantics-contract).
 *
 * - `outstanding_debt`: `balanceCents` IS the authoritative outstanding
 *   debt (canonical store, ADR-018).
 * - `legacy_calculated`: `balanceCents` is computed from the ledger
 *   (`initial + income − expense …`) and is NOT outstanding debt.
 *
 * Additive and optional: rows predating the contract (or stores that do
 * not tag it, e.g. in-memory) omit it. Consumers MUST treat a missing
 * or unrecognized value as `unknown` → statement-fallback display and
 * MUST NOT infer layout from the balance value. The literals are safe
 * semantic descriptors — never raw persistence detail (no table/column
 * or schema-config names).
 */
export type CardBalanceSemantics = "outstanding_debt" | "legacy_calculated";

export type Account = {
  id: UUID;
  householdId: UUID;
  name: string;
  kind: AccountKind;
  balanceCents: MoneyCents;
  status: AccountStatus;
  /** Card balance semantics discriminator (credit-card only; absent = unknown fallback). */
  balanceSemantics?: CardBalanceSemantics;
  /** Credit-card only. Null for bank/cash accounts. */
  creditLimitCents?: MoneyCents;
  /** Credit-card only. Day of month the billing cycle closes (1-31). */
  closingDay?: number;
  /** Credit-card only. Day of month payment is due (1-31). */
  dueDay?: number;
};

export type CategoryKind = "expense" | "income";
export type CategoryStatus = "active" | "inactive";

export type Category = {
  id: UUID;
  householdId: UUID;
  name: string;
  kind: CategoryKind;
  status: CategoryStatus;
  parentId?: UUID;
  /** Lucide icon name (e.g. "Home"). Null/undefined falls back to a deterministic icon. */
  icon?: string | null;
  /** Theme color hex (e.g. "#0E8C5A"). */
  color?: string | null;
  /** Display order among siblings (lower first). */
  sortOrder?: number;
  /** True when the row came from (or was marked as) the default template. */
  isDefault?: boolean;
  /** Reserved for future immutable system rows; V045 seeds are editable (false). */
  isSystem?: boolean;
};

/** Tree position in the canonical GET /categories/tree contract. */
export type CategoryTreeKind = 'macro' | 'sub';

export type TransactionKind = "expense" | "income" | "transfer";

export type Transaction = {
  id: UUID;
  householdId: UUID;
  kind: TransactionKind;
  description: string;
  amountCents: MoneyCents; // always positive
  date: ISODate;
  accountId: UUID;
  categoryId?: UUID;
  /** Optional subcategory (must be a child of an active same-household category). */
  subcategoryId?: UUID;
  transferToAccountId?: UUID;
  /** Free-form observation saved via "Mais detalhes" (item 10/B4). */
  notes?: string;
};

export type TransactionFilters = {
  startDate?: ISODate;
  endDate?: ISODate;
  accountId?: UUID;
  categoryId?: UUID;
  kind?: TransactionKind;
  minAmountCents?: MoneyCents;
  maxAmountCents?: MoneyCents;
  query?: string;
};

export type DashboardSummary = {
  householdId: UUID;
  generatedAt: string; // ISO datetime
  totalBalanceCents: MoneyCents;
  monthIncomeCents: MoneyCents;
  monthExpenseCents: MoneyCents;
  monthNetCents: MoneyCents;
  cashFlowLast30DaysCents: MoneyCents;
  topExpenses: Array<{
    transactionId: UUID;
    description: string;
    amountCents: MoneyCents;
    date: ISODate;
    categoryName?: string;
  }>;
  topExpenseCategories: Array<{
    categoryId?: UUID;
    categoryName: string;
    totalCents: MoneyCents;
  }>;
  topIncomeCategories: Array<{
    categoryId?: UUID;
    categoryName: string;
    totalCents: MoneyCents;
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
};

export type QuickInsight = {
  id: string;
  title: string;
  body: string;
  severity: "info" | "warn" | "good";
};

// ── Household profile (Slice B / Resumo) ────────────────────
// One row per household, set during onboarding or via /perfil.
// Only the fields that ship in Slice B; expanded later (timezone,
// locale, default account, etc.) if needed.

export type Profile = {
  householdId: UUID;
  /** Display name shown on Home greeting + profile page. */
  name: string;
  /** Contact email shown on the profile page. */
  email: string;
  /** Contact phone shown on the profile page. */
  phone: string;
  /** Avatar background color (hex). Used to color the Home avatar circle. */
  avatarColor: string;
  /** Greeting style preference (future-proofing; default "auto" follows time-of-day). */
  greetingStyle: "auto" | "minimal" | "verbose";
  updatedAt: string; // ISO datetime
};

// ── Subscription types ────────────────────────────────────────────

export type SubscriptionStatus = "active" | "cancelled";

export type SubscriptionCycle = "monthly" | "yearly" | "weekly";

export type Subscription = {
  id: UUID;
  householdId: UUID;
  name: string;
  amountCents: MoneyCents;
  cycle: SubscriptionCycle;
  day: number;
  paymentMethod: string;
  status: SubscriptionStatus;
  createdAt: string;
  cancelledAt?: string;
};

// ── Credit card types ─────────────────────────────────────────────

export type StatementStatus =
  | "open"
  | "closed"
  | "paid"
  | "partial"
  | "overdue"
  | "cancelled";

export type Statement = {
  id: UUID;
  householdId: UUID;
  accountId: UUID;
  cycleYearMonth: string;
  closingDate: ISODate;
  dueDate: ISODate;
  totalCents: MoneyCents;
  paidCents: MoneyCents;
  status: StatementStatus;
};

export type StatementPurchase = {
  id: UUID;
  description: string;
  amountCents: MoneyCents;
  date: ISODate;
  categoryId?: UUID;
  categoryName?: string;
  installmentNumber?: number;
  installmentsTotal?: number;
  isRecurring?: boolean;
};

export type StatementDetail = Statement & {
  purchases: StatementPurchase[];
};

export type RecurringFrequency = "monthly" | "quarterly" | "yearly";

export type RecurringPurchase = {
  id: UUID;
  householdId: UUID;
  accountId: UUID;
  description: string;
  amountCents: MoneyCents;
  frequency: RecurringFrequency;
  startDate: ISODate;
  endDate?: ISODate;
  categoryId?: UUID;
  status: "active" | "paused" | "cancelled";
};

// ── Accounts Payable types ────────────────────────────────────────

export type PayableType = "one_time" | "recurring";
export type PayableStatus = "pending" | "paid" | "overdue" | "cancelled";

export type Payable = {
  id: UUID;
  householdId: UUID;
  accountId: UUID;
  description: string;
  amountCents: MoneyCents;
  dueDate: ISODate;
  type: PayableType;
  frequency?: RecurringFrequency;
  endDate?: ISODate;
  status: PayableStatus;
  paidDate?: ISODate;
  paidAmountCents?: MoneyCents;
  /** Transaction id created when paying this payable. Used by undo payment flow. */
  paidTransactionId?: UUID;
  reminderDaysBefore?: number;
  notes?: string;
  categoryId?: UUID;
};

export type PayableTemplate = {
  id: UUID;
  householdId: UUID;
  accountId: UUID;
  name: string;
  description: string;
  amountCents: MoneyCents;
  frequency: RecurringFrequency;
  dayOfMonth: number;
  reminderDaysBefore?: number;
  notes?: string;
  active: boolean;
};

export type NotificationType =
  | "overdue_reminder"
  | "due_today_reminder"
  | "upcoming_reminder"
  | "daily_summary"
  | "weekly_summary";

export type NotificationConfig = {
  id: UUID;
  householdId: UUID;
  chatId: string;
  notificationType: NotificationType;
  enabled: boolean;
  scheduleHour?: number;
  scheduleMinute?: number;
  scheduleWindowMinutes?: number;
  daysOfWeek?: number[];
  thresholdDays?: number;
  timezone?: string;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastRunStatus?: "sent" | "deduplicated" | "failed";
  lastSentCount?: number;
  lastRemovedCount?: number;
  lastError?: string;
};

// ── Budget types ──────────────────────────────────────────────────

export type BudgetPeriod = "monthly" | "quarterly" | "yearly";

export type Budget = {
  id: UUID;
  householdId: UUID;
  categoryId: UUID;
  name: string;
  amountCents: MoneyCents;
  period: BudgetPeriod;
  startDate: ISODate;
  endDate?: ISODate;
  alertThreshold: number;
  rollover: boolean;
};

export type BudgetStatus = Budget & {
  spentCents: MoneyCents;
  remainingCents: MoneyCents;
  percentUsed: number;
};

export type BudgetTrend = {
  yearMonth: string;
  budgetCents: MoneyCents;
  spentCents: MoneyCents;
};

// ── Goal types ────────────────────────────────────────────────────

export type GoalType =
  | "savings"
  | "purchase"
  | "debt_payoff"
  | "emergency_fund";
export type GoalStatus =
  | "active"
  | "paused"
  | "achieved"
  | "cancelled"
  | "failed";

export type Goal = {
  id: UUID;
  householdId: UUID;
  name: string;
  description?: string;
  goalType: GoalType;
  targetAmountCents: MoneyCents;
  currentAmountCents: MoneyCents;
  startDate: ISODate;
  targetDate?: ISODate;
  categoryId?: UUID;
  accountId?: UUID;
  status: GoalStatus;
  notes?: string;
};

export type GoalContribution = {
  id: UUID;
  goalId: UUID;
  amountCents: MoneyCents;
  contributionDate: ISODate;
  source?: string;
  notes?: string;
};
