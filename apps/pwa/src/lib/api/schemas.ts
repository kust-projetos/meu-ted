import { z } from "zod";

const id = z.string().min(1);
const cents = z.number().finite();
const date = z.string().min(1);

export const accountSchema = z.object({
  id,
  name: z.string(),
  balanceCents: cents.optional(),
  // Explicit card-balance semantics discriminator (additive, optional).
  // Unknown/future values normalize to undefined → statement-fallback display,
  // never a validation crash and never inferred from the balance value.
  balanceSemantics: z.enum(["outstanding_debt", "legacy_calculated"]).optional().catch(undefined),
  kind: z.enum(["bank", "cash", "credit_card", "checking", "savings", "investment"]).optional(),
  status: z.string().optional(),
  creditLimitCents: cents.optional(),
  closingDay: z.number().int().optional(),
  dueDay: z.number().int().optional(),
  color: z.string().optional(),
  initialBalanceCents: cents.optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).transform((account) => ({
  ...account,
  balanceCents: account.balanceCents ?? account.initialBalanceCents ?? 0,
  kind: account.kind ?? (account.creditLimitCents !== undefined ? "credit_card" : "bank"),
}));

export const categorySchema = z.object({
  id,
  name: z.string(),
  kind: z.enum(["expense", "income"]),
  icon: z.string().default("Tag"),
  color: z.string().optional(),
  parentId: id.optional(),
  subcategories: z.array(z.string()).optional(),
  status: z.string().optional(),
  isDefault: z.boolean().optional(),
  sortOrder: z.number().optional(),
});

export const transactionSchema = z.object({
  id,
  description: z.string(),
  amountCents: cents,
  date,
  kind: z.enum(["expense", "income", "transfer"]),
  categoryId: z.string().default(""),
  accountId: id,
  fromAccountId: id.optional(),
  toAccountId: id.optional(),
  method: z.string().optional(),
  recipientName: z.string().optional(),
  senderName: z.string().optional(),
  installmentsTotal: z.number().int().optional(),
  installmentsCurrent: z.number().int().optional(),
  notes: z.string().optional(),
});

export const payableSchema = z.object({
  id,
  description: z.string(),
  amountCents: cents,
  dueDate: date,
  status: z.enum(["pending", "paid", "overdue", "cancelled"]),
  categoryId: id.optional(),
  paidDate: date.optional(),
  accountId: id.optional(),
  type: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const budgetSchema = z.object({
  id,
  categoryId: id,
  name: z.string(),
  amountCents: cents,
  spentCents: cents,
  percentUsed: z.number().finite().optional(),
  period: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
});

export const goalSchema = z.object({
  id,
  name: z.string(),
  goalType: z.enum(["savings", "debt_payoff", "emergency_fund", "purchase"]),
  targetAmountCents: cents,
  currentAmountCents: cents,
  startDate: date.optional(),
  targetDate: date.optional(),
  status: z.string().optional(),
  description: z.string().optional(),
  categoryId: id.optional(),
  accountId: id.optional(),
});

export const subscriptionSchema = z.object({
  id,
  name: z.string(),
  amountCents: cents,
  cycle: z.enum(["monthly", "yearly", "weekly"]),
  day: z.number().int(),
  paymentMethod: z.string(),
  status: z.enum(["active", "cancelled"]),
  createdAt: z.string().optional(),
  cancelledAt: z.string().optional(),
});

const statementBaseSchema = z.object({
  id,
  accountId: id,
  cycleYearMonth: z.string().optional(),
  closingDate: date,
  dueDate: date,
  totalCents: cents,
  paidCents: cents,
  status: z.enum(["open", "closed", "paid", "partial", "overdue", "cancelled"]),
});

const normalizeStatement = <T extends { cycleYearMonth?: string; closingDate: string }>(statement: T) => ({
  ...statement,
  cycleYearMonth: statement.cycleYearMonth ?? statement.closingDate.slice(0, 7),
});

export const statementSchema = statementBaseSchema.transform(normalizeStatement);

export const statementDetailSchema = statementBaseSchema.extend({
  purchases: z.array(z.object({
    id,
    description: z.string(),
    amountCents: cents,
    date,
    categoryId: id.optional(),
    categoryName: z.string().optional(),
    installmentNumber: z.number().int().optional(),
    installmentsTotal: z.number().int().optional(),
    isRecurring: z.boolean().optional(),
    installments: z.object({ total: z.number().int(), current: z.number().int() }).optional(),
  })),
}).transform((statement) => normalizeStatement({
  ...statement,
  purchases: statement.purchases.map((purchase) => ({
    ...purchase,
    installmentNumber: purchase.installmentNumber ?? purchase.installments?.current,
    installmentsTotal: purchase.installmentsTotal ?? purchase.installments?.total,
  })),
}));

const periodSchema = z.object({
  incomeCents: cents,
  expenseCents: cents,
  netCents: cents,
  transactionCount: z.number().int().nonnegative(),
  savingsRatePercent: z.number().finite(),
  averageExpenseCents: cents,
  categories: z.array(z.object({
    categoryId: id.optional(),
    categoryName: z.string(),
    totalCents: cents,
    percentage: z.number().finite(),
  })),
});

export const dashboardSummarySchema = z.object({
  householdId: id,
  generatedAt: z.string(),
  totalBalanceCents: cents,
  monthIncomeCents: cents,
  monthExpenseCents: cents,
  monthNetCents: cents,
  cashFlowLast30DaysCents: cents,
  topExpenses: z.array(z.object({
    transactionId: id,
    description: z.string(),
    amountCents: cents,
    date,
    categoryName: z.string().optional(),
  })),
  topExpenseCategories: z.array(z.object({
    categoryId: id.optional(),
    categoryName: z.string(),
    totalCents: cents,
    percentage: z.number().finite().optional(),
  })),
  topIncomeCategories: z.array(z.object({
    categoryId: id.optional(),
    categoryName: z.string(),
    totalCents: cents,
    percentage: z.number().finite().optional(),
  })),
  monthOverMonth: z.object({
    incomeChangePercent: z.number().finite().nullable(),
    expenseChangePercent: z.number().finite().nullable(),
    netChangeCents: cents,
  }),
  alerts: z.array(z.object({
    id: id.optional(),
    type: z.string().optional(),
    message: z.string(),
    severity: z.enum(["info", "warn", "error", "warning", "danger"]).transform((severity) =>
      severity === "warning" ? "warn" : severity === "danger" ? "error" : severity,
    ),
  }).transform((alert) => ({
    ...alert,
    id: alert.id ?? alert.type ?? "alert",
  }))),
  cardAggregates: z.array(z.object({
    accountId: id,
    spentCents: cents,
    limitCents: cents,
    availableCents: cents,
    percentage: z.number().finite(),
  })).optional(),
  totalCardSpentCents: cents.optional(),
  totalCardLimitCents: cents.optional(),
  totalCardAvailableCents: cents.optional(),
  pendingPayablesCents: cents.optional(),
  reporting: z.object({
    periods: z.object({ month: periodSchema, last: periodSchema, quarter: periodSchema, year: periodSchema }),
    monthlyFlow: z.array(z.object({ yearMonth: z.string(), incomeCents: cents, expenseCents: cents })),
  }).optional(),
});

export const profileSchema = z.object({
  householdId: id.optional(),
  name: z.string(),
  email: z.string().default(""),
  phone: z.string().default(""),
  avatarColor: z.string().default("#3B82F6"),
  greetingStyle: z.enum(["auto", "minimal", "verbose", "formal"]).optional(),
  updatedAt: z.string().default(""),
}).transform((profile) => ({
  ...profile,
  householdId: profile.householdId ?? "",
  greetingStyle: profile.greetingStyle === "formal" ? "auto" : profile.greetingStyle ?? "auto",
}));

export const quickInsightSchema = z.union([
  z.object({
    id,
    title: z.string(),
    body: z.string(),
    severity: z.enum(["info", "warn", "good"]),
  }),
  z.object({
    label: z.string(),
    valueCents: cents,
    type: z.enum(["expense", "income", "balance"]),
  }),
]).transform((insight) => {
  if ("title" in insight) return insight;
  return {
    id: `legacy-${insight.type}-${insight.label}`,
    title: insight.label,
    body: `${insight.valueCents} centavos`,
    severity: insight.type === "expense" ? "warn" as const : "info" as const,
  };
});

const authUserSchema = z.object({
  id: id,
  email: z.string().email(),
}).passthrough();

export const authSessionSchema = z.object({
  session: z.object({ id }).passthrough(),
  user: authUserSchema,
}).nullable();

export const authSignInSchema = z.object({
  user: authUserSchema,
}).passthrough();

export const listResponse = <T extends z.ZodType<unknown>>(item: T) => z.object({
  items: z.array(item),
  total: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
});

export const transactionPageSchema = listResponse(transactionSchema);
export const installmentsResponseSchema = z.object({ items: z.array(transactionSchema) });
export const profileResponseSchema = z.object({ profile: profileSchema.nullable() });
export const requiredProfileResponseSchema = z.object({ profile: profileSchema });
export const quickInsightsResponseSchema = z.object({ items: z.array(quickInsightSchema) });
export const deviceMeSchema = z.object({}).passthrough();
export const emptyResponseSchema = z.undefined();

export const workspaceSchema = z.object({
  id,
  name: z.string(),
  kind: z.enum(["personal", "shared"]),
  role: z.enum(["owner", "member"]),
  status: z.enum(["active", "archived"]).default("active"),
});
export const workspaceListSchema = listResponse(workspaceSchema);
export const workspaceMemberSchema = z.object({
  userId: id,
  name: z.string(),
  email: z.string().email(),
  role: z.enum(["owner", "member"]),
  status: z.enum(["active", "pending"]).default("active"),
});
export const workspaceMemberListSchema = listResponse(workspaceMemberSchema);
export const workspaceInviteSchema = z.object({
  inviteId: id,
  email: z.string().email(),
  expiresAt: date,
});
export const workspaceInviteAcceptanceSchema = z.object({
  inviteId: id,
  membership: z.object({ userId: id, householdId: id, role: z.enum(["owner", "member"]) }),
});

export const pendingInviteSchema = z.object({
  id,
  householdId: id,
  email: z.string().email(),
  role: z.enum(["owner", "member"]).default("member"),
  expiresAt: date,
  createdAt: date.optional(),
});
export const pendingInviteListSchema = listResponse(pendingInviteSchema);

export const resendInviteResponseSchema = z.object({
  success: z.boolean(),
  inviteId: id,
  email: z.string().email(),
  expiresAt: date,
});

export const revokeInviteResponseSchema = z.object({
  success: z.boolean(),
  inviteId: id,
  revokedAt: date.optional(),
});

export const ownershipTransferSchema = z.object({
  id,
  householdId: z.string().optional(),
  household_id: z.string().optional(),
  fromUserId: z.string().optional(),
  toUserId: z.string().optional(),
  from_user_id: z.string().optional(),
  to_user_id: z.string().optional(),
  status: z.string(),
  createdAt: date.optional(),
  created_at: date.optional(),
  acceptedAt: date.optional(),
  accepted_at: date.optional(),
}).transform((row) => ({
  id: row.id,
  householdId: row.householdId ?? row.household_id ?? "",
  fromUserId: row.fromUserId ?? row.from_user_id ?? "",
  toUserId: row.toUserId ?? row.to_user_id ?? "",
  status: row.status,
  createdAt: row.createdAt ?? row.created_at ?? "",
  acceptedAt: row.acceptedAt ?? row.accepted_at,
}));
export const ownershipTransferListSchema = listResponse(ownershipTransferSchema);

export const pwaControlSchema = z.object({ enabled: z.boolean().optional() });
