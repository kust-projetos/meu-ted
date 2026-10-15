import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedUndoCard } from "../TedUndoCard";
import * as agentClient from "@/lib/api/agent-client";

vi.mock("@/lib/api/agent-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/agent-client")>();
  return { ...actual, decideUndoProposal: vi.fn() };
});

const PROPOSAL = {
  requestId: "proposal-1",
  status: "proposed" as const,
  expiresAt: "2026-09-19T12:00:00.000Z",
};

const withCode = (message: string, code: string) =>
  Object.assign(new Error(message), { code });

describe("TedUndoCard fixed target (FIX-P1-UX #172)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the display-safe fixed target (tipo/valor/descrição/conta/data) when projected", () => {
    render(
      <TedUndoCard
        proposal={{
          ...PROPOSAL,
          target: {
            kind: "Despesa",
            description: "Mercado",
            amountCents: 85000,
            accountLabel: "Nubank",
            occurredOn: "2026-09-14",
          },
        }}
        workspaceId="ws-1"
      />,
    );

    expect(screen.getByTestId("ted-undo-card")).toBeInTheDocument();
    expect(screen.getByText("Despesa")).toBeInTheDocument();
    expect(screen.getByText("Mercado")).toBeInTheDocument();
    expect(screen.getByText("R$ 850,00")).toBeInTheDocument();
    expect(screen.getByText("Nubank")).toBeInTheDocument();
    expect(screen.getByText("14/09/2026")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirmar desfazer" })).toBeInTheDocument();
  });

  it("blocks Confirm when the projected target is not display-safe (inexibível => ação bloqueada)", async () => {
    const user = userEvent.setup();
    render(
      <TedUndoCard
        proposal={{
          ...PROPOSAL,
          target: {
            kind: "Despesa",
            // Empty description: nothing human-reviewable to authorize.
            description: "   ",
            amountCents: 85000,
          },
        }}
        workspaceId="ws-1"
      />,
    );

    expect(screen.getByText(/não é possível confirmar/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirmar desfazer" })).not.toBeInTheDocument();
    // Canceling moves no money, so Cancel stays available.
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(agentClient.decideUndoProposal).toHaveBeenCalledWith("ws-1", "proposal-1", "cancel"),
    );
    expect(
      vi.mocked(agentClient.decideUndoProposal).mock.calls.every(([, , decision]) => decision !== "confirm"),
    ).toBe(true);
  });

  it("confirms exclusively through the card RPC — the card has no text path to decide", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decideUndoProposal).mockResolvedValue({
      requestId: "proposal-1",
      status: "confirmed",
    });

    render(<TedUndoCard proposal={PROPOSAL} workspaceId="ws-1" />);

    // No textbox exists: model/user text can never decide from this card.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirmar desfazer" }));

    await waitFor(() =>
      expect(agentClient.decideUndoProposal).toHaveBeenCalledWith("ws-1", "proposal-1", "confirm"),
    );
    expect(agentClient.decideUndoProposal).toHaveBeenCalledTimes(1);
  });

  it("a terminal server denial (409 undo.terminal) ends the card honestly — no buttons, no fake success", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decideUndoProposal).mockRejectedValueOnce(
      withCode("Undo proposal already decided.", "undo.terminal"),
    );

    render(<TedUndoCard proposal={PROPOSAL} workspaceId="ws-1" />);
    await user.click(screen.getByRole("button", { name: "Confirmar desfazer" }));

    expect(await screen.findByTestId("ted-undo-terminal")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirmar desfazer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancelar" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("ted-undo-confirmed")).not.toBeInTheDocument();
  });

  it("a pending server code (undo.executing) parks the card with no buttons until the server converges", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decideUndoProposal).mockRejectedValueOnce(
      withCode("Undo already in progress.", "undo.executing"),
    );

    render(<TedUndoCard proposal={PROPOSAL} workspaceId="ws-1" />);
    await user.click(screen.getByRole("button", { name: "Confirmar desfazer" }));

    expect(await screen.findByTestId("ted-undo-pending")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirmar desfazer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancelar" })).not.toBeInTheDocument();
  });
});
