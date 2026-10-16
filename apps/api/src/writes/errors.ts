/**
 * Domain errors for write operations.
 *
 * Mapped to HTTP 4xx by the route layer. `code` is the stable machine
 * string; `message` is human PT-BR.
 */

export type DomainErrorCode =
  | "validation.required"
  | "validation.invalid"
  | "not_found"
  | "household_mismatch"
  | "in_use"
  | "conflict"
  | "workspace.archived"
  | "workspace.deleted"
  | "idempotency.conflict"
  | "idempotency.in_progress"
  | "idempotency.atomic_mutation_not_supported"
  | "unsupported"
  | "approval.not_found"
  | "approval.requester_only"
| "approval.not_pending"
  | "undo.nothing_to_undo";

export class DomainError extends Error {
  readonly statusCode: number;
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string, statusCode = 400) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const messages = {
  required: (field: string): string => `O campo "${field}" é obrigatório.`,
  invalid: (field: string, why?: string): string =>
    `O campo "${field}" é inválido${why ? ` (${why})` : ""}.`,
  notFound: (entity: string): string => `${entity} não encontrado.`,
  householdMismatch: (entity: string): string =>
    `${entity} não pertence ao seu household.`,
  inUse: (entity: string, what: string): string =>
    `${entity} possui ${what} ativos; resolva antes de desativar.`,
  idempotencyConflict: (): string =>
    "Chave de idempotência já utilizada com payload diferente.",
  unsupported: (what: string): string => `Operação não suportada: ${what}.`,
};

export const domainErrors = {
  required: (field: string): DomainError =>
    new DomainError("validation.required", messages.required(field), 400),
  invalid: (field: string, why?: string): DomainError =>
    new DomainError("validation.invalid", messages.invalid(field, why), 400),
  notFound: (entity: string): DomainError =>
    new DomainError("not_found", messages.notFound(entity), 404),
  householdMismatch: (entity: string): DomainError =>
    new DomainError(
      "household_mismatch",
      messages.householdMismatch(entity),
      403,
    ),
  inUse: (entity: string, what: string): DomainError =>
    new DomainError("in_use", messages.inUse(entity, what), 409),
  conflict: (message: string): DomainError =>
    new DomainError("conflict", message, 409),
  idempotencyConflict: (): DomainError =>
    new DomainError(
      "idempotency.conflict",
      messages.idempotencyConflict(),
      409,
    ),
  // Finding 3: a live `processing` claim owned by another worker is an
  // explicit 409 (never a null-response replay). Same key+payload retries
  // after lease expiry take over; while the lease holds the caller waits.
  idempotencyInProgress: (): DomainError =>
    new DomainError(
      "idempotency.in_progress",
      "Operação idêntica ainda em processamento; repita com a mesma chave.",
      409,
    ),
  // V4.1 Phase 4 (fail-closed atomicity): a keyed mutation arrived with an
  // open claim transaction, but the backing store exposes no `*InTx`
  // extension for the required operation — running the plain method would
  // commit the effect OUTSIDE the claim transaction and silently lose
  // atomicity. 500 (server-side invariant, never a client conflict);
  // message is generic so no internals leak to clients.
  atomicMutationNotSupported: (): DomainError =>
    new DomainError(
      "idempotency.atomic_mutation_not_supported",
      "Operação não pôde ser executada com atomicidade garantida; tente novamente sem chave de idempotência.",
      500,
    ),
  unsupported: (what: string): DomainError =>
    new DomainError("unsupported", messages.unsupported(what), 400),
  approvalNotFound: (): DomainError =>
    new DomainError(
      "approval.not_found",
      "Operação pendente não encontrada.",
      404,
    ),
  approvalRequesterOnly: (): DomainError =>
    new DomainError(
      "approval.requester_only",
      "Somente o solicitante pode aprovar esta operação.",
      403,
    ),
  approvalNotPending: (): DomainError =>
    new DomainError(
      "approval.not_pending",
      "A operação pendente já foi processada ou expirou.",
      409,
    ),
  undoNothingToUndo: (): DomainError =>
    new DomainError(
      "undo.nothing_to_undo",
      "Nada para desfazer para este workspace e ator.",
      404,
    ),
};
