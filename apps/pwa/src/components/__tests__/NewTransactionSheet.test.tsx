import { render, screen, fireEvent, within, waitFor } from "@/lib/test-utils";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import NewTransactionSheet from "../NewTransactionSheet";
import type { Account, Category } from "@/lib/state/types";

const accounts: Account[] = [
  { id: "acc1", name: "Nubank", balanceCents: 100000, kind: "checking", color: "#820AD1" },
  { id: "acc2", name: "Itaú", balanceCents: 50000, kind: "checking", color: "#EC7000" },
];

const categories: Category[] = [
  { id: "cat1", name: "Alimentação", kind: "expense", icon: "UtensilsCrossed" },
  { id: "cat2", name: "Transporte", kind: "expense", icon: "Car" },
  { id: "cat3", name: "Salário", kind: "income", icon: "DollarSign" },
];

// Categories with subcategories (parentId)
const categoriesWithSubs: Category[] = [
  ...categories,
  { id: "sub1", name: "Mercado", kind: "expense", icon: "ShoppingBag", parentId: "cat1" },
  { id: "sub2", name: "Restaurante", kind: "expense", icon: "UtensilsCrossed", parentId: "cat1" },
];

// With credit card
const accountsWithCard: Account[] = [
  ...accounts,
  { id: "card1", name: "Nubank Card", balanceCents: 0, kind: "credit_card", color: "#820AD1", creditLimitCents: 500000, closingDay: 15, dueDay: 25 },
];

async function selectOrigin(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: "Selecionar conta ou cartão" }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: new RegExp(name) }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
}

async function selectCategory(user: ReturnType<typeof userEvent.setup>, name: string | RegExp) {
  await user.click(screen.getByRole("button", { name: "Selecionar categoria" }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
}

describe("NewTransactionSheet", () => {
  it("restores an expense draft after switching tabs while keeping other tabs pristine", async () => {
    const user = userEvent.setup();
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={vi.fn()} />);
    const amount = screen.getByLabelText("Valor");
    const description = screen.getByLabelText("Descrição");
    await user.type(amount, "12345");
    await user.type(description, "Aluguel");
    await user.click(screen.getByText("Receita"));
    expect(screen.getByLabelText("Valor")).toHaveValue("");
    expect(screen.getByLabelText("Descrição")).toHaveValue("");
    await user.click(screen.getByText("Despesa"));
    expect(screen.getByLabelText("Valor")).toHaveValue("123,45");
    expect(screen.getByLabelText("Descrição")).toHaveValue("Aluguel");
  });

  it("uses a fresh idempotency key after switching tabs", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={onSave} />);
    await user.type(screen.getByLabelText("Valor"), "1000");
    await selectOrigin(user, "Nubank");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const firstKey = onSave.mock.calls[0][0].idempotencyKey;
    await user.click(screen.getByText("Receita"));
    await user.type(screen.getByLabelText("Valor"), "2000");
    await selectOrigin(user, "Itaú");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    const secondKey = onSave.mock.calls[1][0].idempotencyKey;
    expect(secondKey).toEqual(expect.any(String));
    expect(secondKey).not.toBe(firstKey);
  });

  it("does not carry expense category or account selections into transfer", async () => {
    const user = userEvent.setup();
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={vi.fn()} />);
    await selectCategory(user, "Alimentação");
    await selectOrigin(user, "Nubank");
    await user.click(screen.getByText("Transferência"));
    expect(screen.queryByRole("button", { name: "Selecionar categoria" })).not.toBeInTheDocument();
    const transferAccount = screen.getAllByRole("button", { name: /^NUNubank$/ })[0];
    expect(transferAccount).toBeDefined();
    expect(transferAccount.className).not.toContain("bg-primary");
    expect(screen.getByText("Origem (saída)")).toBeInTheDocument();
  });

  it("clears every saved tab draft after a successful save", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={onSave} />);
    await user.type(screen.getByLabelText("Valor"), "12345");
    await user.type(screen.getByLabelText("Descrição"), "Despesa");
    await user.click(screen.getByText("Receita"));
    await user.type(screen.getByLabelText("Valor"), "6789");
    await user.type(screen.getByLabelText("Descrição"), "Receita");
    await selectOrigin(user, "Itaú");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await user.click(screen.getByText("Despesa"));
    expect(screen.getByLabelText("Valor")).toHaveValue("");
    expect(screen.getByLabelText("Descrição")).toHaveValue("");
  });

  it("clears drafts when the form closes after confirmed discard and is reopened", async () => {
    const user = userEvent.setup();
    function DiscardHarness() {
      const [open, setOpen] = useState(true);
      return open ? (
        <>
          <NewTransactionSheet accounts={accounts} categories={categories} onSave={vi.fn()} />
          <button onClick={() => setOpen(false)}>Confirmar descarte</button>
        </>
      ) : <button onClick={() => setOpen(true)}>Reabrir</button>;
    }
    render(<DiscardHarness />);
    await user.type(screen.getByLabelText("Valor"), "12345");
    await user.click(screen.getByText("Receita"));
    await user.click(screen.getByText("Despesa"));
    expect(screen.getByLabelText("Valor")).toHaveValue("123,45");
    await user.click(screen.getByText("Confirmar descarte"));
    await user.click(screen.getByText("Reabrir"));
    expect(screen.getByLabelText("Valor")).toHaveValue("");
  });

  it("renders all 3 tab buttons", () => {
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={vi.fn()} />);
    expect(screen.getByText("Despesa")).toBeInTheDocument();
    expect(screen.getByText("Receita")).toBeInTheDocument();
    expect(screen.getByText("Transferência")).toBeInTheDocument();
  });

  it("renders the origin segmented toggle with Cartão and Conta (B2)", () => {
    render(<NewTransactionSheet accounts={accountsWithCard} categories={categories} onSave={vi.fn()} />);
    const group = screen.getByRole("group", { name: "Origem" });
    expect(within(group).getByRole("button", { name: "Cartão" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Conta" })).toBeInTheDocument();
  });

  it("does not show installments until a card origin is picked (B3)", async () => {
    const user = userEvent.setup();
    render(<NewTransactionSheet accounts={accountsWithCard} categories={categories} onSave={vi.fn()} />);
    expect(screen.queryByText("Parcelas")).not.toBeInTheDocument();
    // Pick a bank account origin: still no installments.
    await selectOrigin(user, "Itaú");
    expect(screen.queryByText("Parcelas")).not.toBeInTheDocument();
    // Switch to card origin and pick the card: installments appear.
    await user.click(screen.getByRole("button", { name: "Cartão" }));
    await selectOrigin(user, "Nubank Card");
    expect(screen.getByText("Parcelas")).toBeInTheDocument();
  });

  it("shows expense fields by default", () => {
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={vi.fn()} />);
    expect(screen.getByText("Valor")).toBeInTheDocument();
    expect(screen.getByText("Descrição")).toBeInTheDocument();
  });

  it("switches to transfer tab and shows from/to fields", async () => {
    const user = userEvent.setup();
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={vi.fn()} />);
    await user.click(screen.getByText("Transferência"));
    expect(screen.getByText("Origem (saída)")).toBeInTheDocument();
    expect(screen.getByText("Destino (entrada)")).toBeInTheDocument();
  });

  it("calls onSave with correct data when saving an expense", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={onSave} />);
    const valorInput = screen.getByPlaceholderText(/0,00/);
    await user.type(valorInput, "10000");
    const descInput = screen.getByPlaceholderText(/aluguel|descrição/i);
    await user.type(descInput, "Supermercado");
    await selectOrigin(user, "Nubank");
    await user.click(screen.getByRole("button", { name: /^Salvar$/ }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0];
    expect(saved.kind).toBe("expense");
    expect(saved.amountCents).toBeGreaterThan(0);
    expect(saved.description).toContain("Supermercado");
    expect(saved.accountId).toBe("acc1");
  });

  it("blocks save until an origin is picked (B2, neither)", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={onSave} />);
    await user.type(screen.getByPlaceholderText(/0,00/), "10000");
    expect(screen.getByText("Escolha a origem para salvar.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Salvar$/ }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps a single origin: picking a card clears the account pick (B2, exclusivity)", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NewTransactionSheet accounts={accountsWithCard} categories={categories} onSave={onSave} />);
    await selectOrigin(user, "Itaú");
    expect(screen.getByRole("button", { name: "Selecionar conta ou cartão" })).toHaveTextContent("Itaú");
    // Switch origin kind: previous pick is cleared (mutually exclusive).
    await user.click(screen.getByRole("button", { name: "Cartão" }));
    expect(screen.getByRole("button", { name: "Selecionar conta ou cartão" })).toHaveTextContent("Selecionar");
    await selectOrigin(user, "Nubank Card");
    await user.type(screen.getByPlaceholderText(/0,00/), "10000");
    await user.click(screen.getByRole("button", { name: /^Salvar$/ }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].accountId).toBe("card1");
  });

  it("calls onSave with transfer data when saving a transfer", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={onSave} />);
    await user.click(screen.getByText("Transferência"));
    const valorInput = screen.getByPlaceholderText(/0,00/);
    await user.type(valorInput, "5000");
    const [originBtn] = screen.getAllByText("Nubank");
    await user.click(originBtn);
    const [, destinationBtn] = screen.getAllByText("Itaú");
    await user.click(destinationBtn);
    await user.click(screen.getByText("Transferir"));
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0];
    expect(saved.kind).toBe("transfer");
    expect(saved.amountCents).toBe(5000);
  });

  // ── Category picker sheet (B1) ──

  it("opens the category sheet with search, top-used and create actions", async () => {
    const user = userEvent.setup();
    render(
      <NewTransactionSheet
        accounts={accounts}
        categories={categories}
        onSave={vi.fn()}
        onAddCategory={vi.fn()}
        recentCategoryIds={["cat2"]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Selecionar categoria" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByPlaceholderText("Buscar categoria")).toBeInTheDocument();
    expect(within(dialog).getByText("Mais usadas")).toBeInTheDocument();
    expect(within(dialog).getByText("Todas")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cadastrar nova" })).toBeInTheDocument();
  });

  it("filters categories instantly while searching", async () => {
    const user = userEvent.setup();
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Selecionar categoria" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText("Buscar categoria"), "transp");
    expect(within(dialog).getByText("Transporte")).toBeInTheDocument();
    expect(within(dialog).queryByText("Alimentação")).not.toBeInTheDocument();
  });

  it("selects a category from the sheet and shows it in the pill", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={onSave} />);
    await selectCategory(user, "Alimentação");
    expect(screen.getByRole("button", { name: "Selecionar categoria" })).toHaveTextContent("Alimentação");
    await user.type(screen.getByPlaceholderText(/0,00/), "10000");
    await selectOrigin(user, "Itaú");
    await user.click(screen.getByRole("button", { name: /^Salvar$/ }));
    expect(onSave.mock.calls[0][0].categoryId).toBe("cat1");
  });

  it("selects a subcategory from the expanded parent (pill shows parent › sub)", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <NewTransactionSheet
        accounts={accounts}
        categories={categoriesWithSubs}
        onSave={onSave}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Selecionar categoria" }));
    const dialog = await screen.findByRole("dialog");
    // Expand the parent, then pick the sub.
    await user.click(within(dialog).getByRole("button", { name: "Alimentação" }));
    await user.click(within(dialog).getByRole("button", { name: "Mercado" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Selecionar categoria" })).toHaveTextContent("Alimentação › Mercado");
    await user.type(screen.getByPlaceholderText(/0,00/), "7500");
    await user.type(screen.getByPlaceholderText(/aluguel|descrição/i), "Compras da semana");
    await selectOrigin(user, "Itaú");
    await user.click(screen.getByRole("button", { name: /^Salvar$/ }));
    const saved = onSave.mock.calls[0][0];
    expect(saved.categoryId).toBe("sub1");
    expect(saved.subcategoryId).toBe("sub1");
  });

  it("creates a subcategory under the selected parent via Cadastrar nova", async () => {
    const user = userEvent.setup();
    const onAddCat = vi.fn();
    render(
      <NewTransactionSheet
        accounts={accounts}
        categories={categoriesWithSubs}
        onSave={vi.fn()}
        onAddCategory={onAddCat}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Selecionar categoria" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Alimentação" }));
    await user.click(within(dialog).getByRole("button", { name: /Nova subcategoria em Alimentação/ }));
    await user.type(within(dialog).getByPlaceholderText("Nome da subcategoria"), "Hortifrúti");
    await user.click(within(dialog).getByRole("button", { name: "Salvar subcategoria" }));
    expect(onAddCat).toHaveBeenCalledWith({ name: "Hortifrúti", kind: "expense", parentId: "cat1" });
  });

  it("creates a top-level category via Cadastrar nova", async () => {
    const user = userEvent.setup();
    const onAddCat = vi.fn();
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={vi.fn()} onAddCategory={onAddCat} />);
    await user.click(screen.getByRole("button", { name: "Selecionar categoria" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cadastrar nova" }));
    await user.type(within(dialog).getByPlaceholderText("Nome da categoria"), "Mercado");
    await user.click(within(dialog).getByRole("button", { name: "Salvar categoria" }));
    expect(onAddCat).toHaveBeenCalledWith({ name: "Mercado", kind: "expense" });
  });

  // ── Origin sheet (B2) ──

  it("shows balance/limit details in the origin sheet", async () => {
    const user = userEvent.setup();
    render(<NewTransactionSheet accounts={accountsWithCard} categories={categories} onSave={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Cartão" }));
    await user.click(screen.getByRole("button", { name: "Selecionar conta ou cartão" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Fecha dia 15")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /Nubank Card/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Selecionar conta ou cartão" })).toHaveTextContent("Fecha dia 15");
  });

  it("shows account balance in the origin sheet", async () => {
    const user = userEvent.setup();
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Selecionar conta ou cartão" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByText(/Saldo R\$/).length).toBeGreaterThanOrEqual(1);
  });

  it("creates an account inline from the origin sheet", async () => {
    const user = userEvent.setup();
    const onAddAcc = vi.fn();
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={vi.fn()} onAddAccount={onAddAcc} />);
    await user.click(screen.getByRole("button", { name: "Selecionar conta ou cartão" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Nova conta" }));
    await user.type(within(dialog).getByPlaceholderText("Nome da conta"), "Caixa");
    await user.click(within(dialog).getByRole("button", { name: "Salvar conta" }));
    expect(onAddAcc).toHaveBeenCalledWith({ name: "Caixa", kind: "bank", initialBalanceCents: 0 });
  });

  it("creates an account inline with a negative initial balance (ADR-018)", async () => {
    const user = userEvent.setup();
    const onAddAcc = vi.fn();
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={vi.fn()} onAddAccount={onAddAcc} />);
    await user.click(screen.getByRole("button", { name: "Selecionar conta ou cartão" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Nova conta" }));
    await user.type(within(dialog).getByPlaceholderText("Nome da conta"), "Caixa Negativa");
    await user.type(within(dialog).getByPlaceholderText("Saldo inicial (R$)"), "-250,00");
    await user.click(within(dialog).getByRole("button", { name: "Salvar conta" }));
    expect(onAddAcc).toHaveBeenCalledWith({ name: "Caixa Negativa", kind: "bank", initialBalanceCents: -25000 });
  });

  it("creates a card inline from the origin sheet", async () => {
    const user = userEvent.setup();
    const onAddCrd = vi.fn();
    render(
      <NewTransactionSheet
        accounts={accountsWithCard}
        categories={categories}
        onSave={vi.fn()}
        onAddCard={onAddCrd}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Cartão" }));
    await user.click(screen.getByRole("button", { name: "Selecionar conta ou cartão" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Novo cartão" }));
    await user.type(within(dialog).getByPlaceholderText("Nome do cartão"), "Inter Card");
    await user.click(within(dialog).getByRole("button", { name: "Salvar cartão" }));
    expect(onAddCrd).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Inter Card", creditLimitCents: 0 }),
    );
  });

  // ── Installments (B3) ──

  it("includes installmentsTotal when a card parcel count is picked", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NewTransactionSheet accounts={accountsWithCard} categories={categories} onSave={onSave} />);
    await user.type(screen.getByPlaceholderText(/0,00/), "600000");
    await user.click(screen.getByRole("button", { name: "Cartão" }));
    await selectOrigin(user, "Nubank Card");
    await user.click(screen.getByRole("button", { name: "12x" }));
    await user.click(screen.getByText("Salvar em 12x"));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].installmentsTotal).toBe(12);
  });

  it("shows the per-installment invoice microcopy (B3)", async () => {
    const user = userEvent.setup();
    render(<NewTransactionSheet accounts={accountsWithCard} categories={categories} onSave={vi.fn()} />);
    await user.type(screen.getByPlaceholderText(/0,00/), "600000");
    await user.click(screen.getByRole("button", { name: "Cartão" }));
    await selectOrigin(user, "Nubank Card");
    await user.click(screen.getByRole("button", { name: "6x" }));
    expect(screen.getByText(/6x de R\$.*na fatura de/)).toBeInTheDocument();
  });

  it("treats 1x as à vista (no installmentsTotal)", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NewTransactionSheet accounts={accountsWithCard} categories={categories} onSave={onSave} />);
    await user.type(screen.getByPlaceholderText(/0,00/), "10000");
    await user.click(screen.getByRole("button", { name: "Cartão" }));
    await selectOrigin(user, "Nubank Card");
    await user.click(screen.getByRole("button", { name: /^Salvar$/ }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].installmentsTotal).toBeUndefined();
  });

  it("accepts a custom installment count via Outro input", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NewTransactionSheet accounts={accountsWithCard} categories={categories} onSave={onSave} />);
    await user.type(screen.getByPlaceholderText(/0,00/), "600000");
    await user.click(screen.getByRole("button", { name: "Cartão" }));
    await selectOrigin(user, "Nubank Card");
    await user.type(screen.getByLabelText("Outro número de parcelas"), "5");
    await user.click(screen.getByText(/Salvar em 5x/));
    expect(onSave.mock.calls[0][0].installmentsTotal).toBe(5);
  });

  // ── Origin kind preservation (H-01) ──

  it("tags saved data with originKind card when a card is picked", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NewTransactionSheet accounts={accountsWithCard} categories={categories} onSave={onSave} />);
    await user.type(screen.getByPlaceholderText(/0,00/), "10000");
    await user.click(screen.getByRole("button", { name: "Cartão" }));
    await selectOrigin(user, "Nubank Card");
    await user.click(screen.getByRole("button", { name: /^Salvar$/ }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ accountId: "card1", originKind: "card" });
  });

  it("tags saved data with originKind account when a bank account is picked", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NewTransactionSheet accounts={accountsWithCard} categories={categories} onSave={onSave} />);
    await user.type(screen.getByPlaceholderText(/0,00/), "10000");
    await selectOrigin(user, "Itaú");
    await user.click(screen.getByRole("button", { name: /^Salvar$/ }));
    expect(onSave.mock.calls[0][0]).toMatchObject({ accountId: "acc2", originKind: "account" });
  });

  it("disables the Cartão toggle on the income tab (H-01)", async () => {
    render(<NewTransactionSheet accounts={accountsWithCard} categories={categories} onSave={vi.fn()} initialTab="income" />);
    const cardToggle = screen.getByRole("button", { name: "Cartão" });
    expect(cardToggle).toBeDisabled();
    expect(cardToggle).toHaveAttribute("title", "Receitas usam conta");
  });

  it("shows the last-parcel remainder in the preview for uneven splits (L-01)", async () => {
    const user = userEvent.setup();
    render(<NewTransactionSheet accounts={accountsWithCard} categories={categories} onSave={vi.fn()} />);
    await user.type(screen.getByPlaceholderText(/0,00/), "100000");
    await user.click(screen.getByRole("button", { name: "Cartão" }));
    await selectOrigin(user, "Nubank Card");
    await user.click(screen.getByRole("button", { name: "3x" }));
    // 100000/3 → 33333 + 33333 + 33334: last parcel absorbs the remainder.
    expect(screen.getByText(/3x de R\$ 333,33 na fatura de/)).toBeInTheDocument();
    expect(screen.getByText(/última de R\$ 333,34/)).toBeInTheDocument();
  });

  // ── Mais detalhes (B4) ──

  it("saves notes from Mais detalhes", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={onSave} />);
    await user.type(screen.getByPlaceholderText(/0,00/), "10000");
    await selectOrigin(user, "Itaú");
    await user.click(screen.getByRole("button", { name: "Mais detalhes" }));
    await user.type(screen.getByLabelText("Observações"), "Reembolsável");
    await user.click(screen.getByRole("button", { name: /^Salvar$/ }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].notes).toBe("Reembolsável");
  });

  it("omits notes when Mais detalhes is left empty", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={onSave} />);
    await user.type(screen.getByPlaceholderText(/0,00/), "10000");
    await selectOrigin(user, "Itaú");
    await user.click(screen.getByRole("button", { name: /^Salvar$/ }));
    expect(onSave.mock.calls[0][0].notes).toBeUndefined();
  });

  // ── Draft leakage across tab switches ──

  it("does not leak amount or description across tab switches", async () => {
    const user = userEvent.setup();
    render(
      <NewTransactionSheet accounts={accounts} categories={categories} onSave={vi.fn()} />,
    );

    // Type draft on the default (Despesa) tab.
    const valorInput = screen.getByPlaceholderText(/0,00/);
    await user.type(valorInput, "12345");
    const descInput = screen.getByPlaceholderText(/aluguel|descrição/i);
    await user.type(descInput, "Draft de Despesa");

    // Switch to Transferência — should reset ALL draft fields including
    // amount and description, not just category/account.
    await user.click(screen.getByRole("button", { name: /transferência/i }));

    const reopenedValor = screen.getByPlaceholderText(/0,00/) as HTMLInputElement;
    const reopenedDesc = screen.getByPlaceholderText(/aluguel|descrição/i) as HTMLInputElement;
    expect(reopenedValor.value).toBe("");
    expect(reopenedDesc.value).toBe("");
  });

  it("does not leak amount or description when switching from Receita to Despesa", async () => {
    const user = userEvent.setup();
    render(
      <NewTransactionSheet
        accounts={accounts}
        categories={categories}
        onSave={vi.fn()}
        initialTab="income"
      />,
    );

    // Type draft on Receita tab.
    const valorInput = screen.getByPlaceholderText(/0,00/);
    await user.type(valorInput, "99999");
    const descInput = screen.getByPlaceholderText(/aluguel|descrição/i);
    await user.type(descInput, "Salário freelance");

    // Switch to Despesa — should reset amount and description.
    const despesaBtn = screen.getAllByRole("button", { name: /^Despesa$/i })[0]!;
    await user.click(despesaBtn);

    const reopenedValor = screen.getByPlaceholderText(/0,00/) as HTMLInputElement;
    const reopenedDesc = screen.getByPlaceholderText(/aluguel|descrição/i) as HTMLInputElement;
    expect(reopenedValor.value).toBe("");
    expect(reopenedDesc.value).toBe("");
  });

  describe("coverage: calendar, income, card, guards", () => {
    it("opens the calendar and selects a day", async () => {
      const user = userEvent.setup();
      render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={vi.fn()} />);
      await user.click(screen.getByRole("button", { name: /de \d{4}/ }));
      const dayButtons = screen.getAllByRole("button").filter((b) => /^\d+$/.test((b.textContent ?? "").trim()));
      expect(dayButtons.length).toBeGreaterThan(0);
      await user.click(dayButtons[0]!);
      expect(screen.queryByText("Seg")).not.toBeInTheDocument();
    });

    it("navigates calendar months with prev/next", async () => {
      const user = userEvent.setup();
      render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={vi.fn()} />);
      await user.click(screen.getByRole("button", { name: /de \d{4}/ }));
      await user.click(screen.getByText("‹"));
      await user.click(screen.getByText("›"));
      expect(screen.getByText("Seg")).toBeInTheDocument();
    });

    it("saves an income transaction", async () => {
      const user = userEvent.setup();
      const onSave = vi.fn();
      render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={onSave} initialTab="income" />);
      await user.type(screen.getByPlaceholderText(/0,00/), "50000");
      await user.type(screen.getByPlaceholderText(/aluguel|descrição/i), "Salário");
      await selectOrigin(user, "Nubank");
      await user.click(screen.getByRole("button", { name: /^Salvar$/ }));
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ kind: "income", amountCents: 50000, accountId: "acc1" }));
    });

    it("saves expense with credit card selected", async () => {
      const user = userEvent.setup();
      const onSave = vi.fn();
      render(<NewTransactionSheet accounts={accountsWithCard} categories={categories} onSave={onSave} />);
      await user.type(screen.getByPlaceholderText(/0,00/), "10000");
      await user.click(screen.getByRole("button", { name: "Cartão" }));
      await selectOrigin(user, "Nubank Card");
      await user.click(screen.getByRole("button", { name: /^Salvar$/ }));
      expect(onSave.mock.calls[0]![0].accountId).toBe("card1");
    });

    it("includes selected categoryId on save (expense)", async () => {
      const user = userEvent.setup();
      const onSave = vi.fn();
      render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={onSave} />);
      await selectCategory(user, "Alimentação");
      await user.type(screen.getByPlaceholderText(/0,00/), "10000");
      await selectOrigin(user, "Itaú");
      await user.click(screen.getByRole("button", { name: /^Salvar$/ }));
      const saved = onSave.mock.calls[0]![0];
      expect(saved.categoryId).toBe("cat1");
      expect(saved.kind).toBe("expense");
    });

    it("shows inline account form in transfer tab via Nova", async () => {
      const user = userEvent.setup();
      render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={vi.fn()} onAddAccount={vi.fn()} />);
      await user.click(screen.getByText("Transferência"));
      await user.click(screen.getByText("Nova"));
      expect(screen.getByPlaceholderText("Nome da conta")).toBeInTheDocument();
    });

    it("ignores amount digits beyond 12", async () => {
      const user = userEvent.setup();
      render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={vi.fn()} />);
      const valor = screen.getByPlaceholderText(/0,00/) as HTMLInputElement;
      await user.type(valor, "123456789012345");
      expect(valor.value.replace(/\D/g, "").length).toBeLessThanOrEqual(12);
    });

    it("handles onSave rejection without crashing", async () => {
      const user = userEvent.setup();
      const onSave = vi.fn().mockRejectedValue(new Error("fail"));
      render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={onSave} />);
      await user.type(screen.getByPlaceholderText(/0,00/), "10000");
      await user.type(screen.getByPlaceholderText(/aluguel|descrição/i), "X");
      await selectOrigin(user, "Itaú");
      await user.click(screen.getByRole("button", { name: /^Salvar$/ }));
      expect(onSave).toHaveBeenCalled();
    });

    it("card inline form: typing limit/closing/due and saving", async () => {
      const user = userEvent.setup();
      const onAddCrd = vi.fn();
      render(<NewTransactionSheet accounts={accountsWithCard} categories={categories} onSave={vi.fn()} onAddCard={onAddCrd} />);
      await user.click(screen.getByRole("button", { name: "Cartão" }));
      await user.click(screen.getByRole("button", { name: "Selecionar conta ou cartão" }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Novo cartão" }));
      await user.type(within(dialog).getByPlaceholderText("Nome do cartão"), "Inter Card");
      fireEvent.change(within(dialog).getByPlaceholderText("Limite (R$)"), { target: { value: "100000" } });
      fireEvent.change(within(dialog).getByPlaceholderText("Fechamento"), { target: { value: "10" } });
      fireEvent.change(within(dialog).getByPlaceholderText("Vencimento"), { target: { value: "20" } });
      await user.click(within(dialog).getByRole("button", { name: "Salvar cartão" }));
      expect(onAddCrd).toHaveBeenCalledWith(expect.objectContaining({ name: "Inter Card", creditLimitCents: 100000, closingDay: 10, dueDay: 20 }));
    });

    it("subcategory draft prefill: initializes with selected subcategory", async () => {
      const user = userEvent.setup();
      const onSave = vi.fn();
      render(
        <NewTransactionSheet
          accounts={accounts}
          categories={categoriesWithSubs}
          onSave={onSave}
          initialSubcategoryId="sub2"
          initialDescription="Jantar"
        />,
      );

      expect(screen.getByRole("button", { name: "Selecionar categoria" })).toHaveTextContent("Alimentação › Restaurante");
      const valorInput = screen.getByPlaceholderText(/0,00/);
      await user.type(valorInput, "12000");
      await selectOrigin(user, "Itaú");
      await user.click(screen.getByRole("button", { name: /^Salvar$/ }));

      expect(onSave).toHaveBeenCalledTimes(1);
      const saved = onSave.mock.calls[0]![0];
      expect(saved.categoryId).toBe("sub2");
      expect(saved.subcategoryId).toBe("sub2");
      expect(saved.description).toBe("Jantar");
    });
  });
});

describe("NewTransactionSheet — P2-7 (labels acessíveis)", () => {
  it("associates the Valor and Descrição labels with their inputs", () => {
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={vi.fn()} />);
    expect(screen.getByLabelText("Valor")).toBeInTheDocument();
    expect(screen.getByLabelText("Descrição")).toBeInTheDocument();
  });

  it("exposes the date toggle with an accessible name and expanded state", async () => {
    const user = userEvent.setup();
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={vi.fn()} />);
    const toggle = screen.getByRole("button", { name: /Selecionar data/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("labels the custom installments input (card origin)", async () => {
    const user = userEvent.setup();
    render(<NewTransactionSheet accounts={accountsWithCard} categories={categories} onSave={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Cartão" }));
    await selectOrigin(user, "Nubank Card");
    expect(screen.getByLabelText("Outro número de parcelas")).toBeInTheDocument();
  });

  it("exposes pickers and details with accessible names", async () => {
    const user = userEvent.setup();
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Selecionar categoria" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Selecionar conta ou cartão" })).toBeInTheDocument();
    const details = screen.getByRole("button", { name: "Mais detalhes" });
    expect(details).toHaveAttribute("aria-expanded", "false");
    await user.click(details);
    expect(details).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Observações")).toBeInTheDocument();
  });
});
