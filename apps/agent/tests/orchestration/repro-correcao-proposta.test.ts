import { describe, expect, it, vi } from "vitest";
import { ConversationOrchestrator, normalizeRestTurn, type AuthenticatedIdentity } from "../../src/orchestration/conversation-orchestrator.js";
import { MutationApiClient } from "../../src/mutations/mutation-api-client.js";
import { InMemoryMutationDraftStore } from "../../src/mutations/mutation-draft.js";
import type { EntityReader } from "../../src/mutations/entity-resolver.js";
import { DEFAULT_CATEGORY_CATALOG } from "../../../../apps/api/src/categories/catalog.js";

const identity: AuthenticatedIdentity = { actorId: "actor-repro", workspaceId: "workspace-teste-ted", role: "member", deviceId: "device-repro" };
const NUBANK = { id: "00000000-0000-4000-8000-000000000001", name: "Nubank" };

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

const reader = (): EntityReader => ({ listAccounts: async () => [NUBANK], listCategories: async () => catalogCategories() });

type FakeOp = { id: string; status: string; tool?: string; createdAt: string; expiresAt: string; payload: string; idempotencyKey?: string };

const makeFakeApi = () => {
  const ops = new Map<string, FakeOp>();
  const byKey = new Map<string, string>();
  let seq = 0;
  const calls: Array<{ method: string; path: string; body?: unknown; idempotencyKey?: string }> = [];
  const request = vi.fn(async (method: string, path: string, opts?: { body?: unknown; idempotencyKey?: string }) => {
    calls.push({ method, path, body: opts?.body, idempotencyKey: opts?.idempotencyKey });
    if (method === "GET" && path === "/pending-operations/v2/active") {
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
      const op: FakeOp = { id, status: "proposed", tool: typeof wireBody.tool === "string" ? wireBody.tool : undefined, createdAt: "2026-11-15T20:38:00.000Z", expiresAt: "2026-11-15T21:38:00.000Z", payload, idempotencyKey: key };
      ops.set(id, op);
      if (key) byKey.set(key, id);
      return { id };
    }
    throw new Error("unexpected request " + method + " " + path);
  });
  const proposePosts = () => calls.filter((c) => c.method === "POST" && c.path === "/pending-operations/v2/propose");
  return { api: new MutationApiClient({ request: request as never }), request, calls, ops, proposePosts };
};

const setup = (fake: ReturnType<typeof makeFakeApi>) => {
  const store = new InMemoryMutationDraftStore();
  const orchestrator = new ConversationOrchestrator({ mutationApiClient: fake.api, entityReader: reader(), draftStore: store });
  const run = (text: string, intentionId: string) => orchestrator.runTurn(normalizeRestTurn({ text, intentionId }, identity));
  return { orchestrator, store, run };
};

describe("repro: correção de proposta ativa - Coloca como décimo terceiro", () => {
  it("documenta comportamento ATUAL da sequência real (não corrige bug)", async () => {
    const fake = makeFakeApi();
    const { run } = setup(fake);

    let turn1Error: unknown; let turn1: any;
    try { turn1 = await run("Recebi 3200 de décimo", "intent-repro-1"); } catch (e) { turn1Error = e; }

    let turn2Error: unknown; let turn2: any;
    try { turn2 = await run("Salario", "intent-repro-2"); } catch (e) { turn2Error = e; }

    let turn3Error: unknown; let turn3: any;
    try { turn3 = await run("Coloca como décimo terceiro", "intent-repro-3"); } catch (e) { turn3Error = e; }

    const turn3HasStructuredDecision = !!(turn3?.mutation || turn3?.pendingOperation || turn3?.proposal || turn3?.undoProposal);
    const turn3HasText = !!(turn3?.response?.text && String(turn3.response.text).trim().length > 0);
    const turn3EmptyNoDecision = !turn3Error && !turn3HasText && !turn3HasStructuredDecision;

    console.log("REPRO_SNAPSHOT:" + JSON.stringify({
      turn1: { threw: !!turn1Error, error: turn1Error instanceof Error ? (turn1Error.name + ": " + turn1Error.message) : undefined, output: turn1?.response?.text, mode: turn1?.plan?.mode, missing: turn1?.plan?.missingFields ?? turn1?.clarification?.missingFields, mutation: turn1?.mutation },
      turn2: { threw: !!turn2Error, error: turn2Error instanceof Error ? (turn2Error.name + ": " + turn2Error.message) : undefined, output: turn2?.response?.text, mode: turn2?.plan?.mode, missing: turn2?.plan?.missingFields ?? turn2?.clarification?.missingFields, mutation: turn2?.mutation },
      turn3: { threw: !!turn3Error, error: turn3Error instanceof Error ? (turn3Error.name + ": " + turn3Error.message) : undefined, stack: turn3Error instanceof Error ? turn3Error.stack?.split("\n").slice(0,6).join("\n") : undefined, output: turn3?.response?.text, mode: turn3?.plan?.mode, mutation: turn3?.mutation, clarification: turn3?.clarification },
      classification: { turn3HasText, turn3HasStructuredDecision, turn3EmptyNoDecision },
      proposePosts: fake.proposePosts().length,
      proposeBodies: fake.proposePosts().map((c) => c.body),
      activeOps: [...fake.ops.values()].map((o) => ({ id: o.id, status: o.status, tool: o.tool })),
    }, null, 2));

    expect(turn1Error, "turn1 não deve lançar").toBeFalsy();
    expect(turn2Error, "turn2 não deve lançar").toBeFalsy();

    // Comportamento ATUAL (documentado): se exceção/vazio-sem-decisão => falha retentável na PWA.
    // Esperado FUTURO: corrigir descrição da proposta ativa com segurança (não assertado aqui).
    if (turn3Error || turn3EmptyNoDecision) {
      expect(true).toBe(true); // reprodução da falha: exceção ou resposta vazia sem decisão
    } else {
      expect(turn3HasText || turn3HasStructuredDecision).toBe(true);
    }
  });
});
