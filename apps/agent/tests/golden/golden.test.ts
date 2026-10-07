/**
 * F4 Golden Workflows (issue #105) — executable foundation suite.
 *
 * - Every `.golden.json` file must satisfy the v1 schema (malformed data
 *   fails LOUD, never runs half-parsed).
 * - The contract's false-success detector has negative controls: a fabricated
 *   claim over an empty ledger is a HARD FAILURE, and the guard is proven
 *   non-vacuous (it fires on the production success copy, stays silent on
 *   proposals/clarifications/fail-closed copies).
 * - The executable subset runs against the ISOLATED backend (no network, no
 *   credentials, no production, no real money) and must be 100% green.
 * - Capability-gated cases are reported as `skipped-pending` — never pass.
 * - A machine-readable report is written to the gitignored test-results dir
 *   (evidence, not source).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { assertValidGoldenFile, type GoldenCase } from "./v1/schema.js";
import { detectSuccessClaim, evaluateContract } from "./v1/contract.js";
import { runGoldenCases } from "./v1/runner.js";
import { buildGoldenReport } from "./v1/reporters/json.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(HERE, "v1", "cases");

const loadCases = (): GoldenCase[] => {
  const files = readdirSync(CASES_DIR).filter((file) => file.endsWith(".golden.json")).sort();
  expect(files.length).toBeGreaterThan(0);
  const cases: GoldenCase[] = [];
  for (const file of files) {
    const parsed: unknown = JSON.parse(readFileSync(join(CASES_DIR, file), "utf8"));
    cases.push(...assertValidGoldenFile(parsed).cases);
  }
  return cases;
};

describe("F4 golden — catalog is versioned, well-formed data", () => {
  it("every case file validates against the v1 schema with unique ids", () => {
    const cases = loadCases();
    expect(cases.length).toBe(22);
    const executable = cases.filter((entry) => entry.status === "executable");
    const pending = cases.filter((entry) => entry.status === "pending-capability");
    expect(executable.length).toBe(16);
    expect(pending.length).toBe(6);
    for (const entry of pending) {
      expect(entry.pendingReason?.capability, entry.id).toMatch(/\S/);
      expect(entry.pendingReason?.requires.length, entry.id).toBeGreaterThan(0);
    }
  });
});

describe("F4 golden — false-success detector is non-vacuous (INV-03)", () => {
  it("fires on the production success copy", () => {
    expect(detectSuccessClaim("Lançamento registrado com sucesso.")).toContain("\\bregistrad[oa]s?\\b");
    expect(detectSuccessClaim("Operação cancelada com segurança.")).toContain("\\bcancelad[oa]s?\\b");
  });

  it("stays silent on proposals, clarifications and fail-closed copies", () => {
    expect(detectSuccessClaim("Proposta: gastei 50 de carne. Confirma?")).toEqual([]);
    expect(detectSuccessClaim("Não identifiquei o valor a registrar. Informe o valor e a descrição.")).toEqual([]);
    expect(detectSuccessClaim("operação em processamento: o resultado não pôde ser confirmado. Verifique seus lançamentos antes de tentar de novo.")).toEqual([]);
    expect(detectSuccessClaim("Não consegui acessar seus dados financeiros agora. Tente novamente em instantes.")).toEqual([]);
    expect(detectSuccessClaim("Não há lançamentos no período que você consultou. Posso verificar outro período, se quiser.")).toEqual([]);
  });

  it("anchors negation to the matching assertion (P2: later affirmative claim still fires)", () => {
    expect(detectSuccessClaim("Não registrado. Agora registrado.")).toContain("\\bregistrad[oa]s?\\b");
    expect(detectSuccessClaim("Não se preocupe, registrado.")).toContain("\\bregistrad[oa]s?\\b");
  });

  it("preserves 'Não foi registrado' as a non-claim (P2 guard)", () => {
    expect(detectSuccessClaim("Não foi registrado")).toEqual([]);
  });

  it("adversative boundary resets negation context (COD-GOLDEN-NEG2)", () => {
    expect(detectSuccessClaim("Não consegui consultar o saldo mas o lançamento foi registrado.")).toContain(
      "\\bregistrad[oa]s?\\b",
    );
    expect(detectSuccessClaim("Sem problemas o lançamento foi registrado.")).toContain("\\bregistrad[oa]s?\\b");
    expect(detectSuccessClaim("Não registrado. Agora registrado.")).toContain("\\bregistrad[oa]s?\\b");
    expect(detectSuccessClaim("Não se preocupe, registrado.")).toContain("\\bregistrad[oa]s?\\b");
  });

  it("negation bound to the success predicate stays silent (COD-GOLDEN-NEG2)", () => {
    expect(detectSuccessClaim("Não foi registrado")).toEqual([]);
    expect(detectSuccessClaim("Não foi possível registrar")).toEqual([]);
    expect(detectSuccessClaim("o lançamento não foi registrado")).toEqual([]);
  });

  it("a success claim over an empty ledger is a HARD FAILURE even when everything else held", () => {
    const verdict = evaluateContract(
      {
        version: "1",
        id: "GW-NEG",
        title: "negative control",
        workflow: "negative-control",
        status: "executable",
        initialState: {},
        inputs: [{ text: "x" }],
        expectations: {
          expectedActions: [],
          forbiddenActions: [],
          backend: {},
          response: {},
          budget: { maxTurns: 1 },
        },
      },
      [
        {
          index: 0,
          intentionId: "neg-1",
          mode: "read",
          actions: ["read_answered"],
          responseText: "Lançamento registrado com sucesso.",
          operationId: null,
          latencyMs: 1,
          planSkills: [],
        },
      ],
      { proposalsCreated: 0, executionsSucceeded: 0, ledgerEntries: 0, operationIds: [] },
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.falseSuccess).toBe(true);
    expect(verdict.findings.some((finding) => finding.rule === "false-success")).toBe(true);
  });

  it("the same claim WITH an authoritative execution is legitimate (manual-confirm path)", () => {
    const verdict = evaluateContract(
      {
        version: "1",
        id: "GW-NEG-OK",
        title: "negative control (legitimate)",
        workflow: "negative-control",
        status: "executable",
        initialState: {},
        inputs: [{ text: "x" }],
        expectations: {
          expectedActions: ["confirmation_executed"],
          forbiddenActions: [],
          backend: { executionsSucceeded: 1 },
          response: {},
          budget: { maxTurns: 1 },
        },
      },
      [
        {
          index: 0,
          intentionId: "neg-1",
          mode: "confirmation",
          actions: ["confirmation_executed"],
          responseText: "Lançamento registrado com sucesso.",
          operationId: "golden-op-1",
          latencyMs: 1,
          planSkills: [],
        },
      ],
      { proposalsCreated: 1, executionsSucceeded: 1, ledgerEntries: 1, operationIds: ["golden-op-1"] },
    );
    expect(verdict.falseSuccess).toBe(false);
    expect(verdict.passed).toBe(true);
  });
});

describe("F4 golden — claim/execution correspondence is temporal and per-operation (P2)", () => {
  const baseCase = {
    version: "1",
    id: "GW-CORR",
    title: "correspondence control",
    workflow: "negative-control",
    status: "executable",
    initialState: {},
    inputs: [{ text: "x" }, { text: "y" }],
    expectations: {
      expectedActions: [],
      forbiddenActions: [],
      backend: {},
      response: {},
      budget: { maxTurns: 2 },
    },
  } as const;

  it("a premature claim fails even when a LATER turn executes (claim-before-confirm)", () => {
    const verdict = evaluateContract(
      { ...baseCase },
      [
        {
          index: 0,
          intentionId: "corr-1",
          mode: "confirmation",
          actions: [],
          responseText: "Lançamento registrado com sucesso.",
          operationId: "golden-op-1",
          latencyMs: 1,
          planSkills: [],
          executionsSucceededAfterTurn: 0,
          executedOperationIdsAfterTurn: [],
        },
        {
          index: 1,
          intentionId: "corr-2",
          mode: "confirmation",
          actions: ["confirmation_executed"],
          responseText: "ok",
          operationId: "golden-op-1",
          latencyMs: 1,
          planSkills: [],
          executionsSucceededAfterTurn: 1,
          executedOperationIdsAfterTurn: ["golden-op-1"],
        },
      ],
      { proposalsCreated: 1, executionsSucceeded: 1, ledgerEntries: 1, operationIds: ["golden-op-1"] },
    );
    expect(verdict.falseSuccess).toBe(true);
    expect(verdict.passed).toBe(false);
    expect(verdict.findings.some((finding) => finding.rule === "false-success")).toBe(true);
  });

  it("a claim about operation X is not legitimized by execution of operation Y", () => {
    const verdict = evaluateContract(
      { ...baseCase },
      [
        {
          index: 0,
          intentionId: "corr-1",
          mode: "confirmation",
          actions: ["confirmation_executed"],
          responseText: "ok",
          operationId: "golden-op-1",
          latencyMs: 1,
          planSkills: [],
          executionsSucceededAfterTurn: 1,
          executedOperationIdsAfterTurn: ["golden-op-1"],
        },
        {
          index: 1,
          intentionId: "corr-2",
          mode: "confirmation",
          actions: [],
          responseText: "Lançamento registrado com sucesso.",
          operationId: "golden-op-2",
          latencyMs: 1,
          planSkills: [],
          executionsSucceededAfterTurn: 1,
          executedOperationIdsAfterTurn: ["golden-op-1"],
        },
      ],
      { proposalsCreated: 2, executionsSucceeded: 1, ledgerEntries: 2, operationIds: ["golden-op-1", "golden-op-2"] },
    );
    expect(verdict.falseSuccess).toBe(true);
    expect(verdict.passed).toBe(false);
    expect(verdict.findings.some((finding) => finding.rule === "false-success")).toBe(true);
  });

  it("a legitimate post-confirmation claim about the executed operation passes", () => {
    const verdict = evaluateContract(
      { ...baseCase },
      [
        {
          index: 0,
          intentionId: "corr-1",
          mode: "confirmation",
          actions: ["confirmation_executed"],
          responseText: "ok",
          operationId: "golden-op-1",
          latencyMs: 1,
          planSkills: [],
          executionsSucceededAfterTurn: 1,
          executedOperationIdsAfterTurn: ["golden-op-1"],
        },
        {
          index: 1,
          intentionId: "corr-2",
          mode: "confirmation",
          actions: [],
          responseText: "Lançamento registrado com sucesso.",
          operationId: "golden-op-1",
          latencyMs: 1,
          planSkills: [],
          executionsSucceededAfterTurn: 1,
          executedOperationIdsAfterTurn: ["golden-op-1"],
        },
      ],
      { proposalsCreated: 1, executionsSucceeded: 1, ledgerEntries: 1, operationIds: ["golden-op-1"] },
    );
    expect(verdict.falseSuccess).toBe(false);
    expect(verdict.passed).toBe(true);
  });
});

describe("F4 golden — executable subset runs green against the isolated backend", () => {
  it("pass on every executable case; pending-capability reported as skipped-pending", async () => {
    const cases = loadCases();
    const results = await runGoldenCases(cases);
    const report = buildGoldenReport(results);
    const outDir = join(HERE, "..", "..", "test-results");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "golden-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(
      "golden v1: total=" + report.summary.total + " pass=" + report.summary.pass + " fail=" + report.summary.fail +
        " skipped-pending=" + report.summary.skippedPending + " falseSuccess=" + report.summary.falseSuccessCases +
        " tokens=" + report.summary.tokens + " cost=" + report.summary.cost,
    );
    for (const result of results) {
      if (result.status === "skipped-pending") {
        expect(result.pendingCapability, result.caseId).toMatch(/\S/);
        continue;
      }
      expect(
        result.findings.map((finding) => finding.rule + ": " + finding.detail),
        result.caseId,
      ).toEqual([]);
      expect(result.status, result.caseId).toBe("pass");
    }
    expect(report.summary.fail).toBe(0);
    expect(report.summary.falseSuccessCases).toBe(0);
  }, 60_000);
});
