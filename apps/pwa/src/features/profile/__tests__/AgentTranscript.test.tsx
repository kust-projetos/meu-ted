import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/lib/test-utils";
import { AgentTranscript } from "../ProfilePage";
import * as agentClient from "@/lib/api/agent-client";

vi.mock("@/lib/api/agent-client", () => ({
  fetchAgentHistory: vi.fn(),
  sendAgentMessage: vi.fn(),
}));

describe("AgentTranscript – Canonical REST Contract & Display Sanitization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([
      { id: "m1", actorId: "user-uuid-12345", role: "user", content: "Minha mensagem", isOwn: true, createdAt: undefined },
      { id: "m2", actorId: "ted", role: "assistant", content: "Mensagem do TED", isOwn: false, createdAt: undefined },
      { id: "m3", actorId: "user-uuid-67890", role: "user", content: "Mensagem de outro membro", isOwn: false, createdAt: undefined },
    ]);
  });

  it("renders messages for workspace from canonical history and does NOT display raw actorId", async () => {
    render(<AgentTranscript open workspaceId="workspace-shared" />);

    expect(await screen.findByText("Minha mensagem")).toBeInTheDocument();
    expect(screen.getByText("Mensagem do TED")).toBeInTheDocument();
    expect(screen.getByText("Mensagem de outro membro")).toBeInTheDocument();

    // Must display human-friendly names
    expect(screen.getByText("Você")).toBeInTheDocument();
    expect(screen.getByText("TED")).toBeInTheDocument();
    expect(screen.getByText("Membro")).toBeInTheDocument();

    // Must NOT display raw actor IDs
    expect(screen.queryByText("user-uuid-12345")).not.toBeInTheDocument();
    expect(screen.queryByText("user-uuid-67890")).not.toBeInTheDocument();

    expect(agentClient.fetchAgentHistory).toHaveBeenCalledWith("workspace-shared");
  });

  it("shows a safe error when canonical history cannot be loaded", async () => {
    vi.mocked(agentClient.fetchAgentHistory).mockRejectedValueOnce(new Error("upstream token detail"));

    render(<AgentTranscript open workspaceId="workspace-shared" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar o histórico.");
    expect(screen.queryByText("Minha mensagem")).not.toBeInTheDocument();
    expect(screen.queryByText("upstream token detail")).not.toBeInTheDocument();
  });

  it("ignores a late history response from the previously selected workspace", async () => {
    let resolveOldHistory!: (items: agentClient.AgentMessage[]) => void;
    const oldHistory = new Promise<agentClient.AgentMessage[]>((resolve) => {
      resolveOldHistory = resolve;
    });
    vi.mocked(agentClient.fetchAgentHistory)
      .mockReturnValueOnce(oldHistory)
      .mockResolvedValueOnce([
        { id: "workspace-b-message", actorId: "user-b", role: "user", content: "Mensagem do workspace B", isOwn: true, createdAt: undefined },
      ]);

    const { rerender } = render(<AgentTranscript open workspaceId="workspace-a" />);
    rerender(<AgentTranscript open workspaceId="workspace-b" />);

    expect(await screen.findByText("Mensagem do workspace B")).toBeInTheDocument();

    await act(async () => {
      resolveOldHistory([
        { id: "workspace-a-message", actorId: "user-a", role: "user", content: "Mensagem do workspace A", isOwn: true, createdAt: undefined },
      ]);
    });

    expect(screen.queryByText("Mensagem do workspace A")).not.toBeInTheDocument();
    expect(screen.getByText("Mensagem do workspace B")).toBeInTheDocument();
  });

  it("does not render export or delete controls without Finance contract", async () => {
    render(<AgentTranscript open workspaceId="workspace-shared" />);

    expect(await screen.findByText("Minha mensagem")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /exportar histórico/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /excluir meu histórico/i })).not.toBeInTheDocument();
  });

  it("sends message and reloads canonical history via /rpc/chat + /rpc/history only", async () => {
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValue({ turnId: "t1", status: "completed", output: "Resposta do agente" });

    render(<AgentTranscript open workspaceId="workspace-shared" />);
    const input = await screen.findByRole("textbox", { name: "Mensagem do agente" });
    fireEvent.change(input, { target: { value: "Olá" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));

    expect(agentClient.sendAgentMessage).toHaveBeenCalledWith("workspace-shared", "Olá");

    await waitFor(() => {
      expect(agentClient.fetchAgentHistory).toHaveBeenCalledTimes(2);
    });

    // T4.2: the legacy turn helpers (process/retry → 410, reconnect stream,
    // export/delete) are REMOVED — the transcript path uses only the
    // canonical send + history calls asserted above.
  });

  it("does not expose legacy approval actions in the profile transcript", async () => {
    render(<AgentTranscript open workspaceId="workspace-shared" />);

    expect(await screen.findByText("Minha mensagem")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aprovar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rejeitar" })).not.toBeInTheDocument();
  });
});
