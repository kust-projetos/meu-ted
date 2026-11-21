import { render, screen, waitFor, waitForElementToBeRemoved } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import ProfilePage from "../ProfilePage";
import * as appStateModule from "@/lib/state/app-state-context";
import * as sessionContextModule from "@/lib/auth/session-context";
import { ApiError } from "@/lib/api/client";
import type { AppState } from "@/lib/state/app-state-context";
import type { Profile } from "@/lib/state/types";
import { mockAccounts, mockCategories, ALL_MOCK_TRANSACTIONS, mockPayables, mockBudgets, mockGoals } from "@/lib/state/mock-data";

const mockRouter = { push: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
}));

const signOutMock = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock("@/lib/api/auth", async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return { ...mod, signOut: signOutMock.signOut };
});

function fakeState(overrides?: Partial<AppState>): AppState {
  return {
    accounts: [...mockAccounts],
    categories: [...mockCategories],
    transactions: [...ALL_MOCK_TRANSACTIONS],
    payables: [...mockPayables],
    budgets: [...mockBudgets],
    goals: [...mockGoals],
    debts: [], subscriptions: [], loading: false, error: null,
    cardStatements: [], profile: null,
    saveProfile: vi.fn().mockResolvedValue(undefined),
    refreshProfile: vi.fn().mockResolvedValue(undefined),
    addTransaction: vi.fn(), deleteTransaction: vi.fn(), markPayablePaid: vi.fn(), cancelPayable: vi.fn(), createPayable: vi.fn(),
    createBudget: vi.fn(), updateBudget: vi.fn(),
    createGoal: vi.fn(), contributeToGoal: vi.fn(), cancelGoal: vi.fn(),
    addAccount: vi.fn(), updateAccount: vi.fn(), deactivateAccount: vi.fn(),
    addCategory: vi.fn(), updateCategory: vi.fn(), deactivateCategory: vi.fn(),
    addCard: vi.fn(), updateCard: vi.fn(),
    addSubscription: vi.fn(), cancelSubscription: vi.fn(), refreshSubscriptions: vi.fn(),
    createTransfer: vi.fn(), payStatement: vi.fn(), createInstallments: vi.fn(),
    updateTransaction: vi.fn(),
    writeError: null, clearWriteError: vi.fn(),
    sync: {
      accounts: { source: "mock", syncedAt: null },
      categories: { source: "mock", syncedAt: null },
      transactions: { source: "mock", syncedAt: null },
      payables: { source: "mock", syncedAt: null },
      budgets: { source: "mock", syncedAt: null },
      goals: { source: "mock", syncedAt: null },
      subscriptions: { source: "mock", syncedAt: null },
      cardStatements: { source: "mock", syncedAt: null },
    },
    readOnly: false,
    ...overrides,
  } as AppState;
}

const SAMPLE_PROFILE: Profile = {
  householdId: "h-1",
  name: "Marina",
  email: "marina@email.com",
  phone: "(11) 99999-9999",
  avatarColor: "#0E8C5A",
  greetingStyle: "auto",
  updatedAt: "2026-07-02T12:00:00.000Z",
};

describe("ProfilePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(fakeState());
    signOutMock.signOut.mockResolvedValue(undefined);
    vi.spyOn(sessionContextModule, "useSession").mockReturnValue({
      expireSession: vi.fn(),
      session: { status: "unknown" },
    });
  });

  it("renders the page header", () => {
    render(<ProfilePage />);
    expect(screen.getByText("Perfil")).toBeInTheDocument();
  });

  it("renders the profile name from the loaded profile", () => {
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(
      fakeState({ profile: SAMPLE_PROFILE }),
    );
    render(<ProfilePage />);
    expect(screen.getByText("Marina")).toBeInTheDocument();
    expect(screen.getByText("marina@email.com")).toBeInTheDocument();
  });

  it("renders fallback name when profile is not loaded yet", () => {
    render(<ProfilePage />);
    expect(screen.getByText("Visitante")).toBeInTheDocument();
  });

  it("renders Editar perfil item", () => {
    render(<ProfilePage />);
    expect(screen.getByText("Editar perfil")).toBeInTheDocument();
  });

  it("does not render Assistente TED or Segurança placeholders", () => {
    render(<ProfilePage />);
    expect(screen.queryByText("Assistente TED")).not.toBeInTheDocument();
    expect(screen.queryByText("Segurança")).not.toBeInTheDocument();
  });

  it("links to workspace management", async () => {
    const user = userEvent.setup();
    render(<ProfilePage />);

    await user.click(screen.getByText("Meus Espaços"));
    expect(mockRouter.push).toHaveBeenCalledWith("/workspaces");
  });

  it("renders Sair da conta button", () => {
    render(<ProfilePage />);
    expect(screen.getByText("Sair da conta")).toBeInTheDocument();
  });

  it("opens the NotificationsSheet with the live title", async () => {
    const user = userEvent.setup();
    render(<ProfilePage />);
    await user.click(screen.getByRole("button", { name: /Notificações/ }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/Alertas do Meu Ted/i)).toBeInTheDocument();
  });

  it("edit profile: save call carries the new name + email + phone + avatar", async () => {
    const saveSpy = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(
      fakeState({ profile: SAMPLE_PROFILE, saveProfile: saveSpy }),
    );
    const user = userEvent.setup();
    render(<ProfilePage />);

    await user.click(screen.getByText("Editar perfil"));
    const nameInput = screen.getByDisplayValue("Marina");
    await user.clear(nameInput);
    await user.type(nameInput, "Marina Silva");
    const emailInput = screen.getByDisplayValue("marina@email.com");
    await user.clear(emailInput);
    await user.type(emailInput, "nova@email.com");
    const phoneInput = screen.getByDisplayValue("(11) 99999-9999");
    await user.clear(phoneInput);
    await user.type(phoneInput, "(11) 98888-7777");
    // Pick a different avatar color
    await user.click(screen.getByRole("button", { name: /Cor #EC7000/ }));
    await user.click(screen.getByText("Salvar alterações"));

    await waitFor(() => expect(saveSpy).toHaveBeenCalled());
    const arg = saveSpy.mock.calls[0]![0] as { name: string; email: string; phone: string; avatarColor: string };
    expect(arg.name).toBe("Marina Silva");
    expect(arg.email).toBe("nova@email.com");
    expect(arg.phone).toBe("(11) 98888-7777");
    expect(arg.avatarColor).toBe("#EC7000");
  });

  it("discard via close button does NOT call saveProfile", async () => {
    const saveSpy = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(
      fakeState({ profile: SAMPLE_PROFILE, saveProfile: saveSpy }),
    );
    const user = userEvent.setup();
    render(<ProfilePage />);

    await user.click(screen.getByText("Editar perfil"));
    const nameInput = screen.getByDisplayValue("Marina");
    await user.clear(nameInput);
    await user.type(nameInput, "Draft Name");
    // Close without saving
    await user.click(screen.getByLabelText("Voltar"));
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("name input rejects empty input (save button disabled)", async () => {
    const user = userEvent.setup();
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(
      fakeState({ profile: SAMPLE_PROFILE }),
    );
    render(<ProfilePage />);
    await user.click(screen.getByText("Editar perfil"));
    const nameInput = screen.getByDisplayValue("Marina");
    await user.clear(nameInput);
    // Save button should be disabled when name is empty.
    const saveBtn = screen.getByText("Salvar alterações");
    expect(saveBtn).toBeDisabled();
  });

  it("reopening edit sheet rehydrates fields from updated profile", async () => {
    const user = userEvent.setup();
    let profile: Profile = SAMPLE_PROFILE;
    const saveSpy = vi.fn(async (input: { name?: string; email?: string; phone?: string }) => {
      profile = { ...profile, name: input.name ?? profile.name, email: input.email ?? profile.email, phone: input.phone ?? profile.phone };
      return undefined;
    });
    vi.spyOn(appStateModule, "useAppState").mockImplementation(() =>
      fakeState({ profile, saveProfile: saveSpy }),
    );
    render(<ProfilePage />);

    // First session: open, save updated name
    await user.click(screen.getByText("Editar perfil"));
    const nameInput = screen.getByDisplayValue("Marina");
    await user.clear(nameInput);
    await user.type(nameInput, "Marina Atualizada");
    await user.click(screen.getByText("Salvar alterações"));
    await waitFor(() => expect(saveSpy).toHaveBeenCalled());
    // Parent-driven close plays the exit animation before unmounting.
    await waitForElementToBeRemoved(() => screen.queryByRole("dialog"));
    // Close + reopen
    await user.click(screen.getByText("Editar perfil"));
    expect(screen.getByDisplayValue("Marina Atualizada")).toBeInTheDocument();
    expect(screen.getByDisplayValue("marina@email.com")).toBeInTheDocument();
    expect(screen.getByDisplayValue("(11) 99999-9999")).toBeInTheDocument();
  });

  it("logout revokes the server session before local cleanup and navigation", async () => {
    const expireSpy = vi.fn();
    vi.spyOn(sessionContextModule, "useSession").mockReturnValue({
      expireSession: expireSpy,
      session: { status: "authenticated", user: { userId: "test-user" } },
    });
    signOutMock.signOut.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<ProfilePage />);
    await user.click(screen.getByText("Sair da conta"));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith("/"));
    expect(signOutMock.signOut).toHaveBeenCalledTimes(1);
    expect(expireSpy).toHaveBeenCalledTimes(1);
    expect(signOutMock.signOut.mock.invocationCallOrder[0]).toBeLessThan(
      expireSpy.mock.invocationCallOrder[0]!,
    );
    expect(expireSpy.mock.invocationCallOrder[0]).toBeLessThan(
      mockRouter.push.mock.invocationCallOrder[0]!,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("logout failure (5xx) preserves the local session and shows an error", async () => {
    const expireSpy = vi.fn();
    vi.spyOn(sessionContextModule, "useSession").mockReturnValue({
      expireSession: expireSpy,
      session: { status: "authenticated", user: { userId: "test-user" } },
    });
    signOutMock.signOut.mockRejectedValue(
      new ApiError(500, "error", "Erro interno do servidor."),
    );
    const user = userEvent.setup();
    render(<ProfilePage />);
    await user.click(screen.getByText("Sair da conta"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível sair. Verifique a conexão e tente novamente.");
    expect(expireSpy).not.toHaveBeenCalled();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it("logout failure (403) preserves the local session and shows an error", async () => {
    const expireSpy = vi.fn();
    vi.spyOn(sessionContextModule, "useSession").mockReturnValue({
      expireSession: expireSpy,
      session: { status: "authenticated", user: { userId: "test-user" } },
    });
    signOutMock.signOut.mockRejectedValue(
      new ApiError(403, "auth.invalid_origin", "Invalid origin"),
    );
    const user = userEvent.setup();
    render(<ProfilePage />);
    await user.click(screen.getByText("Sair da conta"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(expireSpy).not.toHaveBeenCalled();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it("logout with an already-ended server session (401) completes local cleanup", async () => {
    const expireSpy = vi.fn();
    vi.spyOn(sessionContextModule, "useSession").mockReturnValue({
      expireSession: expireSpy,
      session: { status: "authenticated", user: { userId: "test-user" } },
    });
    signOutMock.signOut.mockRejectedValue(
      new ApiError(401, "auth.error", "Token inválido"),
    );
    const user = userEvent.setup();
    render(<ProfilePage />);
    await user.click(screen.getByText("Sair da conta"));
    await waitFor(() => expect(expireSpy).toHaveBeenCalled());
    expect(mockRouter.push).toHaveBeenCalledWith("/");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
