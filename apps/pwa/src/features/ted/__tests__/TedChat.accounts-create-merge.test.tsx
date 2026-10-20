/**
 * accounts.create — merge turno × active list (TASK_ID accounts-card-pwa-round2).
 *
 * Evidência live: POST propose → 201 com payload completo
 * (kind bank, name nubank, initialBalanceCents 14500), active list com
 * presentation acionável, mas o card do turno renderizou "Dados da operação
 * incompletos" (só Cancelar). Causa no PWA: o `executeSend` aplicava o
 * `pendingOperation` do turno DEPOIS do reload da active list, sobrescrevendo
 * o card acionável da lista com a versão sem presentation do turno.
 *
 * Contrato: o merge nunca degrada um card acionável da active list para a
 * forma incompleta do turno (mesmo id). Sem card existente, o turno ainda
 * minta o card (eventual consistency).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedChat } from "../TedChat";
import * as agentClient from "@/lib/api/agent-client";

vi.mock("@/lib/auth/workspace-context", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/auth/workspace-context")
  >();
  const mockWs = {
    workspaces: [
      { id: "ws-1", name: "Minhas Finanças", kind: "personal" as const, role: "owner" },
    ],
    activeWorkspace: {
      id: "ws-1",
      name: "Minhas Finanças",
      kind: "personal" as const,
      role: "owner",
    },
    members: [],
    loading: false,
    membersLoading: false,
    error: null,
    selectWorkspace: vi.fn(),
    refreshWorkspaces: vi.fn(),
    refreshMembers: vi.fn(),
    createWorkspace: vi.fn(),
    inviteMember: vi.fn(),
    acceptInvite: vi.fn(),
    removeMember: vi.fn(),
    leave: vi.fn(),
  };
  return { ...actual, useWorkspace: () => mockWs, useWorkspaceSafe: () => mockWs };
});

vi.mock("@/lib/state/app-state-context", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/state/app-state-context")
  >();
  return { ...actual, useAppState: () => null, useOptionalAppState: () => null };
});

const accountPresentation = (
  id: string,
): agentClient.PendingOperationPresentation => ({
  id,
  status: "proposed",
  tool: "accounts.create",
  title: "Confirmar conta",
  accountName: "nubank",
  accountKind: "bank",
  initialBalanceCents: 14500,
  expiresAt: "2026-10-20T15:30:00.000Z",
  warnings: [],
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("TedChat accounts.create — merge turno × active list", () => {
  it("turno sem presentation NÃO degrada o card acionável da active list (mesmo id)", async () => {
    const user = userEvent.setup();
    vi.spyOn(agentClient, "fetchAgentHistory").mockResolvedValue([]);
    // Active list autoritativa: presentation completa (Conta/Tipo/Saldo).
    vi.spyOn(agentClient, "fetchActivePendingOperations").mockResolvedValue([
      {
        id: "op-acc-live",
        status: "proposed",
        tool: "accounts.create",
        createdAt: "2026-10-20T15:39:00.000Z",
        expiresAt: "2026-10-20T15:50:00.000Z",
        description: "Criar conta nubank",
        presentation: accountPresentation("op-acc-live"),
      },
    ]);
    // Turno retorna o MESMO id SEM presentation (payload do turno incompleto).
    vi.spyOn(agentClient, "sendAgentMessage").mockResolvedValue({
      turnId: "turn-acc-1",
      status: "completed",
      output: "Proposta: nubank. Confirma?",
      pendingOperation: {
        id: "op-acc-live",
        status: "proposed",
        operation: "accounts.create",
        summary: "Proposta: nubank. Confirma?",
      },
    });

    render(<TedChat />);

    // Card acionável da active list monta no load inicial.
    expect(await screen.findByText("nubank")).toBeInTheDocument();

    await user.type(
      screen.getByLabelText("Mensagem para o assistente"),
      "conta no banco",
    );
    await user.click(screen.getByRole("button", { name: "Enviar mensagem" }));

    // Após o turno, o card segue acionável: Conta/Tipo/Saldo + Confirmar.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Confirmar" })).toBeInTheDocument(),
    );
    expect(screen.getByText("nubank")).toBeInTheDocument();
    expect(screen.getByText("Banco")).toBeInTheDocument();
    expect(screen.getByText("R$ 145,00")).toBeInTheDocument();
    expect(
      screen.queryByText(/dados da operação incompletos/i),
    ).not.toBeInTheDocument();
  });

  it("turno sem card existente ainda minta o card (eventual consistency)", async () => {
    const user = userEvent.setup();
    vi.spyOn(agentClient, "fetchAgentHistory").mockResolvedValue([]);
    // Active list vazia (ainda não convergiu): o turno é a única fonte.
    vi.spyOn(agentClient, "fetchActivePendingOperations").mockResolvedValue([]);
    vi.spyOn(agentClient, "sendAgentMessage").mockResolvedValue({
      turnId: "turn-acc-2",
      status: "completed",
      output: "Proposta: nubank. Confirma?",
      pendingOperation: {
        id: "op-acc-new",
        status: "proposed",
        operation: "accounts.create",
        summary: "Proposta: nubank. Confirma?",
        presentation: accountPresentation("op-acc-new"),
      },
    });

    render(<TedChat />);

    await user.type(
      screen.getByLabelText("Mensagem para o assistente"),
      "conta no banco",
    );
    await user.click(screen.getByRole("button", { name: "Enviar mensagem" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Confirmar" })).toBeInTheDocument(),
    );
    expect(screen.getByText("nubank")).toBeInTheDocument();
  });

  it("Confirmar no card de conta aprova a op certa (id da active list)", async () => {
    const user = userEvent.setup();
    vi.spyOn(agentClient, "fetchAgentHistory").mockResolvedValue([]);
    vi.spyOn(agentClient, "fetchActivePendingOperations").mockResolvedValue([
      {
        id: "op-acc-live",
        status: "proposed",
        tool: "accounts.create",
        createdAt: "2026-10-20T15:39:00.000Z",
        expiresAt: "2026-10-20T15:50:00.000Z",
        description: "Criar conta nubank",
        presentation: accountPresentation("op-acc-live"),
      },
    ]);
    const decideSpy = vi
      .spyOn(agentClient, "decidePendingOperation")
      .mockResolvedValue({ operationId: "op-acc-live", status: "cancelled" });

    render(<TedChat />);
    await user.click(await screen.findByRole("button", { name: "Cancelar" }));

    await waitFor(() =>
      expect(decideSpy).toHaveBeenCalledWith("ws-1", "op-acc-live", "cancel"),
    );
  });
});
