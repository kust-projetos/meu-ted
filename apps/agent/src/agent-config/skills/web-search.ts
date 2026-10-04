import type { Skill } from './types.js';

export const webSearchSkill: Skill = {
  name: 'web-search',
  title: 'Busca na web',
  when: 'a resposta exige informação externa atual (taxas, índices, notícias, preços)',
  keywords: [
    'internet', 'google', 'pesquisar', 'busque', 'busca', 'atual', 'hoje',
    'cotação', 'cotacao', 'dólar', 'dolar', 'selic', 'ipca', 'notícia', 'noticia',
    'taxa', 'juros de mercado', 'site', 'link',
  ],
  tools: ['web_search', 'web_fetch'],
  steps: [
    'Use web_search para dados externos e atuais; dados do workspace sempre vêm das tools financeiras, nunca da web.',
    'Se a busca estiver indisponível, diga isso de forma elegante e ofereça o que dá para responder com os dados internos.',
    'Cada resultado vem numerado ([F1], [F2]...) e o bloco "EVIDÊNCIA WEB" traz a mesma numeração com host, data e trecho: cite a afirmação com o marcador da fonte ([F1]) logo depois dela.',
    'Cite a fonte de forma curta (nome do site, com o marcador) e desconfie de um único resultado para números críticos.',
    'Para ler uma página específica, use web_fetch com a URL completa.',
  ],
  pitfalls: [
    'Nunca misture número da web com número do workspace sem deixar claro qual é qual.',
    'Não afirme cotação ou taxa sem uma busca bem-sucedida na mesma conversa.',
    'Nunca invente marcador de fonte ([F9]) nem use um número que não esteja na proveniência: sem fonte numerada, diga que não deu para verificar.',
  ],
};
