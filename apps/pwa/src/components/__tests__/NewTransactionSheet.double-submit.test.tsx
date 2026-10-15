import { render, screen, fireEvent, waitFor, within } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import NewTransactionSheet, { type SaveData } from "../NewTransactionSheet";
import { attachCommandId } from "@/lib/api/command-id";
import type { Account, Category } from "@/lib/state/types";

const accounts: Account[] = [
  { id: "acc1", name: "Nubank", balanceCents: 100000, kind: "checking", color: "#820AD1" },
];

const categories: Category[] = [
  { id: "cat1", name: "Alimentação", kind: "expense", icon: "UtensilsCrossed" },
];

async function fillValidExpense(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText(/0,00/), "5000");
  await user.type(screen.getByPlaceholderText(/aluguel|descrição/i), "Mercado");
  await user.click(screen.getByRole("button", { name: "Selecionar conta ou cartão" }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: /Nubank/ }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
}

function saveButton() {
  // Durante o duplicate-check o rótulo vira "Verificando..."; durante o save,
  // "Salvando...". O get re-queried a cada chamada para sobreviver ao re-render.
  return screen.getByRole("button", { name: /^(Salvar|Verificando\.\.\.|Salvando\.\.\.)$/ });
}

function savedKeys(onSave: ReturnType<typeof vi.fn>) {
  return onSave.mock.calls.map((call) => (call[0] as SaveData).idempotencyKey);
}

/**
 * O duplicate-check do sheet roda sempre que há descrição (isApiConfigured é
 * true no jsdom via proxy same-origin). Sem mock, o fetch real falha de forma
 * não determinística; este double responde `duplicate_detected: false` para
 * o caminho normal de save.
 */
function mockNoDuplicate() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/transactions/detect-duplicate")) {
      return new Response(JSON.stringify({ duplicate_detected: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ items: [], total: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

describe("NewTransactionSheet double-submit guard (#185)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("segundo toque com save em voo não dispara novo onSave e desabilita o botão", async () => {
    const user = userEvent.setup();
    mockNoDuplicate();
    let resolveSave!: () => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={onSave} />);
    await fillValidExpense(user);

    // Primeiro toque: o duplicate-check resolve e o save fica em voo.
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    // Segundo toque na janela real do bug (rede lenta, save pendente).
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveButton()).toBeDisabled());
    expect(onSave).toHaveBeenCalledTimes(1);

    resolveSave();
    await waitFor(() => expect(saveButton()).not.toBeDisabled());
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("retry após resposta incerta reutiliza a mesma chave da intent", async () => {
    const user = userEvent.setup();
    mockNoDuplicate();
    const onSave = vi.fn(async (data: SaveData) => {
      if (onSave.mock.calls.length === 1) {
        // Simula a camada commands: o erro carrega a chave da intent.
        throw attachCommandId(new Error("timeout"), data.idempotencyKey);
      }
    });
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={onSave} />);
    await fillValidExpense(user);

    await user.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(saveButton()).not.toBeDisabled());

    await user.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));

    const [first, second] = savedKeys(onSave);
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it("re-render mantém a chave da intent", async () => {
    const user = userEvent.setup();
    mockNoDuplicate();
    const onSave = vi.fn(async (data: SaveData) => {
      if (onSave.mock.calls.length === 1) {
        throw attachCommandId(new Error("timeout"), data.idempotencyKey);
      }
    });
    const props = { accounts, categories, onSave };
    const { rerender } = render(<NewTransactionSheet {...props} />);
    await fillValidExpense(user);

    await user.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    rerender(<NewTransactionSheet {...props} />);
    await waitFor(() => expect(saveButton()).not.toBeDisabled());
    await user.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));

    const [first, second] = savedKeys(onSave);
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it("duas intents distintas com valores iguais usam chaves diferentes (anti-falso-positivo)", async () => {
    const user = userEvent.setup();
    mockNoDuplicate();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={onSave} />);
    await fillValidExpense(user);

    await user.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await user.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));

    const [first, second] = savedKeys(onSave);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("duplo toque em 'Salvar mesmo assim' confirma uma única vez", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/transactions/detect-duplicate")) {
        return new Response(
          JSON.stringify({
            duplicate_detected: true,
            match: {
              id: "existing-1",
              description: "Mercado",
              amount_cents: "5000",
              date: "2026-08-26T00:00:00.000Z",
              match_type: "semantic",
              similarity: 0.85,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ items: [], total: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    let resolveSave!: () => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={onSave} />);
    await fillValidExpense(user);

    await user.click(saveButton());
    await waitFor(() => {
      expect(screen.getByText(/Lançamento parecido encontrado/)).toBeInTheDocument();
    });
    expect(onSave).not.toHaveBeenCalled();

    const confirmName = /Salvar mesmo assim/;
    fireEvent.click(screen.getByRole("button", { name: confirmName }));
    // O segundo toque só existe se o dialog permanecer aberto durante o save
    // (pós-fix); pré-fix o dialog fecha de imediato e não há segundo alvo.
    const secondConfirm = screen.queryByRole("button", { name: confirmName });
    if (secondConfirm) fireEvent.click(secondConfirm);

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    resolveSave();
    await waitFor(() => expect(screen.queryByText(/Lançamento parecido encontrado/)).not.toBeInTheDocument());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(savedKeys(onSave)[0]).toBeDefined();
  });

  it("troca de aba com save em voo: erro tardio de A não contamina a chave de B", async () => {
    const user = userEvent.setup();
    mockNoDuplicate();
    let rejectSaveA!: (err: unknown) => void;
    const onSave = vi.fn((data: SaveData) => {
      if (onSave.mock.calls.length === 1) {
        return new Promise<void>((_, reject) => {
          rejectSaveA = reject;
        });
      }
      return Promise.resolve();
    });
    render(<NewTransactionSheet accounts={accounts} categories={categories} onSave={onSave} />);
    await fillValidExpense(user);

    // Salvar A: fica em voo (promise pendente).
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const [keyA] = savedKeys(onSave);
    expect(keyA).toBeDefined();

    // Trocar de aba com A pendente → draft novo (chave B), preencher B.
    await user.click(screen.getByRole("button", { name: "Receita" }));
    await fillValidExpense(user);

    // A falha tardiamente com commandId=A.
    rejectSaveA(attachCommandId(new Error("timeout"), keyA));
    await waitFor(() => expect(saveButton()).not.toBeDisabled());

    // Salvar B deve usar a chave de B, nunca a de A.
    await user.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));

    const [, keyB] = savedKeys(onSave);
    expect(keyB).toBeDefined();
    expect(keyB).not.toBe(keyA);
  });
});
