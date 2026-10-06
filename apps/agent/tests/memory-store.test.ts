import { describe, expect, it, beforeEach } from 'vitest';
import {
  initializeMemorySchema,
  isMemoryEnabled,
  setMemoryEnabled,
  rememberFact,
  recallMemories,
  renderMemoryBlock,
  containsCardNumber,
  textSimilarity,
  bumpTurnCount,
  forgetMemory,
  isCurrentFinancialState,
  listForgetCandidates,
  selectRelevantForgetCandidates,
  FORGET_QUERY_STOP_TOKENS,
  type MemoryItem,
  type MemoryScope,
} from '../src/agent-config/memory/store.js';
import { createMemorySql, type MemorySqlMock } from './helpers/memory-sql.js';

type Row = Record<string, unknown>;

const createSql = () => {
  const tables = new Map<string, Row[]>();
  const sql = {
    tables,
    exec<T = Row>(query: string, ...bindings: unknown[]): Iterable<T> {
      const q = query.trim().replace(/\s+/g, ' ');
      if (q.startsWith('CREATE TABLE')) {
        const name = q.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1] ?? 'unknown';
        if (!tables.has(name)) tables.set(name, []);
        return [] as T[];
      }
      if (q.startsWith('CREATE INDEX')) return [] as T[];
      if (q.startsWith('INSERT INTO agent_memory')) {
        const [id, workspaceId, actor, kind, content, salience, createdAt, lastSeenAt, expiresAt] = bindings;
        tables.get('agent_memory')!.push({
          id, workspace_id: workspaceId, actor, kind, content, salience,
          created_at: createdAt, last_seen_at: lastSeenAt, expires_at: expiresAt,
        });
        return [] as T[];
      }
      if (q.startsWith('INSERT INTO agent_prefs')) {
        const [workspaceId, enabled, updatedAt] = bindings;
        const rows = tables.get('agent_prefs')!;
        const existing = rows.find((r) => r['workspace_id'] === workspaceId);
        if (existing) {
          existing['memory_enabled'] = enabled;
          existing['updated_at'] = updatedAt;
        } else {
          rows.push({ workspace_id: workspaceId, memory_enabled: enabled, updated_at: updatedAt });
        }
        return [] as T[];
      }
      if (q.startsWith('INSERT INTO agent_turn_counters')) {
        const [workspaceId] = bindings;
        const rows = tables.get('agent_turn_counters')!;
        const existing = rows.find((r) => r['workspace_id'] === workspaceId);
        if (existing) existing['turns'] = Number(existing['turns']) + 1;
        else rows.push({ workspace_id: workspaceId, turns: 1 });
        return [] as T[];
      }
      if (q.startsWith('SELECT memory_enabled')) {
        const rows = tables.get('agent_prefs')!.filter((r) => r['workspace_id'] === bindings[0]);
        return rows as T[];
      }
      if (q.startsWith('SELECT turns')) {
        const rows = tables.get('agent_turn_counters')!.filter((r) => r['workspace_id'] === bindings[0]);
        return rows as T[];
      }
      if (q.startsWith('SELECT * FROM agent_memory')) {
        const [workspaceId] = bindings;
        return tables.get('agent_memory')!.filter((r) => r['workspace_id'] === workspaceId) as T[];
      }
      if (q.startsWith('UPDATE agent_memory SET salience')) {
        const [salience, lastSeenAt, id] = bindings;
        const row = tables.get('agent_memory')!.find((r) => r['id'] === id);
        if (row) {
          row['salience'] = salience;
          row['last_seen_at'] = lastSeenAt;
        }
        return [] as T[];
      }
      if (q.startsWith('UPDATE agent_memory SET last_seen_at')) {
        const [lastSeenAt, id] = bindings;
        const row = tables.get('agent_memory')!.find((r) => r['id'] === id);
        if (row) row['last_seen_at'] = lastSeenAt;
        return [] as T[];
      }
      throw new Error(`unhandled query in mock: ${q.slice(0, 80)}`);
    },
  };
  initializeMemorySchema(sql);
  return sql;
};

describe('memory store (Part B)', () => {
  let sql: ReturnType<typeof createSql>;
  beforeEach(() => {
    sql = createSql();
  });

  it('remembers and recalls a fact scoped by workspace and actor', () => {
    const saved = rememberFact(sql, { workspaceId: 'ws-1', actor: 'u-1', kind: 'fact', content: 'Conta principal é o Nubank' });
    expect(saved.stored).toBe(true);
    const found = recallMemories(sql, { workspaceId: 'ws-1', actor: 'u-1', query: 'conta principal' });
    expect(found).toHaveLength(1);
    expect(found[0]!.content).toContain('Nubank');
    // Other workspace sees nothing; other actor sees nothing.
    expect(recallMemories(sql, { workspaceId: 'ws-2', actor: 'u-1', query: 'conta' })).toHaveLength(0);
    expect(recallMemories(sql, { workspaceId: 'ws-1', actor: 'u-2', query: 'conta' })).toHaveLength(0);
  });

  it('dedups similar content with a salience bump instead of a new row', () => {
    rememberFact(sql, { workspaceId: 'ws-1', actor: 'u-1', content: 'Prefiro resumos curtos no chat' });
    const second = rememberFact(sql, { workspaceId: 'ws-1', actor: 'u-1', content: 'Prefiro resumos curtos' });
    expect(second.stored).toBe(true);
    if (second.stored) expect(second.deduped).toBe(true);
    expect(sql.tables.get('agent_memory')).toHaveLength(1);
  });

  it('refuses card numbers and redacts secrets', () => {
    const card = rememberFact(sql, { workspaceId: 'ws-1', actor: 'u-1', content: 'meu cartão é 4111 1111 1111 1111' });
    expect(card).toMatchObject({ stored: false, reason: 'card_number' });
    expect(containsCardNumber('4111111111111111')).toBe(true);
    const secret = rememberFact(sql, { workspaceId: 'ws-1', actor: 'u-1', content: 'token abc password: hunter2' });
    expect(secret.stored).toBe(true);
    if (secret.stored) expect(secret.item.content).not.toContain('hunter2');
  });

  it('respects the per-workspace opt-out (default ON)', () => {
    expect(isMemoryEnabled(sql, 'ws-1')).toBe(true);
    setMemoryEnabled(sql, 'ws-1', false);
    expect(isMemoryEnabled(sql, 'ws-1')).toBe(false);
    rememberFact(sql, { workspaceId: 'ws-1', actor: 'u-1', content: 'algo' });
    // Recall is gated even with rows present.
    expect(recallMemories(sql, { workspaceId: 'ws-1', actor: 'u-1' })).toHaveLength(0);
  });

  it('ranks by keyword overlap and respects the char budget', () => {
    rememberFact(sql, { workspaceId: 'ws-1', actor: 'u-1', content: 'Meta de viagem para o Japão em dezembro', salience: 0.5 });
    rememberFact(sql, { workspaceId: 'ws-1', actor: 'u-1', content: 'Conta de luz vence dia dez', salience: 0.9 });
    const found = recallMemories(sql, { workspaceId: 'ws-1', actor: 'u-1', query: 'viagem Japão', limit: 5 });
    expect(found[0]!.content).toContain('Japão');
    const budgeted = recallMemories(sql, { workspaceId: 'ws-1', actor: 'u-1', budgetChars: 10 });
    // Tiny budget still returns the single best hit (never empty when rows exist).
    expect(budgeted).toHaveLength(1);
    expect(renderMemoryBlock([])).toBeNull();
  });

  it('renders the MEMÓRIA DO USUÁRIO block', () => {
    rememberFact(sql, { workspaceId: 'ws-1', actor: 'u-1', content: 'Usa Nubank' });
    const items = recallMemories(sql, { workspaceId: 'ws-1', actor: 'u-1' });
    expect(renderMemoryBlock(items)).toContain('- Usa Nubank');
  });

  it('bumps a monotonic turn counter per workspace', () => {
    expect(bumpTurnCount(sql, 'ws-1')).toBe(1);
    expect(bumpTurnCount(sql, 'ws-1')).toBe(2);
    expect(bumpTurnCount(sql, 'ws-2')).toBe(1);
  });

  it('measures text similarity sanely', () => {
    expect(textSimilarity('prefiro resumos curtos', 'prefiro resumos curtos')).toBe(1);
    expect(textSimilarity('nubank conta principal', 'itau conta reserva')).toBeLessThan(0.55);
  });
});

/**
 * Relevance gate for the DESTRUCTIVE forget path (A19 post-merge closure).
 *
 * Recall is a CONTEXT ranking — it happily returns items that share nothing
 * with the query, because salience × recency alone is a valid score. Ranking
 * may produce candidates; it may never authorize a deletion. These cases pin
 * the deterministic, LLM-free rule that decides what is a plausible target.
 */
describe('selectRelevantForgetCandidates (o ranking nunca decide o que é apagado)', () => {
  let sql: ReturnType<typeof createSql>;
  beforeEach(() => {
    sql = createSql();
  });

  /** Real candidates through the real recall, so ordering/content are honest. */
  const candidatesFrom = (contents: string[]): MemoryItem[] => {
    contents.forEach((content, index) => {
      rememberFact(sql, { workspaceId: 'ws-1', actor: 'u-1', content, salience: 0.9 - index * 0.05 });
    });
    return recallMemories(sql, { workspaceId: 'ws-1', actor: 'u-1', limit: 10 });
  };

  const contentsOf = (items: MemoryItem[]): string[] => items.map((item) => item.content);

  it('case e acento não criam nem escondem o alvo óbvio', () => {
    const candidates = candidatesFrom(['Prefere usar Nubank', 'Prefere categoria Alimentação']);
    expect(contentsOf(selectRelevantForgetCandidates(candidates, 'esqueça nubank'))).toEqual([
      'Prefere usar Nubank',
    ]);
    expect(contentsOf(selectRelevantForgetCandidates(candidates, 'ESQUEÇA NUBANK'))).toEqual([
      'Prefere usar Nubank',
    ]);
  });

  it('discriminante autoriza: preferencia é genérico, nubank decide o alvo', () => {
    const candidates = candidatesFrom(['Prefere usar Nubank', 'Usa o cartão de crédito']);
    // Discriminators of "esqueça a preferência do Nubank" = {nubank}
    // ("preferencia" is structural/generic). The candidate containing the
    // discriminative token is the target; noise without it is discarded.
    expect(contentsOf(selectRelevantForgetCandidates(candidates, 'esqueça a preferência do Nubank'))).toEqual([
      'Prefere usar Nubank',
    ]);
  });

  it('ruído temporal não desqualifica: discriminante presente autoriza o alvo', () => {
    const candidates = candidatesFrom(['Prefere usar Nubank']);
    // Old coverage policy rejected this correct target (1/3 < 0.5) — the
    // mirror of the #96 bug. Under the discriminant policy, "nubank" is
    // discriminative and temporal noise ("amanha", "cedo") never disqualifies.
    expect(contentsOf(selectRelevantForgetCandidates(candidates, 'esqueça Nubank amanhã cedo'))).toEqual([
      'Prefere usar Nubank',
    ]);
  });

  it('termo estrutural sozinho nunca autoriza: "esqueça banco" devolve []', () => {
    // Distinct enough not to collide in `rememberFact` similarity dedup
    // (0.55), but united by the structural term "banco" — which names the
    // domain category, never the target, so it authorizes nothing.
    const candidates = candidatesFrom([
      'Usa o banco do Brasil para a conta corrente',
      'Prefere o banco Inter no dia do pagamento',
    ]);
    expect(candidates).toHaveLength(2);
    expect(selectRelevantForgetCandidates(candidates, 'esqueça banco')).toEqual([]);
  });

  it('query só com stopwords não tem assunto: nenhum alvo provável', () => {
    const candidates = candidatesFrom(['Prefere usar Nubank']);
    expect(selectRelevantForgetCandidates(candidates, 'esqueça isso')).toEqual([]);
    expect(FORGET_QUERY_STOP_TOKENS.has('esqueca')).toBe(true);
    expect(FORGET_QUERY_STOP_TOKENS.has('isso')).toBe(true);
    // O imperativo normalizado ("esqueca") é stopword; o assunto (" Nubank") não.
    expect(FORGET_QUERY_STOP_TOKENS.has('nubank')).toBe(false);
  });

  it('query sem nenhum token aproveitável (vazia ou só scraps) é recusada', () => {
    const candidates = candidatesFrom(['Prefere usar Nubank']);
    expect(selectRelevantForgetCandidates(candidates, '')).toEqual([]);
    expect(selectRelevantForgetCandidates(candidates, '   ')).toEqual([]);
    expect(selectRelevantForgetCandidates(candidates, 'a de o em um')).toEqual([]);
  });
});

/**
 * Definitive closure (#96): only a DISCRIMINATIVE match authorizes forgetting.
 *
 * "Ranking does not authorize; generic coverage does not authorize; only a
 * discriminative match authorizes deletion." Structural/generic tokens name
 * the domain category or possession — never the target — so a candidate is
 * forgettable only if it contains at least one discriminative query token.
 */
describe('selectRelevantForgetCandidates (só correspondência discriminante autoriza)', () => {
  let sql: ReturnType<typeof createSql>;
  beforeEach(() => {
    sql = createSql();
  });

  /** Real candidates through the real recall, so ordering/content are honest. */
  const candidatesFrom = (contents: string[]): MemoryItem[] => {
    contents.forEach((content, index) => {
      rememberFact(sql, { workspaceId: 'ws-1', actor: 'u-1', content, salience: 0.9 - index * 0.05 });
    });
    return recallMemories(sql, { workspaceId: 'ws-1', actor: 'u-1', limit: 10 });
  };

  const contentsOf = (items: MemoryItem[]): string[] => items.map((item) => item.content);

  it('Caso A (o bug): genéricos não elegem o alvo errado, o discriminante elege o certo', () => {
    const candidates = candidatesFrom(['Prefere usar Nubank', 'Minha conta favorita é Banco do Brasil']);
    expect(candidates).toHaveLength(2);
    // "minha/preferencia/banco" are generic; only "nubank" discriminates.
    expect(
      contentsOf(selectRelevantForgetCandidates(candidates, 'esqueça minha preferência do banco Nubank')),
    ).toEqual(['Prefere usar Nubank']);
  });

  it('Caso B: conta/preferência genéricas nunca elegem Banco do Brasil', () => {
    const candidates = candidatesFrom(['Prefere usar Nubank', 'Minha conta principal é Banco do Brasil']);
    expect(candidates).toHaveLength(2);
    expect(
      contentsOf(selectRelevantForgetCandidates(candidates, 'remova minha conta/preferência do banco Nubank')),
    ).toEqual(['Prefere usar Nubank']);
  });

  it('Caso C: query sem discriminante autoriza NADA (falha conservadora)', () => {
    const candidates = candidatesFrom(['Prefere usar Nubank', 'Prefere o Itaú']);
    // Similarity-dedup check first: {prefere} / max(3, 2) = 0.33 < 0.55,
    // so both memories are stored and the [] below is the gate, not the dedup.
    expect(candidates).toHaveLength(2);
    expect(selectRelevantForgetCandidates(candidates, 'esqueça minha preferência de banco')).toEqual([]);
  });

  it('Caso E: discriminante ausente do candidato autoriza NADA', () => {
    const candidates = candidatesFrom(['Prefere usar Nubank']);
    // Discriminator is {inter}; the Nubank memory does not contain it.
    expect(selectRelevantForgetCandidates(candidates, 'esqueça Banco Inter')).toEqual([]);
  });

  it('Caso F: "principal" genérico não ajuda o candidato errado', () => {
    const candidates = candidatesFrom(['Banco principal é Nubank', 'Categoria principal é Alimentação']);
    expect(candidates).toHaveLength(2);
    expect(
      contentsOf(
        selectRelevantForgetCandidates(candidates, 'esqueça minha principal preferência de banco Nubank'),
      ),
    ).toEqual(['Banco principal é Nubank']);
  });

  it('marca curta descartada pelo tokenizer é conservadora: "esqueça XP" devolve []', () => {
    // Known residual: `normalizeTokens` drops tokens ≤ 2 chars, so "xp"
    // never becomes a discriminator. Failing closed (ask for specifics)
    // instead of deleting by generic coverage.
    const candidates = candidatesFrom(['Prefere usar Nubank']);
    expect(selectRelevantForgetCandidates(candidates, 'esqueça XP')).toEqual([]);
  });

  it('deítico/negação/família de lembrar não viram discriminantes: "não lembre mais disso" não apaga nada', () => {
    // "nao"/"lembre"/"mais"/"disso" are all function/command tokens; the
    // memory whose content STARTS with "Não" must never be picked by it.
    const candidates = candidatesFrom(['Não gosta de café']);
    expect(selectRelevantForgetCandidates(candidates, 'não lembre mais disso')).toEqual([]);
  });

  /**
   * Review #96 round 2 (P1): "discriminative = not listed" leaked FUNCTION
   * words into authorization. Politeness ("por"), connectives ("mais") and
   * the remember/forget verb family infest ANY content, so they must never
   * authorize a deletion. Pinned by the literal traps the reviewer found.
   */
  it('cortesia não vira discriminante: "…do banco Nu, por favor" não apaga a memória com "por"', () => {
    // "nu" (2 chars) is dropped; "por" is a function word; discriminators = {}.
    const candidates = candidatesFrom(['Prefere usar Nu', 'Prefere pagar por Pix']);
    expect(candidates).toHaveLength(2);
    expect(selectRelevantForgetCandidates(candidates, 'esqueça minha preferência do banco Nu, por favor')).toEqual([]);
  });

  /**
   * Review #96 round 2b (re-review): the function-word class must cover the
   * pt-BR stopword standard (contractions, pronouns, modals, frozen
   * locutions). Each row is a literal reviewer reproduction: the function
   * token appears in an unrelated memory's content and must never authorize.
   */
  it('stopwords padrão (contrações/pronomes/modais) não autorizam exclusão nenhuma', () => {
    const candidates = candidatesFrom([
      'Prefere caminhar pela manhã',
      'Prefere pagar pra receber desconto',
      'Quer que TED responda curto',
      'Quero viajar nas férias',
      'Pode usar Nubank para compras',
      'Não gosta de nada doce',
      'Gosta das cores do aplicativo',
    ]);
    expect(candidates).toHaveLength(7);
    for (const query of [
      'esqueça minha preferência pela conta Nu', // pela
      'esqueça minha conta Nu pra mim', // pra, mim
      'esqueça tudo que sabe', // que
      'quero esquecer isso', // quero
      'pode esquecer isso', // pode
      'não lembre nada', // nada
      'esqueça minha preferência das contas', // das
    ]) {
      expect(selectRelevantForgetCandidates(candidates, query)).toEqual([]);
    }
  });

  /**
   * Review #96 round 3 (re-review 2b): the function-word class must also
   * cover locutions ("acerca de", "além de", "por causa de", "a propósito"),
   * inclusive-frame adverbs, volition modals and interjections. Literal
   * reviewer reproductions — each token appears in an unrelated memory's
   * content and must never authorize.
   */
  it('locuções congeladas, advérbios de moldura, modais e interjeições não autorizam exclusão', () => {
    const candidates = candidatesFrom([
      'Gosta de conversar acerca de viagens',
      'Usa Pix inclusive aos domingos',
      'Prefere viajar além do Brasil',
      'Evita café por causa da insônia',
      'Busca propósito no trabalho',
      'Podemos dividir despesas da casa',
      'Gostaria de viajar nas férias',
      'Costuma dizer hmm quando pensa',
    ]);
    expect(candidates).toHaveLength(8);
    for (const query of [
      'esqueça minha preferência acerca da conta Nu', // acerca
      'inclusive esqueça isso', // inclusive
      'esqueça minha conta Nu além disso', // alem
      'esqueça minha conta Nu por causa disso', // causa
      'a propósito esqueça isso', // proposito
      'podemos esquecer isso', // podemos
      'gostaria de esquecer isso', // gostaria
      'hmm esqueça isso', // hmm
    ]) {
      expect(selectRelevantForgetCandidates(candidates, query)).toEqual([]);
    }
  });

  /**
   * Review #96 round 3 (APPROVED with non-blocking hardening): the literal
   * terms the reviewer tested beyond the list — discourse adverbs, frozen
   * comparatives and acknowledgements — pinned so each is a proven fix, not
   * an open trap.
   */
  it('advérbios de discurso e reconhecimentos de moldura não autorizam exclusão', () => {
    const candidates = candidatesFrom([
      'Prefere Pix aliás evita cartões',
      'Viaja conforme o calendário da família',
      'Comenta através do aplicativo',
      'Diz enfim que quer poupar',
      'Pergunta afinal sobre o saldo',
      'Responde obviamente nas conversas',
      'Confirma certamente os lançamentos',
      'Costuma dizer entendido nas conversas',
    ]);
    expect(candidates).toHaveLength(8);
    for (const query of [
      'aliás esqueça isso', // alias
      'esqueça conforme a conta Nu', // conforme
      'através disso esqueça', // atraves
      'enfim esqueça isso', // enfim
      'afinal esqueça isso', // afinal
      'obviamente esqueça isso', // obviamente
      'certamente esqueça isso', // certamente
      'entendido, esqueça isso', // entendido
    ]) {
      expect(selectRelevantForgetCandidates(candidates, query)).toEqual([]);
    }
  });

  it('termo estrutural não listado: alvo único AUTO-DESCRITO é esquecível (decisão fixada)', () => {
    // "instituicao"/"financeira" are domain structure missing from the list:
    // the candidate whose content literally uses the term is the single
    // self-describing match, and the user asked to forget exactly that term.
    // Planner decision (issue #96 round 2): acceptable — over-listing domain
    // vocabulary is unbounded; a query the content does not use authorizes
    // nothing (conservative), and multiple self-described matches stay
    // ambiguous.
    const candidates = candidatesFrom(['Prefere Nubank como instituição financeira']);
    expect(
      contentsOf(selectRelevantForgetCandidates(candidates, 'esqueça minha instituição financeira')),
    ).toEqual(['Prefere Nubank como instituição financeira']);
  });
});

/**
 * Regression P1-1 (review round 2): a RESOLUÇÃO destrutiva não pode herdar o
 * corte do recall.
 *
 * `recallMemories` é ranqueamento de CONTEXTO: limita a 5 (`limit`), ordena por
 * score e ainda faz bookkeeping (`last_seen_at`). Para escolher o que apagar,
 * nenhuma das duas coisas serve: a unicidade que autoriza o esquecimento precisa
 * ser provada sobre TODAS as memórias visíveis no escopo, e um SELECT que
 * resolve candidatos não é um recall.
 *
 * `listForgetCandidates` é, por isso, o MESMO filtro de visibilidade do recall
 * (workspace + expiração + invalidação + ator/shared + current-financial-state)
 * sem score, sem sort, sem limite, sem budget e sem o UPDATE de bookkeeping.
 * Estes casos usam o interpretador de schema real (`createMemorySql`) porque a
 * visibilidade completa — expires_at, invalidated_at e o log de SQL — é
 * justamente o que o mock de linha deste arquivo não representa.
 */
describe('listForgetCandidates (visibilidade sem truncamento)', () => {
  const NEW_STORE = () => {
    const store = createMemorySql();
    initializeMemorySchema(store);
    return store;
  };

  /** Row cru: representa uma linha que o writer hoje não criaria (defesa). */
  const insertRaw = (store: MemorySqlMock, row: Record<string, unknown>): void => {
    store.rows('agent_memory').push({
      source: 'user',
      confidence: 0.5,
      fingerprint: null,
      provenance: '{}',
      catalog_references: '[]',
      invalidated_at: null,
      expires_at: null,
      kind: 'fact',
      salience: 0.5,
      ...row,
    });
  };

  const contentsOf = (items: MemoryItem[]): string[] => items.map((item) => item.content);
  const AT = { workspaceId: 'ws-1', actor: 'u-1' };

  it('sem opt-out: devolve o escopo inteiro, sem score nem limite (6+ linhas)', () => {
    const store = NEW_STORE();
    for (const content of [
      'Prefere registrar as despesas no Nubank',
      'Quer que eu pare de citar o Nubank por aqui',
      'Abre o aplicativo do banco pela manhã',
      'Gosta de caminhar no parque aos domingos',
      'Usa caneca térmica no trabalho',
      'Prefere assistir filmes em casa no fim de semana',
    ]) {
      rememberFact(store, { workspaceId: 'ws-1', actor: 'u-1', content });
    }
    // O recall de contexto trunca em 5 (limit padrão); a resolução destrutiva
    // NÃO pode herdar esse corte.
    expect(recallMemories(store, { ...AT, query: 'Nubank' })).toHaveLength(5);
    expect(listForgetCandidates(store, AT)).toHaveLength(6);
  });

  it('opt-out do workspace: nenhum candidato (o forget não é caminho de contorno)', () => {
    // O interpretador de schema não lê `agent_prefs`; o mock de linha deste
    // arquivo é o que suporta o SELECT de opt-out — mesmo store, mesmo contrato.
    const store = createSql();
    rememberFact(store, { workspaceId: 'ws-1', actor: 'u-1', content: 'Prefere usar Nubank' });
    expect(isMemoryEnabled(store, 'ws-1')).toBe(true);
    expect(listForgetCandidates(store, AT)).toHaveLength(1);
    setMemoryEnabled(store, 'ws-1', false);
    expect(isMemoryEnabled(store, 'ws-1')).toBe(false);
    expect(listForgetCandidates(store, AT)).toEqual([]);
  });

  it('camada shared: visível por default, ausente quando o escopo a exclui', () => {
    const store = NEW_STORE();
    rememberFact(store, { workspaceId: 'ws-1', actor: 'u-1', content: 'Prefere usar Nubank' });
    rememberFact(store, { workspaceId: 'ws-1', actor: '', content: 'A casa usa conta de luz compartilhada' });
    // Sem escopo explícito, o default do recall (shared incluído) vale.
    expect(contentsOf(listForgetCandidates(store, AT))).toHaveLength(2);
    const actorOnly: MemoryScope = {
      workspaceId: 'ws-1',
      actor: 'u-1',
      layer: 'actor',
      includeShared: false,
    };
    expect(contentsOf(listForgetCandidates(store, { ...AT, scope: actorOnly }))).toEqual([
      'Prefere usar Nubank',
    ]);
    const withShared: MemoryScope = { ...actorOnly, layer: 'shared', includeShared: true };
    expect(listForgetCandidates(store, { ...AT, scope: withShared })).toHaveLength(2);
  });

  it('privada de outro ator e de outro workspace: fora (sem oráculo de existência)', () => {
    const store = NEW_STORE();
    rememberFact(store, { workspaceId: 'ws-1', actor: 'u-2', content: 'Segredo privado do ator 2' });
    rememberFact(store, { workspaceId: 'ws-2', actor: 'u-1', content: 'Prefere o banco Santander' });
    expect(listForgetCandidates(store, AT)).toEqual([]);
  });

  it('invalidada (esquecida) e expirada: fora do alcance', () => {
    const store = NEW_STORE();
    const kept = rememberFact(store, { workspaceId: 'ws-1', actor: 'u-1', content: 'Prefere usar Nubank' });
    const gone = rememberFact(store, { workspaceId: 'ws-1', actor: 'u-1', content: 'Quer parar de citar o Nubank' });
    const expired = rememberFact(store, {
      workspaceId: 'ws-1',
      actor: 'u-1',
      content: 'Usa a caneca térmica da vovó',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    // Controle: a MESMA memória com expiração no futuro continua alcançável —
    // o que some é o timestamp, não o conteúdo nem o ator.
    const live = rememberFact(store, {
      workspaceId: 'ws-1',
      actor: 'u-1',
      content: 'Gosta de café coado à tarde',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    if (!gone.stored || !kept.stored || !expired.stored || !live.stored) throw new Error('fixture falhou');
    forgetMemory(store, { workspaceId: 'ws-1', id: gone.item.id });
    expect(contentsOf(listForgetCandidates(store, AT)).sort()).toEqual(
      ['Gosta de café coado à tarde', 'Prefere usar Nubank'].sort(),
    );
    // A expirada e a esquecida não estão no resultado, e as duas linhas seguem
    // no banco (o filtro é de VISIBILIDADE, nunca de remoção).
    const contents = store.rows('agent_memory').map((row) => row['content']);
    expect(contents).toHaveLength(4);
    expect(contents).toContain('Usa a caneca térmica da vovó');
  });

  it('current financial state: fora, igual ao recall (o esquecível é o visível)', () => {
    const store = NEW_STORE();
    rememberFact(store, { workspaceId: 'ws-1', actor: 'u-1', content: 'Prefere usar Nubank' });
    insertRaw(store, {
      id: 'raw-financial-state',
      workspace_id: 'ws-1',
      actor: 'u-1',
      content: 'O saldo da conta Nubank hoje está baixo',
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    });
    expect(isCurrentFinancialState('O saldo da conta Nubank hoje está baixo')).toBe(true);
    expect(contentsOf(listForgetCandidates(store, AT))).toEqual(['Prefere usar Nubank']);
    // Mesma visibilidade: o recall de contexto também não a devolve.
    expect(recallMemories(store, { ...AT, query: 'Nubank' }).map((item) => item.content)).toEqual([
      'Prefere usar Nubank',
    ]);
  });

  it('NÃO é recall: nenhum UPDATE de bookkeeping (last_seen_at fica intacto)', () => {
    const store = NEW_STORE();
    rememberFact(store, { workspaceId: 'ws-1', actor: 'u-1', content: 'Prefere usar Nubank' });
    const before = store.rows('agent_memory').map((row) => row['last_seen_at']);
    listForgetCandidates(store, AT);
    expect(store.queries.some((query) => query.startsWith('UPDATE agent_memory SET last_seen_at'))).toBe(false);
    expect(store.rows('agent_memory').map((row) => row['last_seen_at'])).toEqual(before);
    // Prova de que a asserção acima tem força: o recall de contexto FAZ esse
    // UPDATE — é exatamente o bookkeeping que a resolução destrutiva não herda.
    store.queries.length = 0;
    recallMemories(store, { ...AT, query: 'Nubank' });
    expect(store.queries.some((query) => query.startsWith('UPDATE agent_memory SET last_seen_at'))).toBe(true);
  });
});
