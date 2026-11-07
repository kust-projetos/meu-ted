/**
 * P3 — PWA flow for the OpenCode proposal intent.
 *
 * The turn may carry a proposal INTENT; TedChat sends it to the authenticated
 * Agent broker (A4) and then rehydrates the card from the authoritative active
 * list. The browser never confirms anything here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedChat } from "../TedChat";
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
  return {
    ...actual,
    useAppState: () => ({ reconcileMutation: vi.fn() }),
    useOptionalAppState: () => ({ reconcileMutation: vi.fn() }),
  };
});

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const CATEGORY = "22222222-2222-4222-8222-222222222222";

const intent: agentClient.ProposalIntent = {
  tool: "transactions.expense.create",
  intentionId: "int-abc",
  normalizedArgs: {
    amountCents: 5000,
    description: "mercado",
    date: "2026-11-06",
    accountId: ACCOUNT,
    categoryId: CATEGORY,
  },
};

const activeCard = {
  id: "op-1",
  status: "proposed",
  tool: "transactions.expense.create",
  createdAt: "2026-11-06T10:00:00.000Z",
  expiresAt: "2026-11-06T15:00:00.000Z",
  amountCents: 5000,
  description: "mercado",
  date: "2026-11-06",
  accountId: ACCOUNT,
  categoryId: CATEGORY,
  presentation: {
    id: "op-1",
    status: "proposed",
    tool: "transactions.expense.create",
    title: "Confirmar despesa",
    amountCents: 5000,
    description: "mercado",
    date: "2026-11-06",
    account: { id: ACCOUNT, label: "Nubank" },
    category: { id: CATEGORY, label: "Mercado" },
    expiresAt: "2026-11-06T15:00:00.000Z",
    warnings: [],
  },
} as unknown as agentClient.ActivePendingOperation;

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

const send = async (text: string) => {
  const user = userEvent.setup();
  render(<TedChat />);
  await user.type(screen.getByLabelText("Mensagem para o assistente"), text);
  await user.click(screen.getByRole("button", { name: "Enviar mensagem" }));
};

const USER_TEXT = "Registre uma despesa de R$ 50 no mercado, na conta Nubank.";

const historyWithIntent = (messageId: string) => [
  {
    id: "hist-user-1",
    actorId: "actor-1",
    role: "user",
    content: USER_TEXT,
    createdAt: "2026-11-06T10:00:00.000Z",
    isOwn: true,
    intentionId: messageId,
  },
  {
    id: "hist-asst-1",
    actorId: "ted",
    role: "assistant",
    content: "Vou preparar a proposta de R$ 50,00 no mercado.",
    createdAt: "2026-11-06T10:00:01.000Z",
    isOwn: false,
    intentionId: messageId,
  },
];

const seedFailedProposalAnchor = () => {
  agentClient.savePendingChatSend(
    "ws-1",
    {
      messageId: "m-recover",
      content: USER_TEXT,
      createdAt: "2026-11-06T10:00:00.000Z",
      proposal: intent,
    },
    null,
  );
};

describe("TedChat — P3 proposal recovery after a lost broker call", () => {
  it("re-sends the persisted intent on reload and renders the authoritative card", async () => {
    seedFailedProposalAnchor();
    vi.spyOn(agentClient, "fetchAgentHistory").mockResolvedValue(historyWithIntent("m-recover"));
    let proposed = false;
    const propose = vi.spyOn(agentClient, "proposePendingOperation").mockImplementation(async () => {
      proposed = true;
      return { id: "op-1", existing: false };
    });
    vi.spyOn(agentClient, "fetchActivePendingOperations").mockImplementation(async () =>
      proposed ? [activeCard] : [],
    );
    const sendMessage = vi.spyOn(agentClient, "sendAgentMessage");

    const view = render(<TedChat />);

    const confirm = await screen.findByRole("button", { name: /Confirmar R\$ 50,00/ });
    expect(confirm).toBeTruthy();
    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose).toHaveBeenCalledWith("ws-1", intent);
    // Recovery never re-sends the chat turn; the original intentionId is kept.
    expect(sendMessage).not.toHaveBeenCalled();
    await waitFor(() => expect(agentClient.loadPendingChatSend("ws-1", null)).toBeNull());

    // A second reload has nothing left to recover and never duplicates.
    view.unmount();
    render(<TedChat />);
    await screen.findByRole("button", { name: /Confirmar R\$ 50,00/ });
    await waitFor(() => expect(propose).toHaveBeenCalledTimes(1));
  });

  it("recovers the EXISTING operation when the first broker call actually landed", async () => {
    seedFailedProposalAnchor();
    vi.spyOn(agentClient, "fetchAgentHistory").mockResolvedValue(historyWithIntent("m-recover"));
    const propose = vi.spyOn(agentClient, "proposePendingOperation").mockResolvedValue({
      id: "op-1",
      existing: true,
    });
    vi.spyOn(agentClient, "fetchActivePendingOperations").mockResolvedValue([activeCard]);

    render(<TedChat />);

    await screen.findByRole("button", { name: /Confirmar R\$ 50,00/ });
    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose).toHaveBeenCalledWith("ws-1", intent);
    expect(screen.getAllByRole("button", { name: /Confirmar R\$ 50,00/ })).toHaveLength(1);
    await waitFor(() => expect(agentClient.loadPendingChatSend("ws-1", null)).toBeNull());
  });

  it("keeps the anchor after a failed recovery, then succeeds on the next reload", async () => {
    seedFailedProposalAnchor();
    vi.spyOn(agentClient, "fetchAgentHistory").mockResolvedValue(historyWithIntent("m-recover"));
    let attempt = 0;
    const propose = vi.spyOn(agentClient, "proposePendingOperation").mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw Object.assign(new Error("broker offline"), { code: "agent.proposal_failed" });
      }
      return { id: "op-1", existing: false };
    });
    vi.spyOn(agentClient, "fetchActivePendingOperations").mockImplementation(async () =>
      attempt >= 2 ? [activeCard] : [],
    );

    const first = render(<TedChat />);
    await screen.findByText(/Não foi possível recuperar a proposta de despesa/);
    expect(agentClient.loadPendingChatSend("ws-1", null)?.proposal).toEqual(intent);
    expect(screen.queryByRole("button", { name: /Confirmar R\$/ })).toBeNull();

    first.unmount();
    render(<TedChat />);
    await screen.findByRole("button", { name: /Confirmar R\$ 50,00/ });
    expect(propose).toHaveBeenCalledTimes(2);
    // Both attempts carry the SAME idempotency identity.
    expect(propose.mock.calls[0]?.[1]?.intentionId).toBe(intent.intentionId);
    expect(propose.mock.calls[1]?.[1]?.intentionId).toBe(intent.intentionId);
    await waitFor(() => expect(agentClient.loadPendingChatSend("ws-1", null)).toBeNull());
  });
});

describe("TedChat — P3 proposal intent", () => {
  it("brokers the intent once, then renders the authoritative card", async () => {
    vi.spyOn(agentClient, "fetchAgentHistory").mockResolvedValue([]);
    let proposed = false;
    const propose = vi.spyOn(agentClient, "proposePendingOperation").mockImplementation(async () => {
      proposed = true;
      return { id: "op-1", existing: false };
    });
    vi.spyOn(agentClient, "fetchActivePendingOperations").mockImplementation(async () =>
      proposed ? [activeCard] : [],
    );
    vi.spyOn(agentClient, "sendAgentMessage").mockResolvedValue({
      turnId: "turn-1",
      status: "completed",
      output: "Vou preparar a proposta de R$ 50,00 no mercado.",
      proposal: intent,
    });

    await send("Registre uma despesa de R$ 50 no mercado, na conta Nubank.");

    const confirm = await screen.findByRole("button", { name: /Confirmar R\$ 50,00/ });
    expect(confirm).toBeTruthy();
    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose).toHaveBeenCalledWith("ws-1", intent, undefined);
  });

  it("never invents a card when the broker refuses; the message stays retryable", async () => {
    vi.spyOn(agentClient, "fetchAgentHistory").mockResolvedValue([]);
    vi.spyOn(agentClient, "fetchActivePendingOperations").mockResolvedValue([]);
    vi.spyOn(agentClient, "proposePendingOperation").mockRejectedValue(
      Object.assign(new Error("broker failed"), { code: "agent.proposal_failed" }),
    );
    vi.spyOn(agentClient, "sendAgentMessage").mockResolvedValue({
      turnId: "turn-1",
      status: "completed",
      output: "Vou preparar a proposta.",
      proposal: intent,
    });

    await send("Registre uma despesa de R$ 50 no mercado, na conta Nubank.");

    await screen.findByText(/Não foi possível preparar a proposta de despesa/);
    expect(screen.queryByRole("button", { name: /Confirmar R\$/ })).toBeNull();
  });

  it("rehydrates a pending proposal after reload without re-sending anything", async () => {
    const propose = vi.spyOn(agentClient, "proposePendingOperation");
    vi.spyOn(agentClient, "fetchAgentHistory").mockResolvedValue([]);
    vi.spyOn(agentClient, "fetchActivePendingOperations").mockResolvedValue([activeCard]);
    const sendMessage = vi.spyOn(agentClient, "sendAgentMessage");

    render(<TedChat />);

    const confirm = await screen.findByRole("button", { name: /Confirmar R\$ 50,00/ });
    expect(confirm).toBeTruthy();
    await waitFor(() => expect(propose).not.toHaveBeenCalled());
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

const incomeIntent: agentClient.ProposalIntent = {
  tool: "transactions.income.create",
  intentionId: "int-income-abc",
  normalizedArgs: {
    amountCents: 250000,
    description: "salário",
    date: "2026-11-07",
    accountId: ACCOUNT,
    categoryId: CATEGORY,
  },
};

const activeIncomeCard = {
  id: "op-income-1",
  status: "proposed",
  tool: "transactions.income.create",
  createdAt: "2026-11-07T10:00:00.000Z",
  expiresAt: "2026-11-07T15:00:00.000Z",
  amountCents: 250000,
  description: "salário",
  date: "2026-11-07",
  accountId: ACCOUNT,
  categoryId: CATEGORY,
  presentation: {
    id: "op-income-1",
    status: "proposed",
    tool: "transactions.income.create",
    title: "Confirmar receita",
    amountCents: 250000,
    description: "salário",
    date: "2026-11-07",
    account: { id: ACCOUNT, label: "Nubank" },
    category: { id: CATEGORY, label: "Salário" },
    expiresAt: "2026-11-07T15:00:00.000Z",
    warnings: [],
  },
} as unknown as agentClient.ActivePendingOperation;

describe("TedChat — P3.2 income proposal", () => {
  const INCOME_TEXT = "Registre uma receita de R$ 2.500 de salário na conta Nubank.";

  it("brokers the income intent once and renders the authoritative receita card", async () => {
    vi.spyOn(agentClient, "fetchAgentHistory").mockResolvedValue([]);
    let proposed = false;
    const propose = vi.spyOn(agentClient, "proposePendingOperation").mockImplementation(async () => {
      proposed = true;
      return { id: "op-income-1", existing: false };
    });
    vi.spyOn(agentClient, "fetchActivePendingOperations").mockImplementation(async () =>
      proposed ? [activeIncomeCard] : [],
    );
    vi.spyOn(agentClient, "sendAgentMessage").mockResolvedValue({
      turnId: "turn-income-1",
      status: "completed",
      output: "Vou preparar a proposta de receita de R$ 2.500,00.",
      proposal: incomeIntent,
    });

    await send(INCOME_TEXT);

    const confirm = await screen.findByRole("button", { name: /Confirmar R\$ 2\.500,00/ });
    expect(confirm).toBeTruthy();
    expect(screen.getByText(/Confirmar receita/)).toBeTruthy();
    expect(screen.getByText("Salário")).toBeTruthy();
    expect(screen.getByText("Nubank")).toBeTruthy();
    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose).toHaveBeenCalledWith("ws-1", incomeIntent, undefined);
    // The intent is not authority: no financial write happens here.
    expect(screen.queryByText(/registrada/i)).toBeNull();
  });

  it("keeps the income intent recoverable when the broker fails", async () => {
    vi.spyOn(agentClient, "fetchAgentHistory").mockResolvedValue([]);
    vi.spyOn(agentClient, "fetchActivePendingOperations").mockResolvedValue([]);
    vi.spyOn(agentClient, "proposePendingOperation").mockRejectedValue(
      Object.assign(new Error("broker failed"), { code: "agent.proposal_failed" }),
    );
    // Faithful mock of the real sendAgentMessage: a turn carrying a proposal
    // persists the retry anchor BEFORE the broker call.
    vi.spyOn(agentClient, "sendAgentMessage").mockImplementation(async (_workspaceId, content, opts) => {
      agentClient.savePendingChatSend(
        "ws-1",
        {
          messageId: opts?.messageId ?? "m-income-fail",
          content,
          createdAt: new Date().toISOString(),
          proposal: incomeIntent,
        },
        null,
      );
      return {
        turnId: "turn-income-2",
        status: "completed",
        output: "Vou preparar a proposta de receita.",
        proposal: incomeIntent,
      };
    });

    await send(INCOME_TEXT);

    await screen.findByText(/Não foi possível preparar a proposta de receita/);
    expect(screen.queryByRole("button", { name: /Confirmar R\$/ })).toBeNull();
    expect(agentClient.loadPendingChatSend("ws-1", null)?.proposal).toEqual(incomeIntent);
  });
});
