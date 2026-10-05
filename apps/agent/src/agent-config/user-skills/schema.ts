/**
 * A18 / R17 (AC27): closed declarative schema for USER skills.
 *
 * The only rule this layer accepts is a merchant alias pointing at a category
 * that already exists in the workspace:
 *
 *   { merchantPattern, categoryId | categoryName, note? }
 *
 * There is deliberately no field through which a rule can request a tool, SQL,
 * a fetch, a policy change, extra prompt text or a capability: the field set is
 * closed and every value is bounded. A rule that asks for any of those is
 * rejected HERE (typed error, nothing persisted) rather than filtered later.
 * `note` is stored for audit only and is never rendered into the prompt.
 *
 * Core skills (`skills/*.ts`) and the tool/capability catalog are not reachable
 * from this module.
 */

import { z } from 'zod';
import { scrubForPersistence } from '../../privacy/dlp.js';

/** The closed field set. Anything else is a rejection. */
export const USER_SKILL_RULE_FIELDS = ['merchantPattern', 'categoryId', 'categoryName', 'note'] as const;

export const USER_SKILL_MERCHANT_MAX = 64;
export const USER_SKILL_CATEGORY_MAX = 64;
export const USER_SKILL_NOTE_MAX = 140;

/**
 * Field names that express a capability, an escape or an instruction. They are
 * reported with a dedicated `forbidden_field` code so an audit can tell "this
 * rule tried to widen the agent" apart from "this rule has a typo".
 */
export const USER_SKILL_FORBIDDEN_FIELDS: readonly string[] = [
  'tool',
  'tools',
  'toolname',
  'function',
  'call',
  'sql',
  'query',
  'statement',
  'fetch',
  'fetchurl',
  'url',
  'http',
  'endpoint',
  'api',
  'policy',
  'policies',
  'rule',
  'rules',
  'instruction',
  'instructions',
  'prompt',
  'systemprompt',
  'steps',
  'pitfalls',
  'when',
  'capability',
  'capabilities',
  'schema',
  'eval',
  'evals',
  'fixture',
  'fixtures',
  'autoapprove',
  'approve',
  'approval',
  'write',
  'mutation',
  'command',
  'script',
  'exec',
  'shell',
  'glob',
  'fs',
  'file',
  'env',
  'secret',
  'token',
  'web',
  'websearch',
  'webfetch',
];

export type UserSkillRule = {
  merchantPattern: string;
  categoryId?: string;
  categoryName?: string;
  /** Free-text provenance kept for audit; never rendered into the prompt. */
  note?: string;
};

export type UserSkillRuleErrorCode =
  | 'not_an_object'
  | 'missing_field'
  | 'unknown_field'
  | 'forbidden_field'
  | 'invalid_value';

export type UserSkillRuleParseResult =
  | { ok: true; rule: UserSkillRule }
  | { ok: false; code: UserSkillRuleErrorCode; field: string | null };

/** Newlines and control characters never belong in a bounded declarative field. */
const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f]+$/;

const merchantSchema = z
  .string()
  .min(1, 'empty')
  .max(USER_SKILL_MERCHANT_MAX, 'too_long')
  .regex(NO_CONTROL_CHARS, 'control_chars');

const categoryIdSchema = z
  .string()
  .min(1, 'empty')
  .max(USER_SKILL_CATEGORY_MAX, 'too_long')
  .regex(/^[A-Za-z0-9_-]+$/, 'not_an_opaque_id');

const categoryNameSchema = z
  .string()
  .min(1, 'empty')
  .max(USER_SKILL_CATEGORY_MAX, 'too_long')
  .regex(NO_CONTROL_CHARS, 'control_chars');

const noteSchema = z
  .string()
  .min(1, 'empty')
  .max(USER_SKILL_NOTE_MAX, 'too_long')
  .regex(NO_CONTROL_CHARS, 'control_chars');

const ruleSchema = z
  .object({
    merchantPattern: merchantSchema,
    categoryId: categoryIdSchema.optional(),
    categoryName: categoryNameSchema.optional(),
    note: noteSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasId = typeof value.categoryId === 'string' && value.categoryId.length > 0;
    const hasName = typeof value.categoryName === 'string' && value.categoryName.length > 0;
    if (!hasId && !hasName) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'missing_category_reference', path: ['categoryId'] });
    }
    if (hasId && hasName) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ambiguous_category_reference', path: ['categoryName'] });
    }
  });

/** Placeholder left by the DLP scrub when a whole value was sensitive. */
const REDACTION_ONLY_RE = /^\[REDACTED(_SECRET)?\]$/;

/**
 * Every declarative field funnels through the central DLP scrub (same policy
 * as memory writes): PAN/CPF/secrets are never persisted. A value that is
 * nothing but a redaction placeholder carries no rule, so it is treated as
 * empty and the rule is rejected rather than stored as a label.
 */
const trimmed = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const scrubbed = scrubForPersistence(value.trim());
  return REDACTION_ONLY_RE.test(scrubbed) ? '' : scrubbed;
};

/**
 * Deterministic keyword fragments derived from the merchant pattern. This is
 * the ONLY text-selection input of a user skill (same `haystack.includes`
 * heuristic the core catalog uses), so it is derived, never user-supplied.
 */
export const userSkillKeywords = (rule: UserSkillRule): string[] => {
  const tokens = (rule.merchantPattern ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
  return [...new Set(tokens)];
};

export class UserSkillRuleError extends Error {
  readonly code: UserSkillRuleErrorCode;
  readonly field: string | null;

  constructor(code: UserSkillRuleErrorCode, field: string | null) {
    super(`user skill rule rejected (${code}${field ? `: ${field}` : ''})`);
    this.name = 'UserSkillRuleError';
    this.code = code;
    this.field = field;
  }
}

/**
 * Validates one candidate rule against the closed schema. Deterministic and
 * side-effect free: callers persist only when `ok` is true.
 */
export const parseUserSkillRule = (input: unknown): UserSkillRuleParseResult => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, code: 'not_an_object', field: null };
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if ((USER_SKILL_RULE_FIELDS as readonly string[]).includes(key)) continue;
    const lowered = key.toLowerCase();
    if (USER_SKILL_FORBIDDEN_FIELDS.includes(lowered)) {
      return { ok: false, code: 'forbidden_field', field: key };
    }
    return { ok: false, code: 'unknown_field', field: key };
  }

  const candidate = {
    merchantPattern: trimmed(record['merchantPattern']),
    ...(record['categoryId'] === undefined ? {} : { categoryId: trimmed(record['categoryId']) }),
    ...(record['categoryName'] === undefined ? {} : { categoryName: trimmed(record['categoryName']) }),
    ...(record['note'] === undefined ? {} : { note: trimmed(record['note']) }),
  };

  const parsed = ruleSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path?.[0];
    const code = issue?.message === 'missing_category_reference' ? 'missing_field' : 'invalid_value';
    return { ok: false, code, field: typeof field === 'string' ? field : null };
  }
  return { ok: true, rule: parsed.data };
};

/** Throwing variant for callers that cannot handle a result union. */
export const assertUserSkillRule = (input: unknown): UserSkillRule => {
  const parsed = parseUserSkillRule(input);
  if (!parsed.ok) throw new UserSkillRuleError(parsed.code, parsed.field);
  return parsed.rule;
};
