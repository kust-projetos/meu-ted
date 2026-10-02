/**
 * Duplicate-detector agent tool
 *
 * Calls the authoritative API endpoint POST /transactions/detect-duplicate.
 * The endpoint is workspace-isolated and uses household_id from delegated token.
 * This tool mirrors the server's findDuplicate + formatDuplicateWarning logic.
 *
 * Agent delegates via apiFetch: uses X-Workspace-Id + Authorization Bearer delegatedToken
 * to hit ${API_ORIGIN}/transactions/detect-duplicate.
 * No local DB access; all duplicate semantics (jaccard >=0.6, window ±1 day, idempotency key exact) live server-side.
 * See apps/api/src/transactions/duplicate-detector.ts for canonical algorithm.
 */

export type DuplicateCheckInput = {
  kind: "expense" | "income" | "transfer";
  description: string;
  amountCents: number;
  date: string; // YYYY-MM-DD
  accountId?: string;
  fromAccountId?: string;
  toAccountId?: string;
  idempotencyKey?: string;
};

export type DuplicateMatch = {
  id: string;
  description: string;
  amount_cents: string;
  date: string;
  match_type: "idempotency_key" | "semantic";
  similarity: number;
};

export type DuplicateCheckResult = {
  duplicate_detected: boolean;
  match?: DuplicateMatch;
  warning?: string;
};

/**
 * Format warning identically to server's formatDuplicateWarning.
 * Kept client-side so agent can surface a human-readable message without extra round-trip.
 */
export function formatDuplicateWarning(match: DuplicateMatch, newDesc: string): string {
  const dateStr = new Date(match.date).toISOString().slice(0, 10);
  const amount = (parseInt(match.amount_cents, 10) / 100).toFixed(2);
  const simPct = Math.round(match.similarity * 100);
  if (match.match_type === "idempotency_key") {
    return `Já existe um lançamento com essa chave de idempotência: ${match.description} — R$ ${amount} em ${dateStr} ID: ${match.id} Quer registrar mesmo assim?`;
  }
  return `Achei um lançamento parecido: "${match.description}" — R$ ${amount} em ${dateStr} (${simPct}% similar) Seu novo: "${newDesc}" É o mesmo gasto?`;
}

export async function detectDuplicateViaApi(
  input: DuplicateCheckInput,
  opts: { apiOrigin: string; workspaceId: string; delegatedToken: string; strict?: boolean },
): Promise<DuplicateCheckResult> {
  if (opts.strict) return detectDuplicateStrictResult(input, opts);
  const res = await fetch(`${opts.apiOrigin.replace(/\/$/, "")}/transactions/detect-duplicate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${opts.delegatedToken}`,
      "X-Workspace-Id": opts.workspaceId,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) return { duplicate_detected: false };
  const body = (await res.json()) as { duplicate_detected: boolean; match?: DuplicateMatch };
  if (!body.duplicate_detected || !body.match) return { duplicate_detected: false };
  return { duplicate_detected: true, match: body.match, warning: formatDuplicateWarning(body.match, input.description) };
}

const detectDuplicateStrictResult = async (
  input: DuplicateCheckInput,
  opts: { apiOrigin: string; workspaceId: string; delegatedToken: string },
): Promise<DuplicateCheckResult> => {
  try {
  const res = await fetch(`${opts.apiOrigin.replace(/\/$/, "")}/transactions/detect-duplicate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${opts.delegatedToken}`,
      "X-Workspace-Id": opts.workspaceId,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    return { duplicate_detected: true };
  }
  const body = (await res.json()) as { duplicate_detected?: unknown; match?: DuplicateMatch };
  if (typeof body.duplicate_detected !== 'boolean') return { duplicate_detected: true };
  if (!body.duplicate_detected) return { duplicate_detected: false };
  if (!body.match) return { duplicate_detected: true };
  return {
    duplicate_detected: true,
    match: body.match,
    warning: formatDuplicateWarning(body.match, input.description),
  };
  } catch {
    return { duplicate_detected: true };
  }
}

export const detectDuplicateSuspectedStrict = async (
  input: DuplicateCheckInput,
  opts: Omit<Parameters<typeof detectDuplicateViaApi>[1], 'strict'>,
): Promise<boolean> => (await detectDuplicateViaApi(input, { ...opts, strict: true })).duplicate_detected;

/**
 * Agent tool spec for use with the generated HTTP tools pipeline.
 * When running inside .pi/extensions/financial-tools, the canonical tool is generated from
 * apps/api/openapi/agent-tools.openapi.json (operationId: detect_duplicate).
 * This module is the human-readable documentation and a fallback direct implementation.
 */
export const duplicateDetectorToolSpec = {
  name: "detect_duplicate",
  label: "Detect Duplicate",
  description:
    "Check if a transaction would be a duplicate (idempotency_key exact or semantic amount+description+date±1d, jaccard >=0.6). Uses POST /transactions/detect-duplicate.",
  inputSchema: {
    kind: "expense | income | transfer",
    description: "string (1-240)",
    amountCents: "integer >=1",
    date: "YYYY-MM-DD",
    accountId: "uuid optional",
    fromAccountId: "uuid optional",
    toAccountId: "uuid optional",
    idempotencyKey: "string optional",
  },
  endpoint: "POST /transactions/detect-duplicate",
  workspaceIsolated: true,
} as const;
