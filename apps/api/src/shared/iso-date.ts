/**
 * Shared ISO date/datetime schemas (V4.1 Phase 8, task 8.8, SPEC §15.8).
 *
 * A regex alone accepts `2026-02-31`. These schemas keep the strict
 * `YYYY-MM-DD` shape AND validate the real Gregorian calendar (month
 * lengths + century leap rules) so impossible dates fail at the boundary
 * with a 4xx instead of corrupting ledgers or queries downstream.
 */

import { z } from 'zod';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True only for real Gregorian calendar dates in strict YYYY-MM-DD shape. */
export const isValidIsoDate = (value: string): boolean => {
  if (!ISO_DATE_RE.test(value)) return false;
  const [yearStr, monthStr, dayStr] = value.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day
  );
};

/** Strict `YYYY-MM-DD` with real-calendar validation. */
export const isoDateSchema = z
  .string()
  .regex(ISO_DATE_RE, 'YYYY-MM-DD')
  .refine(isValidIsoDate, { message: 'data inválida (calendário real)' })
  // JSON-schema-only annotation: Zod 4 does not infer `format` from a regex,
  // but the OpenAPI contract declares `format: date` alongside the same
  // pattern. Runtime validation is unchanged (regex + calendar refine).
  .meta({ format: 'date' });

/** Strict ISO-8601 datetime (UTC offset required). */
export const isoDateTimeSchema = z.string().datetime({ offset: true });
