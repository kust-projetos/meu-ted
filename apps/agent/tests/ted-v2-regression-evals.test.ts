import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SPEC_MINIMUMS,
  assertSpecMinimums,
  formatCategoryTable,
  runBehavioralMatrix,
  type BehavioralScenario,
} from "../evals/ted-v2-behavioral-suite.js";

type Scenario = BehavioralScenario & {
  category: "route" | "tool" | "arguments" | "confirmation" | "grounding" | "execution";
  input: Record<string, unknown>;
  expected: {
    decision: "allow" | "deny" | "ask_confirmation" | "ask_clarification" | "grounding_required" | "retry";
    sideEffects: "none" | "at_most_one_mutation";
    llm: "not_required";
  };
  invariant: string;
};

async function loadScenarios(): Promise<Scenario[]> {
  const path = resolve(import.meta.dirname, "../evals/ted-v2-regression-matrix.json");
  const scenarios = JSON.parse(await readFile(path, "utf8")) as Scenario[];
  return scenarios.map((scenario) => {
    const exec = scenario.exec as {
      utterance?: string;
      utterances?: string[];
      entities?: { categories?: { id: string; name: string; kind?: "expense" | "income" }[] };
    };
    const utterance = exec.utterance ?? exec.utterances?.[0] ?? "";
    const kind = /\b(recebi|ganhei)\b/i.test(utterance) ? "income" : "expense";
    if (!exec.entities?.categories) return scenario;
    return {
      ...scenario,
      exec: {
        ...exec,
        entities: {
          ...exec.entities,
          categories: exec.entities.categories.map((category) => ({
            ...category,
            kind: category.kind ?? kind,
          })),
        },
      },
    };
  });
}

describe("TED V2 deterministic regression matrix", () => {
  it("contains at least 50 versioned, deterministic scenarios", async () => {
    const scenarios = await loadScenarios();
    expect(scenarios.length).toBeGreaterThanOrEqual(50);
    expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(scenarios.length);
    expect(scenarios.every((scenario) => /^TEDV2-[0-9]{3}$/.test(scenario.id))).toBe(true);
    expect(scenarios.every((scenario) => scenario.expected.llm === "not_required")).toBe(true);
  });

  it("covers every mandatory regression dimension", async () => {
    const scenarios = await loadScenarios();
    const categories = new Set(scenarios.map((scenario) => scenario.category));
    expect(categories).toEqual(new Set(["route", "tool", "arguments", "confirmation", "grounding", "execution"]));
  });

  it("keeps security-critical cases fail-closed and side-effect free", async () => {
    const scenarios = await loadScenarios();
    const requiredIds = ["TEDV2-001", "TEDV2-002", "TEDV2-003", "TEDV2-004", "TEDV2-005", "TEDV2-006", "TEDV2-007", "TEDV2-008", "TEDV2-009", "TEDV2-010"];
    const critical = scenarios.filter((scenario) => requiredIds.includes(scenario.id));
    expect(critical).toHaveLength(requiredIds.length);
    expect(critical.every((scenario) => scenario.expected.decision !== "allow")).toBe(true);
    expect(critical.every((scenario) => scenario.expected.sideEffects === "none")).toBe(true);
  });

  it("requires explicit expected decision, side-effect bound, and invariant evidence", async () => {
    const scenarios = await loadScenarios();
    for (const scenario of scenarios) {
      expect(scenario.input).toBeTypeOf("object");
      expect(scenario.invariant.trim().length).toBeGreaterThan(10);
      expect(["allow", "deny", "ask_confirmation", "ask_clarification", "grounding_required", "retry"]).toContain(scenario.expected.decision);
      expect(["none", "at_most_one_mutation"]).toContain(scenario.expected.sideEffects);
    }
  });

  it("maps every scenario to a SPEC AGENT-011 functional category with executable behavior", async () => {
    const scenarios = await loadScenarios();
    expect(scenarios.every((scenario) => Object.keys(SPEC_MINIMUMS).includes(scenario.specCategory))).toBe(true);
    expect(scenarios.every((scenario) => typeof scenario.exec?.kind === "string")).toBe(true);
    expect(scenarios.every((scenario) => scenario.expect !== null && typeof scenario.expect === "object")).toBe(true);
  });

  it("meets the six SPEC AGENT-011 category minimums", async () => {
    const scenarios = await loadScenarios();
    const { counts } = assertSpecMinimums(scenarios);
    for (const [category, minimum] of Object.entries(SPEC_MINIMUMS)) {
      expect(counts[category]).toBeGreaterThanOrEqual(minimum);
    }
  });
});

describe("TED V2 behavioral regression suite", () => {
  it("executes every scenario against the real modules with deterministic fakes", async () => {
    const scenarios = await loadScenarios();
    const report = await runBehavioralMatrix(scenarios);
    console.log(`TED V2 behavioral: ${report.passed}/${report.total} passed\n${formatCategoryTable(report)}`);
    expect(report.failures.map((failure) => `${failure.id}: ${failure.detail}`)).toEqual([]);
  }, 30_000);
});
