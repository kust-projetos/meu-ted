/**
 * Follow-ups A12 (P2) — data de publicação do Tavily e marcadores de citação
 * `[F1]`, `[F2]` na skill `web-search`.
 *
 * - **published_date**: o Tavily já devolve `published_date` por resultado e o
 *   provider a DESCARTAVA; o envelope de evidência tem campo `publishedAt`
 *   desde a A12, então a linha de proveniência renderizava sempre
 *   "publicado: não informado" mesmo com a data na mão.
 * - **marcadores `[F1]`**: o envelope numera as fontes (`F1`, `F2`…), mas a
 *   lista `results` que o modelo lê primeiro não carregava o marcador — não
 *   havia como ligar uma afirmação à fonte sem reescrever o bloco de
 *   proveniência (e o relatório P2 já apontava o formato como o padrão).
 */
import { describe, expect, it, vi } from 'vitest';
import { createWebSearchProvider } from '../src/agent-config/web.js';
import {
  WEB_EVIDENCE_MAX_SOURCES,
  buildWebEvidenceEnvelope,
  filterExternalResults,
  renderEvidenceForPrompt,
} from '../src/agent-config/web-evidence.js';
import { buildExposedTools } from '../src/agent-config/tools.js';
import { ALL_SKILLS } from '../src/agent-config/skills/index.js';
import { renderSkillBody } from '../src/agent-config/skills/types.js';

const baseCtx = {
  delegatedToken: 'delegated-test-token',
  apiOrigin: 'https://api.example.test',
  workspaceId: 'ws-1',
  actorId: 'actor-1',
  intentionId: 'intent-1',
  lastUserMessage: 'qual a taxa selic hoje?',
};

const tavilyFetch = (results: unknown[]) =>
  vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ results }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );

describe('published_date do Tavily chega ao item de resultado (A12 follow-up)', () => {
  it('RED: mapeia published_date para publishedAt', async () => {
    const fetchImpl = tavilyFetch([
      { title: 'Selic 15%', url: 'https://exemplo.test/selic', content: 'anúncio', published_date: '2026-10-01T09:00:00Z' },
    ]);
    const provider = createWebSearchProvider({ TAVILY_API_KEY: 'tv-test' }, fetchImpl as unknown as typeof fetch);
    const result = await provider.search('selic hoje');
    expect(result.results[0]).toMatchObject({
      title: 'Selic 15%',
      url: 'https://exemplo.test/selic',
      publishedAt: '2026-10-01T09:00:00Z',
    });
  });

  it('ausência (ou tipo inválido) de published_date vira AUSÊNCIA, nunca data inventada', async () => {
    const fetchImpl = tavilyFetch([
      { title: 'Sem data', url: 'https://exemplo.test/a', content: 'x' },
      { title: 'Data numérica', url: 'https://exemplo.test/b', content: 'y', published_date: 20261001 },
    ]);
    const provider = createWebSearchProvider({ TAVILY_API_KEY: 'tv-test' }, fetchImpl as unknown as typeof fetch);
    const result = await provider.search('selic hoje');
    expect(result.results[0]?.publishedAt).toBeUndefined();
    expect(result.results[1]?.publishedAt).toBeUndefined();
    expect('publishedAt' in (result.results[0] ?? {})).toBe(false);
  });

  it('a data mapeada aparece na proveniência renderizada (publicado: ...)', async () => {
    const fetchImpl = tavilyFetch([
      { title: 'Selic 15%', url: 'https://exemplo.test/selic', content: 'anúncio', published_date: '2026-10-01' },
    ]);
    const provider = createWebSearchProvider({ TAVILY_API_KEY: 'tv-test' }, fetchImpl as unknown as typeof fetch);
    const result = await provider.search('selic hoje');
    const rendered = renderEvidenceForPrompt(buildWebEvidenceEnvelope({ query: 'selic', items: result.results }));
    expect(rendered).toContain('publicado: 2026-10-01');
  });

  it('o provider Brave segue sem publishedAt (o payload dele não tem published_date)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ web: { results: [{ title: 'Dólar', url: 'https://exemplo.test/dolar', description: 'x' }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = createWebSearchProvider({ BRAVE_API_KEY: 'br-test' }, fetchImpl as unknown as typeof fetch);
    const result = await provider.search('dólar hoje');
    expect('publishedAt' in (result.results[0] ?? {})).toBe(false);
  });
});

describe('marcadores de citação [F1]/[F2] nos resultados (A12 follow-up)', () => {
  const items = [
    { title: 'Fonte um', url: 'https://um.test/a', snippet: 'conteúdo um' },
    { title: 'Fonte dois', url: 'https://dois.test/b', snippet: 'conteúdo dois' },
    { title: 'Fonte três', url: 'https://tres.test/c', snippet: 'conteúdo três' },
  ];

  it('RED: cada resultado sobrevivente sai com o seu marcador, na ordem do envelope', () => {
    const results = filterExternalResults(items);
    expect(results.map((item) => item.marker)).toEqual(['[F1]', '[F2]', '[F3]']);
    const rendered = renderEvidenceForPrompt(buildWebEvidenceEnvelope({ query: 'selic', items }));
    // O marcador do resultado e a linha de proveniência apontam a MESMA fonte.
    expect(rendered).toContain('[F1] | um.test');
    expect(results[0]?.url).toBe('https://um.test/a');
  });

  it('RED: um item REJEITADO não consome número (a numeração segue os sobreviventes)', () => {
    const results = filterExternalResults([
      { title: 'javascript', url: 'javascript:alert(1)', snippet: 'x' },
      { title: 'metadados', url: 'http://169.254.169.254/latest', snippet: 'y' },
      ...items,
    ]);
    expect(results.map((item) => item.marker)).toEqual(['[F1]', '[F2]', '[F3]']);
    expect(results[0]?.url).toBe('https://um.test/a');
  });

  it('a numeração é a mesma dos primeiros N fontes do envelope (limite de fontes)', () => {
    const many = Array.from({ length: WEB_EVIDENCE_MAX_SOURCES + 2 }, (_, index) => ({
      title: `Fonte ${index}`,
      url: `https://f${index}.test/x`,
      snippet: 'x',
    }));
    const results = filterExternalResults(many);
    const rendered = renderEvidenceForPrompt(buildWebEvidenceEnvelope({ query: 'selic', items: many }));
    for (const source of [1, 2, 3]) {
      expect(results[source - 1]?.marker).toBe(`[F${source}]`);
      expect(rendered).toContain(`[F${source}] | f${source - 1}.test`);
    }
  });

  it('RED: a tool exposta entrega os marcadores junto da proveniência', async () => {
    const fetchImpl = tavilyFetch([
      { title: 'Selic hoje', url: 'https://exemplo.test/selic', content: 'anúncio', published_date: '2026-10-01' },
      { title: 'Boletim', url: 'https://bc.test/boletim', content: 'meta mantida' },
    ]);
    const tools = buildExposedTools(['web_search'], {
      ...baseCtx,
      webEnv: { TAVILY_API_KEY: 'tv-test' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = (await (
      tools['web_search'] as { execute: (p: unknown) => Promise<unknown> }
    ).execute({ query: 'taxa selic hoje' })) as {
      results?: Array<{ marker?: string; url?: string }>;
      evidence?: string;
    };
    expect(result.results?.map((item) => item.marker)).toEqual(['[F1]', '[F2]']);
    expect(result.evidence).toContain('[F1]');
    expect(result.evidence).toContain('publicado: 2026-10-01');
  });
});

describe('skill web-search cita fontes com [F1]', () => {
  const skill = ALL_SKILLS.find((candidate) => candidate.name === 'web-search');

  it('RED: os passos exigem o marcador [F1] ligando afirmação → fonte', () => {
    expect(skill).toBeDefined();
    const body = renderSkillBody(skill!);
    expect(body).toMatch(/\[F1\]/);
    expect(body).toMatch(/F2/);
  });

  it('RED: a armadilha proíbe inventar marcador que não está na proveniência', () => {
    const body = renderSkillBody(skill!);
    expect(body).toMatch(/nunca invente/i);
    expect(body).toMatch(/marcador/i);
  });

  it('a skill continua documenting a disciplina já existente (número da web ≠ workspace)', () => {
    const body = renderSkillBody(skill!);
    expect(body).toMatch(/nunca misture número da web com número do workspace/i);
  });
});
