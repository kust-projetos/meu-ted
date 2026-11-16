import { describe, expect, it, vi } from "vitest";
import { ConversationOrchestrator, normalizeRestTurn, type AuthenticatedIdentity, type CategorySuggestionProvider } from "../../src/orchestration/conversation-orchestrator.js";
import { MutationApiClient } from "../../src/mutations/mutation-api-client.js";
import { InMemoryMutationDraftStore } from "../../src/mutations/mutation-draft.js";
import type { EntityReader } from "../../src/mutations/entity-resolver.js";
import { DEFAULT_CATEGORY_CATALOG } from "../../../../apps/api/src/categories/catalog.js";

const identity: AuthenticatedIdentity = { actorId: "actor-repro", workspaceId: "workspace-teste-ted", role: "member", deviceId: "device-repro" };
const NUBANK = { id: "00000000-0000-4000-8000-000000000001", name: "Nubank" };
const INTER = { id: "00000000-0000-4000-8000-000000000002", name: "Inter" };

const catalogCategories = () => {
  const out: Array<{ id: string; name: string; kind: "expense" | "income"; parentId?: string }> = [];
  for (const macro of DEFAULT_CATEGORY_CATALOG) {
    const macroId = ("macro-" + macro.kind + "-" + macro.name).toLowerCase().replace(/\s+/g, "-");
    out.push({ id: macroId, name: macro.name, kind: macro.kind });
    for (const sub of macro.subs) {
      const subId = ("sub-" + macro.kind + "-" + macro.name + "-" + sub.name).toLowerCase().replace(/\s+/g, "-");
      out.push({ id: subId, name: sub.name, kind: macro.kind, parentId: macroId });
    }
  }
  return out;
};

const reader = (): EntityReader => ({
  listAccounts: async () => [NUBANK, INTER],
  listCategories: async () => catalogCategories(),
});

type FakeOp = { id: string; status: string; tool?: string; createdAt: string; expiresAt: string; payload: string; idempotencyKey?: string };

const makeFakeApi = (supersedeFailure?: { statusCode: number; code: string; afterCommit?: boolean }, reconciliation?: "empty" | "error") => {
  const ops = new Map<string, FakeOp>();
  const byKey = new Map<string, string>();
  let seq = 0;
  const calls: Array<{ method: string; path: string; body?: unknown; idempotencyKey?: string }> = [];
  let reconciling = false;
  const request = vi.fn(async (method: string, path: string, opts?: { body?: unknown; idempotencyKey?: string }) => {
    calls.push({ method, path, body: opts?.body, idempotencyKey: opts?.idempotencyKey });
      if (method === "GET" && path === "/pending-operations/v2/active") {
      if (reconciling && reconciliation === "error") throw new Error("list failed");
      if (reconciling && reconciliation === "empty") return { items: [], total: 0 };
      const items = [...ops.values()].filter((op) => op.status === "proposed" || op.status === "confirmed").map((op) => {
        const parsed = JSON.parse(op.payload || "{}") as { tool?: unknown; normalizedArgs?: Record<string, unknown> };
        const args = (parsed.normalizedArgs ?? {}) as Record<string, unknown>;
        return { id: op.id, status: op.status, tool: parsed.tool ?? op.tool, createdAt: op.createdAt, expiresAt: op.expiresAt, ...(typeof args.amountCents === "number" ? { amountCents: args.amountCents } : {}), ...(typeof args.description === "string" ? { description: args.description } : {}) };
      });
      return { items, total: items.length };
    }
    const cancelMatch = /^\/pending-operations\/v2\/([^/]+)\/cancel$/.exec(path);
    if (method === "POST" && cancelMatch) {
      const id = decodeURIComponent(cancelMatch[1]!);
      const op = ops.get(id);
      if (!op) throw Object.assign(new Error("approval.not_found"), { statusCode: 404 });
      op.status = "cancelled";
      return { id, status: "cancelled" };
    }
    const getMatch = /^\/pending-operations\/v2\/([^/]+)$/.exec(path);
    if (method === "GET" && getMatch) {
      const op = ops.get(decodeURIComponent(getMatch[1]!));
      if (!op) throw Object.assign(new Error("approval.not_found"), { statusCode: 404 });
      const parsed = JSON.parse(op.payload) as { tool: string; normalizedArgs: Record<string, unknown> };
      return { ...parsed, id: op.id, status: op.status, proposalHash: "a".repeat(64), workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId };
    }
    const supersedeMatch = /^\/pending-operations\/v2\/([^/]+)\/supersede$/.exec(path);
    if (method === "POST" && supersedeMatch) {
      const oldId = decodeURIComponent(supersedeMatch[1]!);
      const old = ops.get(oldId);
      if (!old) throw Object.assign(new Error("approval.not_found"), { statusCode: 404 });
      if (supersedeFailure && !supersedeFailure.afterCommit) {
        reconciling = true;
        throw Object.assign(new Error(supersedeFailure.code), supersedeFailure);
      }
      const wireBody = opts?.body as { tool: string; normalizedArgs: Record<string, unknown> };
      const key = opts?.idempotencyKey!;
      const existingId = byKey.get(key);
      if (existingId) return { id: existingId, existing: true, supersedes: oldId };
      old.status = "superseded";
      seq += 1;
      const id = "pending-" + seq;
      ops.set(id, { id, status: "proposed", tool: wireBody.tool, createdAt: old.createdAt, expiresAt: old.expiresAt, payload: JSON.stringify(wireBody), idempotencyKey: key });
      byKey.set(key, id);
      if (supersedeFailure?.afterCommit) {
        reconciling = true;
        throw Object.assign(new Error(supersedeFailure.code), supersedeFailure);
      }
      return { id, existing: false, supersedes: oldId };
    }
    if (method === "POST" && path === "/pending-operations/v2/propose") {
      const key = opts?.idempotencyKey;
      const wireBody = (opts?.body ?? {}) as { tool?: unknown; normalizedArgs?: unknown };
      const payload = JSON.stringify({ tool: wireBody.tool, normalizedArgs: wireBody.normalizedArgs });
      if (key) {
        const existingId = byKey.get(key);
        if (existingId) {
          const existing = ops.get(existingId)!;
          if (existing.payload !== payload) { const conflict = new Error("idempotency.conflict"); (conflict as { statusCode?: number }).statusCode = 409; throw conflict; }
          return { id: existingId, existing: true };
        }
      }
      seq += 1;
      const id = "pending-" + seq;
      ops.set(id, { id, status: "proposed", tool: typeof wireBody.tool === "string" ? wireBody.tool : undefined, createdAt: "2026-11-15T20:38:00.000Z", expiresAt: "2026-11-15T21:38:00.000Z", payload, idempotencyKey: key });
      if (key) byKey.set(key, id);
      return { id };
    }
    throw new Error("unexpected request " + method + " " + path);
  });
  const proposePosts = () => calls.filter((c) => c.method === "POST" && c.path === "/pending-operations/v2/propose");
  const seed = (id = "pending-seeded", tool = "transactions.income.create", normalizedArgs: Record<string, unknown> = {
    amountCents: 320000, description: "décimo", date: "2026-11-15", accountId: NUBANK.id, categoryId: "salario",
  }) => {
    const op: FakeOp = { id, status: "proposed", tool, createdAt: "2026-11-15T20:38:00.000Z", expiresAt: "2026-11-15T21:38:00.000Z", payload: JSON.stringify({ tool, normalizedArgs }) };
    ops.set(id, op);
    return op;
  };
  return { api: new MutationApiClient({ request: request as never }), request, calls, ops, proposePosts, seed };
};

const setup = (
  fake: ReturnType<typeof makeFakeApi>,
  categorySuggestionProvider?: CategorySuggestionProvider,
) => {
  const store = new InMemoryMutationDraftStore();
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: fake.api, entityReader: reader(), draftStore: store,
    ...(categorySuggestionProvider ? { categorySuggestionProvider } : {}),
  });
  const run = (text: string, intentionId: string) => orchestrator.runTurn(normalizeRestTurn({ text, intentionId }, identity));
  return { orchestrator, store, run };
};

describe("repro: correção de proposta ativa - Coloca como décimo terceiro", () => {
  it.each([
    "Muda minha meta de gastos",
    "Troca a senha",
    "Corrige o saldo",
    "Era pra ser uma transferência",
  ])("%s não reescreve a descrição sem construção explícita de nomeação", async (text) => {
    const fake = makeFakeApi();
    const original = { amountCents: 320000, description: "décimo", date: "2026-11-15", accountId: NUBANK.id, categoryId: "salario" };
    fake.seed("pending-seeded", "transactions.income.create", original);
    const before = JSON.parse(fake.ops.get("pending-seeded")!.payload).normalizedArgs;
    await setup(fake).run(text, `intent-no-description-${text}`);
    expect(fake.calls.some((call) => call.path.endsWith("/supersede"))).toBe(false);
    expect(fake.proposePosts()).toHaveLength(0);
    expect(JSON.parse(fake.ops.get("pending-seeded")!.payload).normalizedArgs).toEqual(before);
  });

  it("não interpreta 'Era pra ser no Inter' como nomeação de descrição", async () => {
    const fake = makeFakeApi();
    const original = { amountCents: 320000, description: "décimo", date: "2026-11-15", accountId: NUBANK.id, categoryId: "salario" };
    fake.seed("pending-seeded", "transactions.income.create", original);
    const result = await setup(fake).run("Era pra ser no Inter", "intent-era-inter");
    expect(fake.calls.some((call) => call.path.endsWith("/supersede"))).toBe(false);
    expect(JSON.parse(fake.ops.get("pending-seeded")!.payload).normalizedArgs).toEqual(original);
    expect(result.response?.text).toContain("Não consegui identificar");
  });

  it("substitui proposta por correção referencial e preserva os demais campos", async () => {
    const fake = makeFakeApi();
    const { run } = setup(fake);

    fake.seed();

    let turn3Error: unknown; let turn3: any;
    try { turn3 = await run("Coloca como décimo terceiro", "intent-repro-3"); } catch (e) { turn3Error = e; }

    const turn3HasStructuredDecision = !!(turn3?.mutation || turn3?.pendingOperation || turn3?.proposal || turn3?.undoProposal);
    const turn3HasText = !!(turn3?.response?.text && String(turn3.response.text).trim().length > 0);
    const turn3EmptyNoDecision = !turn3Error && !turn3HasText && !turn3HasStructuredDecision;


    expect(turn3Error).toBeFalsy();
    expect(turn3EmptyNoDecision).toBe(false);
    expect(turn3HasText || turn3HasStructuredDecision).toBe(true);
    expect(fake.calls.some((call) => call.path.endsWith("/supersede"))).toBe(true);
    expect(fake.proposePosts()).toHaveLength(0);
    expect(fake.calls.some((call) => /\/(?:confirm|execute|authorize)$/.test(call.path))).toBe(false);
    const replacement = [...fake.ops.values()].find((op) => op.id !== "pending-seeded");
    expect(replacement).toBeDefined();
    expect(JSON.parse(replacement!.payload).normalizedArgs).toMatchObject({
      description: "Décimo terceiro", amountCents: 320000, date: "2026-11-15", accountId: NUBANK.id, categoryId: "salario",
    });
  });

  it("corrige somente o valor e preserva descrição, categoria e conta", async () => {
    const fake = makeFakeApi();
    fake.seed("pending-seeded", "transactions.income.create", {
      amountCents: 320000, description: "Salário", date: "2026-11-15", accountId: NUBANK.id, categoryId: "salario",
    });
    const { run } = setup(fake);
    const result = await run("O valor certo é 3500", "intent-value-correction");
    expect(result.response?.text).toContain("Atualizei a proposta");
    const replacement = [...fake.ops.values()].find((op) => op.id !== "pending-seeded");
    expect(replacement).toBeDefined();
    expect(JSON.parse(replacement!.payload).normalizedArgs).toMatchObject({
      amountCents: 350000, description: "Salário", categoryId: "salario", accountId: NUBANK.id,
    });
    expect(fake.proposePosts()).toHaveLength(0);
  });

  it("não substitui um lançamento completo, mesmo com marcador referencial", async () => {
    const fake = makeFakeApi();
    fake.seed();
    const { run } = setup(fake);
    await run("Na verdade paguei 120 no mercado", "intent-new-operation");
    expect(fake.calls.some((call) => call.path.endsWith("/supersede"))).toBe(false);
  });

  it("pede desambiguação quando há duas propostas decidíveis", async () => {
    const fake = makeFakeApi();
    fake.seed("pending-a");
    fake.seed("pending-b");
    const { run } = setup(fake);
    const result = await run("Coloca como décimo terceiro", "intent-ambiguous-correction");
    expect(result.response?.text).toContain("mais de uma proposta");
    expect(fake.calls.some((call) => call.path.endsWith("/supersede"))).toBe(false);
    expect(fake.proposePosts()).toHaveLength(0);
  });

  it("trata replay da mesma chave de supersede como sucesso idempotente", async () => {
    const fake = makeFakeApi();
    fake.seed();
    const identityWithDevice = { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: "device-repro" };
    const normalizedArgs = { amountCents: 350000, description: "Salário", date: "2026-11-15", accountId: NUBANK.id, categoryId: "salario" };
    const input = {
      operationId: "pending-seeded", tool: "transactions.income.create", normalizedArgs,
      identity: identityWithDevice, expectedProposalHash: "a".repeat(64), idempotencyKey: "stable-correction-key",
    };
    const first = await fake.api.supersede(input);
    const replay = await fake.api.supersede(input);
    expect(replay).toMatchObject({ id: first.id, existing: true, supersedes: "pending-seeded" });
    expect([...fake.ops.values()].filter((op) => op.status === "proposed")).toHaveLength(1);
    expect(fake.proposePosts()).toHaveLength(0);
  });

  it("reconcilia resultado incerto sem afirmar estado sem prova", async () => {
    const committed = makeFakeApi({ statusCode: 503, code: "response_lost", afterCommit: true });
    committed.seed();
    const updated = await setup(committed).run("Coloca como décimo terceiro", "intent-uncertain-new");
    expect(updated.response?.text).toContain("A proposta foi atualizada");
    expect(updated.response?.text).toContain("Confira o cartão");

    const unchanged = makeFakeApi({ statusCode: 503, code: "offline" });
    unchanged.seed();
    const stillActive = await setup(unchanged).run("Coloca como décimo terceiro", "intent-uncertain-old");
    expect(stillActive.response?.text).toContain("A proposta anterior continua valendo");

    for (const mode of ["empty", "error"] as const) {
      const unknown = makeFakeApi({ statusCode: 503, code: "offline" }, mode);
      unknown.seed();
      const result = await setup(unknown).run("Coloca como décimo terceiro", `intent-uncertain-${mode}`);
      expect(result.response?.text).toContain("Confira o cartão");
      expect(result.response?.text).not.toContain("A proposta anterior continua valendo");
    }
  });

  it("não consulta provider semântico ao corrigir somente a descrição", async () => {
    const fake = makeFakeApi();
    fake.seed();
    const suggest = vi.fn(async () => null);
    const { run } = setup(fake, suggest);
    await run("Coloca como décimo terceiro", "intent-category-suggestion");
    expect(suggest).not.toHaveBeenCalled();
    const replacement = [...fake.ops.values()].find((op) => op.id !== "pending-seeded");
    expect(JSON.parse(replacement!.payload).normalizedArgs).toMatchObject({
      description: "Décimo terceiro", categoryId: "salario",
    });
  });

  it("preserva categoria na correção de descrição mesmo quando o provider sugere outra", async () => {
    const fake = makeFakeApi();
    fake.seed();
    const suggest = vi.fn(async () => ({ categoryId: "outra-categoria" }));
    await setup(fake, suggest).run("Coloca como décimo terceiro", "intent-preserve-category");
    const replacement = [...fake.ops.values()].find((op) => op.id !== "pending-seeded");
    expect(JSON.parse(replacement!.payload).normalizedArgs).toMatchObject({
      description: "Décimo terceiro", categoryId: "salario",
    });
    expect(suggest).not.toHaveBeenCalled();
  });

  it("prioriza conta e categoria existentes antes de tratar o hint como descrição", async () => {
    const accountFake = makeFakeApi();
    accountFake.seed("pending-seeded", "transactions.income.create", {
      amountCents: 320000, description: "décimo", date: "2026-11-15", accountId: NUBANK.id, categoryId: "salario",
    });
    const accountResult = await setup(accountFake).run("Coloca no Inter", "intent-account-exact");
    expect(accountResult.response?.text).toContain("Atualizei a proposta");
    const accountReplacement = [...accountFake.ops.values()].find((op) => op.id !== "pending-seeded");
    expect(JSON.parse(accountReplacement!.payload).normalizedArgs).toMatchObject({
      accountId: INTER.id, description: "décimo",
    });

    const categoryFake = makeFakeApi();
    categoryFake.seed("pending-seeded", "transactions.income.create", {
      amountCents: 320000, description: "décimo", date: "2026-11-15", accountId: NUBANK.id, categoryId: "other",
    });
    await setup(categoryFake).run("Isso é Salário", "intent-category-exact");
    const categoryReplacement = [...categoryFake.ops.values()].find((op) => op.id !== "pending-seeded");
    const salaryCategory = catalogCategories().find((category) => category.kind === "income" && category.name === "Salário");
    expect(salaryCategory).toBeDefined();
    expect(JSON.parse(categoryReplacement!.payload).normalizedArgs).toMatchObject({
      categoryId: salaryCategory!.id, description: "décimo",
    });
  });

  it("prioriza a data relativa sem reescrever descrição/valor/conta", async () => {
    const fake = makeFakeApi();
    fake.seed("pending-seeded", "transactions.income.create", {
      amountCents: 320000, description: "décimo", date: "2000-01-01", accountId: NUBANK.id, categoryId: "salario",
    });
    await setup(fake).run("Foi ontem", "intent-date-correction");
    const replacement = [...fake.ops.values()].find((op) => op.id !== "pending-seeded");
    expect(JSON.parse(replacement!.payload).normalizedArgs).toMatchObject({
      description: "décimo", amountCents: 320000, accountId: NUBANK.id,
    });
    expect(JSON.parse(replacement!.payload).normalizedArgs.date).not.toBe("2000-01-01");
  });

  it.each([
    { statusCode: 404, code: "pending.supersede_disabled" },
    { statusCode: 409, code: "pending.proposal_changed" },
  ])("$code responde honestamente e não cria outra proposta", async (failure) => {
    const fake = makeFakeApi(failure);
    fake.seed();
    const { run } = setup(fake);
    const result = await run("Coloca como décimo terceiro", `intent-${failure.statusCode}`);
    expect(result.response?.text).toContain("A proposta anterior continua valendo");
    expect(fake.proposePosts()).toHaveLength(0);
    expect(fake.ops.get("pending-seeded")?.status).toBe("proposed");
    expect([...fake.ops.keys()]).toEqual(["pending-seeded"]);
    expect(fake.calls.some((call) => /\/(?:confirm|execute|authorize)$/.test(call.path))).toBe(false);
  });
});
