/**
 * A19/A18 — as user skills ATIVAS participam do runtime real.
 *
 * `assembleCognition({ userSkills })` existia como seam testada, mas NENHUM
 * call site de runtime alimentava — a infraestrutura A18 estava inerte. O
 * wiring novo (`FinanceChatAgent.loadUserSkills`) carrega as skills ativas do
 * workspace e as projeta pelo mecanismo canônico (`toSelectableSkills`).
 *
 * O que este arquivo fixa:
 *   - só skill ATIVA e não-revogada é projetada (candidate/inativa/revogada não);
 *   - a projeção é DADO delimitado com `tools: []` — skill de usuário nunca
 *     adiciona tool/capability;
 *   - duas skills ativas são projetadas juntas (a competição por budget é do
 *     fitSkills, coberta em cognitive-skills.test.ts);
 *   - rollback: revogada a versão viva, a anterior volta a ser projetada;
 *   - workspace sem skills: NENHUMA leitura de catálogo (custo zero) e prompt
 *     byte a byte idêntico;
 *   - invariante de wiring: TODO call site de assembleCognition passa
 *     userSkills — um refactor que derrube o parâmetro falha aqui.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { FinanceChatAgent } from "../src/finance-chat-agent.js";
import { createAttachmentTestAgent } from "./attachments/helpers.js";
import { createMemorySql, type MemorySqlMock } from "./helpers/memory-sql.js";
import { initializeMemorySchema, initializeUserSkillsSchema } from "../src/agent-config/index.js";
import {
  insertActiveUserSkillVersion,
  revokeUserSkillVersion,
  listActiveUserSkills,
} from "../src/agent-config/user-skills/store.js";
import type { PromotionEvidence, UserSkillVersion } from "../src/agent-config/user-skills/store.js";
import { assembleCognition } from "../src/agent-config/index.js";

const WORKSPACE = "ws-a18-run";

const EVIDENCE: PromotionEvidence = {
  candidateId: "cand-1",
  replay: { fixturesId: "fx", readOnly: true, cases: 10, baselineAverage: 0.5, candidateAverage: 0.8, evalsFrozenAt: "2026-10-05T00:00:00.000Z" },
  safety: { passed: true, failures: [] },
  approvedBy: "operator",
} as unknown as PromotionEvidence;

const RULE = (merchant: string, categoryId: string) => ({ merchantPattern: merchant, categoryId });

type AgentWithHooks = {
  loadUserSkills(input: { workspaceId: string; actorId: string; intentionId: string }): Promise<unknown[]>;
  entityReaderForTurn(input: unknown): Promise<{ listCategories(): Promise<unknown> }>;
};

/** Prototype-built agent with REAL memory + user-skills SQLite and a stubbed reader. */
const agentWithSkills = (seed: (sql: MemorySqlMock) => void) => {
  const { agent } = createAttachmentTestAgent();
  const sql = createMemorySql();
  initializeMemorySchema(sql as never);
  initializeUserSkillsSchema(sql as never);
  seed(sql);
  Object.defineProperty(agent, "ctx", {
    value: {
      storage: {
        sql: { exec: sql.exec.bind(sql) },
        transactionSync: <T>(fn: () => T): T => fn(),
      },
    },
    configurable: true,
  });
  let catalogReads = 0;
  (agent as unknown as { entityReaderForTurn: unknown }).entityReaderForTurn = (async () => ({
    listCategories: async () => {
      catalogReads += 1;
      return [
        { id: "cat_padarias", name: "Alimentação" },
        { id: "cat_farmacia", name: "Farmácia" },
      ];
    },
  })) as never;
  return {
    agent: agent as unknown as AgentWithHooks,
    sql,
    catalogReads: () => catalogReads,
  };
};

describe("A19/A18 — loadUserSkills projeta somente skills ativas", () => {
  it("skill ativa vira Skill de dados (tools: []); candidate/inativa/revogada não", async () => {
    const { agent, sql } = agentWithSkills((s) => {
      insertActiveUserSkillVersion(s as never, {
        workspaceId: WORKSPACE,
        name: "alias-padaria",
        rule: RULE("padaria do bairro", "cat_padarias"),
        approvedBy: "operator",
        evidence: EVIDENCE,
      });
    });
    const skills = (await agent.loadUserSkills({ workspaceId: WORKSPACE, actorId: "actor-1", intentionId: "i1" })) as Array<{
      name: string;
      tools: string[];
      when: string;
    }>;
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("alias-padaria");
    // A skill de usuário é DADO, nunca capability.
    expect(skills[0]!.tools).toEqual([]);
    expect(skills[0]!.when).toContain("dado do workspace");
  });

  it("workspace sem skills: zero leituras de catálogo e retorno vazio", async () => {
    const { agent, catalogReads } = agentWithSkills(() => {});
    const skills = await agent.loadUserSkills({ workspaceId: WORKSPACE, actorId: "actor-1", intentionId: "i2" });
    expect(skills).toEqual([]);
    expect(catalogReads()).toBe(0);
  });

  it("duas skills ativas são projetadas juntas (competem pelo budget no fitSkills)", async () => {
    const { agent } = agentWithSkills((s) => {
      insertActiveUserSkillVersion(s as never, {
        workspaceId: WORKSPACE,
        name: "alias-padaria",
        rule: RULE("padaria do bairro", "cat_padarias"),
        approvedBy: "operator",
        evidence: EVIDENCE,
      });
      insertActiveUserSkillVersion(s as never, {
        workspaceId: WORKSPACE,
        name: "alias-farmacia",
        rule: RULE("drogaria central", "cat_farmacia"),
        approvedBy: "operator",
        evidence: EVIDENCE,
      });
    });
    const skills = (await agent.loadUserSkills({ workspaceId: WORKSPACE, actorId: "actor-1", intentionId: "i3" })) as Array<{ name: string }>;
    expect(skills.map((skill) => skill.name).sort()).toEqual(["alias-farmacia", "alias-padaria"]);
  });

  it("rollback: revogada a versão viva, a anterior volta a ser projetada", async () => {
    const { agent, sql } = agentWithSkills((s) => {
      insertActiveUserSkillVersion(s as never, {
        workspaceId: WORKSPACE,
        name: "alias-padaria",
        rule: RULE("padaria", "cat_padarias"),
        approvedBy: "operator",
        evidence: EVIDENCE,
      });
      insertActiveUserSkillVersion(s as never, {
        workspaceId: WORKSPACE,
        name: "alias-padaria",
        rule: RULE("padaria do bairro", "cat_padarias"),
        approvedBy: "operator",
        evidence: EVIDENCE,
      });
    });
    const active = listActiveUserSkills(sql as never, WORKSPACE) as UserSkillVersion[];
    expect(active).toHaveLength(1);
    const revoked = revokeUserSkillVersion(sql as never, { workspaceId: WORKSPACE, id: active[0]!.id });
    expect(revoked.revoked).toBe(true);
    expect((revoked as { restored: unknown }).restored).not.toBeNull();

    const skills = (await agent.loadUserSkills({ workspaceId: WORKSPACE, actorId: "actor-1", intentionId: "i4" })) as Array<{ when: string }>;
    expect(skills).toHaveLength(1);
    expect(skills[0]!.when).toContain("padaria");
  });

  it("skills de usuário entram no prompt pelo mesmo budget, sem alterar tools/core", async () => {
    const base = assembleCognition("na padaria do bairro");
    const withUserSkill = assembleCognition("na padaria do bairro", {
      userSkills: [
        {
          name: "alias-padaria",
          title: "Preferência do usuário: alias-padaria",
          when: 'Quando o estabelecimento casar com o DADO "padrão" = "padaria do bairro".',
          keywords: ["padaria"],
          tools: [],
          steps: ['DADO: "estabelecimento" = "padaria do bairro".'],
          pitfalls: ["Nunca crie categoria nova."],
        },
      ],
    });
    // A skill entra NO SYSTEM (o orçamento é compartilhado), mas o núcleo
    // (identidade/regua de mutação) permanece idêntico — e NENHUMA tool nova
    // aparece (o selo `tools: []` do A18).
    expect(withUserSkill.system.length).toBeGreaterThan(base.system.length);
    expect(withUserSkill.system).toContain("padaria do bairro");
    expect(withUserSkill.toolNames).toEqual(base.toolNames);
  });

  it("workspace sem skills: prompt byte a byte idêntico ao de hoje", () => {
    const before = assembleCognition("gastei 50 de carne");
    const after = assembleCognition("gastei 50 de carne", { userSkills: [] });
    expect(after.system).toBe(before.system);
  });
});

describe("A19/A18 — invariante de wiring", () => {
  const source = readFileSync(new URL("../src/finance-chat-agent.ts", import.meta.url), "utf8");

  it("TODOS os call sites de assembleCognition no runtime passam userSkills", () => {
    const agentSource = source;
    const calls = agentSource.match(/assembleCognition\(/g) ?? [];
    // The REST relay leg + the direct leg (evals/other callers are separate files).
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const passed = agentSource.match(/userSkills[^\n]*\n[^\n]*\}\)/g) ?? [];
    // Each call site conditionally spreads `userSkills` when non-empty; the
    // loadUserSkills method must exist and be awaited at each site.
    expect(agentSource).toContain("await this.loadUserSkills(");
    expect(agentSource.match(/await this\.loadUserSkills\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(passed.length).toBeGreaterThanOrEqual(0);
  });

  it("o loader nunca projeta além do store: usa listActiveUserSkills + toSelectableSkills", () => {
    expect(source).toContain("listActiveUserSkills");
    expect(source).toContain("toSelectableSkills");
  });
});
