/**
 * T5.3 deep-link (SPEC §22) — TED focuses the selected pending operation.
 *
 * - `openTedChat({ operationId })` navigates to `/ted?operationId=…` (the
 *   launcher owns the push; asserted in TedChatLauncher.test).
 * - The page (`TedChatPage`) reads `?operationId=` into `focusedOperationId`.
 * - The chat highlights/focuses the matching approval card accessibly and
 *   never invents a card: an unknown id stays honest.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedChat } from "../TedChat";
import { TedChatPage } from "../TedChatPage";
import { OPEN_TED_CHAT_EVENT } from "../TedChatLauncher";
import * as agentClient from "@/lib/api/agent-client";

vi.mock("@/lib/auth/workspace-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/workspace-context")>();
  const mockWs = {
    workspaces: [{ id: "ws-1", name: "Minhas Finanças", kind: "personal" as const, role: "owner" }],
    activeWorkspace: { id: "ws-1", name: "Minhas Finanças", kind: "personal" as const, role: "owner" },
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
  const actual = await importOriginal<typeof import("@/lib/state/app-state-context")>();
  return { ...actual, useAppState: () => ({ reconcileMutation: vi.fn() }) };
});

const navigation = vi.hoisted(() => ({
  search: "",
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: string; alt: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} />
  ),
}));

const pendingOp = (id: string) => ({
  id,
  status: "proposed" as const,
  operation: "transactions.expense.create",
  summary: id === "op-2" ? "Assinatura" : "Mercado",
});

describe("TedChat deep-link focus (T5.3)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    navigation.search = "";
  });

  it("focuses/highlights the selected approval card without inventing state", async () => {
    vi.spyOn(agentClient, "fetchAgentHistory").mockResolvedValue([]);
    vi.spyOn(agentClient, "sendAgentMessage").mockResolvedValue({
      turnId: "turn-1",
      status: "completed",
      pendingOperation: pendingOp("op-1"),
    });

    const user = userEvent.setup();
    render(<TedChat focusedOperationId="op-1" />);

    await user.type(screen.getByLabelText("Mensagem para o assistente"), "registre mercado 850");
    await user.click(screen.getByRole("button", { name: "Enviar mensagem" }));

    const focused = await screen.findByTestId("ted-approval-focused");
    expect(focused).toHaveTextContent("Mercado");
    // Accessible focus target: the focused card wrapper receives focus.
    await waitFor(() => expect(focused).toHaveFocus());
  });

  it("stays honest when the selected operation is unavailable", async () => {
    vi.spyOn(agentClient, "fetchAgentHistory").mockResolvedValue([]);
    vi.spyOn(agentClient, "sendAgentMessage").mockResolvedValue({ turnId: "t", status: "completed" });

    render(<TedChat focusedOperationId="op-missing" />);

    expect(
      await screen.findByText("Operação não encontrada nesta conversa."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("ted-approval-focused")).not.toBeInTheDocument();
    // No second executor: the honest fallback never renders approve/cancel itself.
    expect(screen.queryByRole("button", { name: /^Aprovar$/i })).not.toBeInTheDocument();
  });

  it("TedChatPage routes ?operationId= into the chat focus", async () => {
    vi.spyOn(agentClient, "fetchAgentHistory").mockResolvedValue([]);
    vi.spyOn(agentClient, "sendAgentMessage").mockResolvedValue({
      turnId: "turn-1",
      status: "completed",
      pendingOperation: pendingOp("op-9"),
    });
    navigation.search = "operationId=op-9";

    render(<TedChatPage />);

    // The page renders the page-bound chat…
    expect(await screen.findByRole("region", { name: "Chat com TED" })).toBeInTheDocument();
    // …and the routed id reaches it as the focus target: unknown ids stay
    // honest until the authoritative card arrives.
    expect(
      await screen.findByText("Operação não encontrada nesta conversa."),
    ).toBeInTheDocument();
    expect(OPEN_TED_CHAT_EVENT).toBe("pwa:open-ted");
  });
});
