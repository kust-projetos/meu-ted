import { render, screen, fireEvent, waitFor } from "@/lib/test-utils";
import { TransactionEditSheet } from "../components/TransactionEditSheet";
import * as appStateModule from "@/lib/state/app-state-context";
import { mockAccounts, mockCategories } from "@/lib/state/mock-data";
import type { AppState } from "@/lib/state/app-state-context";
import type { Transaction } from "@/lib/state/types";

const accounts = [...mockAccounts];
const categories = [...mockCategories];

const expenseTx: Transaction = {
  id: "tx1",
  kind: "expense",
  description: "Mercado",
  amountCents: 5000,
  date: "2026-06-01",
  categoryId: "cat1",
  accountId: "acc1",
};

const transferTx: Transaction = {
  id: "tx2",
  kind: "transfer",
  description: "PIX",
  amountCents: 10000,
  date: "2026-06-02",
  categoryId: "cat1",
  accountId: "acc1",
};

function mockState(overrides: Partial<AppState> = {}): AppState {
  return {
    updateTransaction: vi.fn(),
    categories,
    accounts,
    ...overrides,
  } as unknown as AppState;
}

describe("TransactionEditSheet", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders an expense transaction and saves with parsed input", () => {
    const updateSpy = vi.fn();
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ updateTransaction: updateSpy }));
    render(<TransactionEditSheet open onClose={vi.fn()} transaction={expenseTx} />);
    expect(screen.getByText("Editar lançamento")).toBeInTheDocument();
    expect((screen.getByDisplayValue("Mercado") as HTMLInputElement).value).toBe("Mercado");
    fireEvent.click(screen.getByText("Salvar"));
    expect(updateSpy).toHaveBeenCalledWith(
      "tx1",
      expect.objectContaining({ description: "Mercado", amountCents: 5000, accountId: "acc1", categoryId: "cat1" }),
    );
  });

  it("does not save when description is empty", () => {
    const updateSpy = vi.fn();
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ updateTransaction: updateSpy }));
    render(<TransactionEditSheet open onClose={vi.fn()} transaction={expenseTx} />);
    fireEvent.change(screen.getByDisplayValue("Mercado"), { target: { value: "" } });
    fireEvent.click(screen.getByText("Salvar"));
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("keeps edited data when close is attempted and closes only after discard confirmation", () => {
    const updateSpy = vi.fn();
    const onClose = vi.fn();
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ updateTransaction: updateSpy }));
    render(<TransactionEditSheet open onClose={onClose} transaction={expenseTx} />);
    const description = screen.getByDisplayValue("Mercado");
    fireEvent.change(description, { target: { value: "Mercado editado" } });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByDisplayValue("Mercado editado")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Descartar alterações?" })).toBeInTheDocument();
    expect(updateSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continuar editando" }));
    expect(screen.getByDisplayValue("Mercado editado")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    fireEvent.click(screen.getByRole("button", { name: "Descartar" }));
    expect(onClose).toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("does not save when date is empty", () => {
    const updateSpy = vi.fn();
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ updateTransaction: updateSpy }));
    render(<TransactionEditSheet open onClose={vi.fn()} transaction={expenseTx} />);
    fireEvent.change(screen.getByDisplayValue("2026-06-01"), { target: { value: "" } });
    fireEvent.click(screen.getByText("Salvar"));
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("saves without amountCents when amount is cleared (parsed=0 branch)", () => {
    const updateSpy = vi.fn();
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ updateTransaction: updateSpy }));
    render(<TransactionEditSheet open onClose={vi.fn()} transaction={expenseTx} />);
    fireEvent.change(screen.getByPlaceholderText("0,00"), { target: { value: "" } });
    fireEvent.click(screen.getByText("Salvar"));
    const input = updateSpy.mock.calls[0]![1];
    expect(input).not.toHaveProperty("amountCents");
  });

  it("saves without categoryId/accountId when not present", () => {
    const updateSpy = vi.fn();
    const bare: Transaction = { id: "tx3", kind: "expense", description: "Outra", amountCents: 100, date: "2026-06-03", categoryId: "", accountId: "" };
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ updateTransaction: updateSpy }));
    render(<TransactionEditSheet open onClose={vi.fn()} transaction={bare} />);
    fireEvent.click(screen.getByText("Salvar"));
    const input = updateSpy.mock.calls[0]![1];
    expect(input).not.toHaveProperty("categoryId");
    expect(input).not.toHaveProperty("accountId");
  });

  it("does not render amount/category/account for transfer transactions", () => {
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState());
    render(<TransactionEditSheet open onClose={vi.fn()} transaction={transferTx} />);
    expect(screen.queryByText("Valor (R$)")).not.toBeInTheDocument();
    expect(screen.queryByText("Categoria")).not.toBeInTheDocument();
    expect(screen.queryByText("Conta")).not.toBeInTheDocument();
  });

  it("calls onClose when the Fechar button is clicked", async () => {
    const onClose = vi.fn();
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState());
    render(<TransactionEditSheet open onClose={onClose} transaction={expenseTx} />);
    fireEvent.click(screen.getByLabelText("Fechar"));
    // Exit animation plays first, then onClose fires.
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("renders nothing when transaction is null", () => {
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState());
    const { container } = render(<TransactionEditSheet open onClose={vi.fn()} transaction={null} />);
    expect(container).toBeEmpty();
  });

  it("updates amount, category and account before saving", () => {
    const updateSpy = vi.fn();
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ updateTransaction: updateSpy }));
    render(<TransactionEditSheet open onClose={vi.fn()} transaction={expenseTx} />);
    fireEvent.change(screen.getByPlaceholderText("0,00"), { target: { value: "9900" } });
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    fireEvent.change(selects[0]!, { target: { value: "cat2" } });
    fireEvent.change(selects[1]!, { target: { value: "acc2" } });
    fireEvent.click(screen.getByText("Salvar"));
    expect(updateSpy).toHaveBeenCalledWith(
      "tx1",
      expect.objectContaining({ amountCents: 9900, categoryId: "cat2", accountId: "acc2" }),
    );
  });

  it("prefills and saves notes (item 10/B4)", () => {
    const updateSpy = vi.fn();
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ updateTransaction: updateSpy }));
    const withNotes: Transaction = { ...expenseTx, notes: "Antiga" };
    render(<TransactionEditSheet open onClose={vi.fn()} transaction={withNotes} />);
    expect(screen.getByLabelText("Observações")).toHaveValue("Antiga");
    fireEvent.change(screen.getByLabelText("Observações"), { target: { value: "Nova observação" } });
    fireEvent.click(screen.getByText("Salvar"));
    expect(updateSpy).toHaveBeenCalledWith(
      "tx1",
      expect.objectContaining({ notes: "Nova observação" }),
    );
  });

  it("does not render notes for transfer transactions", () => {
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState());
    render(<TransactionEditSheet open onClose={vi.fn()} transaction={transferTx} />);
    expect(screen.queryByLabelText("Observações")).not.toBeInTheDocument();
  });
});

describe("TransactionEditSheet — P2-7 (labels acessíveis)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("associates all form labels with their inputs", () => {
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({}));
    render(<TransactionEditSheet open onClose={vi.fn()} transaction={expenseTx} />);
    expect(screen.getByLabelText("Descrição")).toBeInTheDocument();
    expect(screen.getByLabelText("Data")).toBeInTheDocument();
    expect(screen.getByLabelText("Valor (R$)")).toBeInTheDocument();
    expect(screen.getByLabelText("Categoria")).toBeInTheDocument();
    expect(screen.getByLabelText("Conta")).toBeInTheDocument();
  });
});
