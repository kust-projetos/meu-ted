/**
 * Input shapes for write operations.
 *
 * Zod schemas live alongside the in-memory store; the route layer parses
 * request bodies and calls the store with a typed input. The store
 * enforces invariants (ownership, amount > 0, etc.) and the route
 * layer maps Zod validation errors + DomainError to HTTP.
 */

import { z } from 'zod';
import { isoDateSchema as isoDate } from '../shared/iso-date.js';
import { moneyCentsSchema, positiveMoneyCentsSchema } from '../shared/money.js';
const presentationId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/).nullable();

export const createAccountInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['bank', 'cash']),
  // Negative-balance rule (user-approved): bank/cash accounts may start
  // negative — signed cents bounded by MAX_MONEY_CENTS. A negative initial
  // balance for `credit_card` is rejected at the store layer (cards are
  // created via /cards with zero balance and keep non-negative semantics).
  initialBalanceCents: moneyCentsSchema,
});
export type CreateAccountInput = z.infer<typeof createAccountInputSchema> & { institutionId?: string | null | undefined; cardProductId?: string | null | undefined };

export const updateAccountInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
  })
  .refine((v) => v.name !== undefined, { message: 'patch vazio' });
export type UpdateAccountInput = z.infer<typeof updateAccountInputSchema> & { institutionId?: string | null | undefined; cardProductId?: string | null | undefined };

export const createAccountHttpInputSchema = createAccountInputSchema.extend({
  institutionId: presentationId.optional(),
  cardProductId: presentationId.optional(),
});
export const updateAccountHttpInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  institutionId: presentationId.optional(),
  cardProductId: presentationId.optional(),
}).refine((v) => v.name !== undefined || v.institutionId !== undefined || v.cardProductId !== undefined, { message: 'patch vazio' });

const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/, 'cor deve ser hex #RRGGBB');

const lucideIconName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9]+$/, 'ícone deve ser um nome lucide válido');

export const createCategoryInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['expense', 'income']),
  parentId: z.string().uuid().optional(),
  icon: lucideIconName.nullable().optional(),
  color: hexColor.nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  isDefault: z.boolean().optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategoryInputSchema>;

export const updateCategoryInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    icon: lucideIconName.nullable().optional(),
    color: hexColor.nullable().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    isDefault: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.icon !== undefined ||
      v.color !== undefined ||
      v.sortOrder !== undefined ||
      v.isDefault !== undefined,
    { message: 'patch vazio' },
  );
export type UpdateCategoryInput = z.infer<typeof updateCategoryInputSchema>;

/** Delete policy for a macro (and its subs): move records or cascade. */
export const deleteCategoryInputSchema = z
  .object({
    mode: z.enum(['move', 'cascade']),
    destinationCategoryId: z.string().uuid().optional(),
    confirm: z.boolean().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.mode === 'move' && !v.destinationCategoryId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'destinationCategoryId é obrigatório no modo move', path: ['destinationCategoryId'] });
    }
    if (v.mode === 'cascade' && v.confirm !== true) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'cascade exige confirm:true explícito', path: ['confirm'] });
    }
  });
export type DeleteCategoryInput = z.infer<typeof deleteCategoryInputSchema>;

/** Free-form observation from "Mais detalhes" (item 10/B4). */
const notesField = z.string().trim().max(2000).optional();

export const createExpenseInputSchema = z.object({
  description: z.string().trim().min(1).max(240),
  amountCents: positiveMoneyCentsSchema,
  date: isoDate,
  accountId: z.string().uuid(),
  categoryId: z.string().uuid(),
  subcategoryId: z.string().uuid().optional(),
  notes: notesField,
});
export type CreateExpenseInput = z.infer<typeof createExpenseInputSchema>;

export const createIncomeInputSchema = z.object({
  description: z.string().trim().min(1).max(240),
  amountCents: positiveMoneyCentsSchema,
  date: isoDate,
  accountId: z.string().uuid(),
  categoryId: z.string().uuid(),
  subcategoryId: z.string().uuid().optional(),
  notes: notesField,
});
export type CreateIncomeInput = z.infer<typeof createIncomeInputSchema>;

export const createTransferInputSchema = z.object({
  description: z.string().trim().min(1).max(240),
  amountCents: positiveMoneyCentsSchema,
  date: isoDate,
  fromAccountId: z.string().uuid(),
  toAccountId: z.string().uuid(),
});
export type CreateTransferInput = z.infer<typeof createTransferInputSchema>;

/**
 * PATCH /transactions/{id} payload.
 *
 * Per spec: transfer updates are limited to description/date.
 * For expense/income, description/date/amount/account/category are
 * all patchable.
 *
 * V4.1 SPEC §9.7: `.strict()` — unknown fields must fail validation
 * (the route maps unrecognized_keys to 422) instead of being silently
 * stripped.
 */
export const updateTransactionInputSchema = z
  .object({
    description: z.string().trim().min(1).max(240).optional(),
    date: isoDate.optional(),
    amountCents: positiveMoneyCentsSchema.optional(),
    accountId: z.string().uuid().optional(),
    categoryId: z.string().uuid().optional(),
    subcategoryId: z.string().uuid().optional(),
    notes: notesField,
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'patch vazio' });
export type UpdateTransactionInput = z.infer<typeof updateTransactionInputSchema>;
