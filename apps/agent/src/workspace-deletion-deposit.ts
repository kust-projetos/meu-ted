/**
 * FIX-WS-D2-R5 — depósito server-side da prova de vazio (Agent→API).
 *
 * A prova HMAC (conteúdo + contagens + HMAC) viaja SÓ aqui, de servidor
 * para servidor (`POST /internal/agent/empty-attestations` na API,
 * autenticado por service token). O browser recebe SÓ o handle opaco
 * (`{ attestationId }`) — nunca conteúdo, contagens ou HMAC.
 *
 * Falha de depósito (rede, 401/403 de auth, 409 da API, corpo
 * inesperado) vira `agent.attestation_unavailable` (409, fail-closed):
 * o chamador nunca recebe prova parcial nem detalhe interno.
 */

import {
  AgentAttestationError,
  type AgentEmptyProof,
} from "./workspace-deletion-attestation.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DepositDeps = {
  fetchFn?: typeof fetch;
};

const unavailable = (): AgentAttestationError =>
  new AgentAttestationError(
    "agent.attestation_unavailable",
    "Depósito da atestação indisponível no momento.",
    409,
  );

/**
 * Deposita a prova na API e retorna SÓ o handle opaco. A prova nunca
 * aparece no valor de retorno, na mensagem de erro ou em log — só no
 * corpo server-to-server para a API.
 */
export const depositEmptyAttestationProof = async (
  input: {
    apiOrigin: string;
    serviceToken: string;
    actorId: string;
    proof: AgentEmptyProof;
  },
  deps?: DepositDeps,
): Promise<{ attestationId: string }> => {
  const fetchFn = deps?.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(
      `${input.apiOrigin.replace(/\/$/, "")}/internal/agent/empty-attestations`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-service-token": input.serviceToken,
        },
        body: JSON.stringify({ actorId: input.actorId, proof: input.proof }),
        // Nunca seguir redirect para host que o operador não nomeou
        // (mesmo padrão do relay LLM): 3xx vira indisponível fail-closed.
        redirect: "manual",
      },
    );
  } catch {
    throw unavailable();
  }
  if (response.status !== 201) throw unavailable();
  let attestationId: unknown;
  try {
    attestationId = (await response.json() as { attestationId?: unknown }).attestationId;
  } catch {
    throw unavailable();
  }
  if (typeof attestationId !== "string" || !UUID_RE.test(attestationId)) throw unavailable();
  return { attestationId };
};
