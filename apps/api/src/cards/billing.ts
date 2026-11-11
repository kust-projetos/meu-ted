/**
 * Credit-card billing cycle helpers (single source).
 *
 * The purchase stores (canonical Postgres, legacy Postgres, in-memory) and the
 * approval-card projection must resolve the SAME statement cycle for a given
 * purchase date; otherwise the preview could name a different invoice than the
 * one the executor writes to. UTC + date-only arithmetic only.
 */

const iso = (y: number, m: number, day: number): string =>
  `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/** Closing date of the statement a purchase on `purchaseDate` belongs to. */
export function getClosingDate(purchaseDate: string, closingDay: number): string {
  const d = new Date(purchaseDate + 'T00:00:00.000Z');
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  if (d.getUTCDate() > closingDay) {
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return iso(y, m, Math.min(closingDay, lastDay));
}

/** Due date for a statement closing on `closingDate` with `dueDay`. */
export function getDueDate(closingDate: string, dueDay: number): string {
  const d = new Date(closingDate + 'T00:00:00.000Z');
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  if (dueDay <= d.getUTCDate()) {
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return iso(y, m, Math.min(dueDay, lastDay));
}
