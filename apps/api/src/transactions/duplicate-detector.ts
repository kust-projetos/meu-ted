import type { Pool } from "pg";

export interface DuplicateCheckParams {
  householdId: string;
  kind: "expense" | "income" | "transfer";
  description: string;
  amountCents: number;
  date: string;
  accountId?: string | undefined;
  fromAccountId?: string | undefined;
  toAccountId?: string | undefined;
  idempotencyKey?: string | undefined;
  windowDays?: number;
}

export interface DuplicateMatch {
  id: string;
  kind: string;
  amount_cents: string;
  description: string;
  date: Date;
  from_account_id: string | null;
  to_account_id: string | null;
  created_at: Date;
  match_type: "idempotency_key" | "semantic";
  similarity: number;
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(em|no|na|de|da|do|com|para|pra|e|ou|a|o)\b/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function jaccardSimilarity(a: string, b: string): number {
  const tokensA = new Set(normalize(a).split(" ").filter(Boolean));
  const tokensB = new Set(normalize(b).split(" ").filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) if (tokensB.has(t)) intersection++;
  return intersection / (tokensA.size + tokensB.size - intersection);
}

export async function findDuplicate(
  pool: Pool,
  params: DuplicateCheckParams
): Promise<DuplicateMatch | null> {
  const windowDays = params.windowDays ?? 1;
  const minDate = new Date(new Date(params.date).getTime() - windowDays * 86400000).toISOString().slice(0, 10);
  const maxDate = new Date(new Date(params.date).getTime() + windowDays * 86400000).toISOString().slice(0, 10);

  // FIX-API-DUPLICATE-CANONICAL: the canonical `transactions` table has no
  // `from_account_id`/`to_account_id`/`idempotency_key` columns — the legacy
  // pre-query 500'd every call (`column "from_account_id" does not exist`).
  // Canonical idempotency is enforced authoritatively at write time (the same
  // key cannot create twice), so the pre-create warning only needs the
  // semantic scan over the canonical columns, aliased to the legacy match
  // shape to keep consumers unchanged.
  void params.idempotencyKey;
  const accountId = params.accountId ?? params.fromAccountId;
  const result = await pool.query(
    `SELECT id, kind, amount_cents, description, date, account_id AS from_account_id, transfer_to_account_id AS to_account_id, created_at
     FROM transactions
     WHERE household_id = $1
       AND kind = $2
       AND amount_cents = $3
       AND date BETWEEN $4 AND $5
       AND deleted_at IS NULL
       AND (
         ($6::uuid IS NOT NULL AND (account_id = $6 OR transfer_to_account_id = $6))
         OR ($6::uuid IS NULL)
       )
     ORDER BY created_at DESC
     LIMIT 20`,
    [params.householdId, params.kind, params.amountCents, minDate, maxDate, accountId ?? null]
  );

  let bestMatch: DuplicateMatch | null = null;
  for (const r of result.rows) {
    const row = r as any;
    const sim = jaccardSimilarity(params.description, row.description);
    if (sim >= 0.6 && (!bestMatch || sim > bestMatch.similarity)) {
      bestMatch = { ...row, match_type: "semantic", similarity: sim };
    }
  }
  return bestMatch;
}

export function formatDuplicateWarning(match: DuplicateMatch, newDesc: string): string {
  const dateStr = new Date(match.date).toISOString().slice(0, 10);
  const amount = (parseInt(match.amount_cents, 10) / 100).toFixed(2);
  const simPct = Math.round(match.similarity * 100);
  if (match.match_type === "idempotency_key") {
    return `Já existe um lançamento com essa chave de idempotência: ${match.description} — R$ ${amount} em ${dateStr} ID: ${match.id} Quer registrar mesmo assim?`;
  }
  return `Achei um lançamento parecido: "${match.description}" — R$ ${amount} em ${dateStr} (${simPct}% similar) Seu novo: "${newDesc}" É o mesmo gasto?`;
}
