import { foldEntityName, type EntitySummary } from './entity-resolver.js';

export const CATEGORY_DEACTIVATE_TOOL = 'categories.deactivate' as const;
const VERBS = ['parar de usar', 'pare de usar', 'para de usar', 'desativar', 'desative', 'desativa', 'desativem', 'inativar', 'inative', 'inativa'];
const CATEGORY_NOUN = /\b(categoria|categorias|subcategoria|subcategorias)\b/i;
const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const verbRe = new RegExp(`\\b(?:${VERBS.map(escapeRe).join('|')})\\b`, 'i');
const fold = (value: string): string => foldEntityName(value).toLowerCase();

const isNegated = (text: string): boolean =>
  new RegExp(`\\b(n[aã]o|nunca|jamais|nem)\\s+(?:(?:quero|pode|podem|vai|vou)\\s+)?(?:${VERBS.join('|')})\\b`, 'i').test(text);

/** Explicit category deactivation only; deletion and account objects never match. */
export const hasCategoryDeactivateSignal = (text: string): boolean => {
  const value = (text ?? '').trim();
  if (!value || isNegated(value) || !CATEGORY_NOUN.test(value) || !verbRe.test(value)) return false;
  const afterVerb = value.slice((verbRe.exec(value)?.index ?? 0) + (verbRe.exec(value)?.[0].length ?? 0));
  const rest = afterVerb.replace(/^\s*(?:(?:a|as|o|os|uma|umas|um|uns|minha|minhas|minhas|minhas|meu|meus)\s+)*/i, '');
  const firstNoun = /\b([a-zá-ú]+)/i.exec(rest)?.[1]?.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (firstNoun && /^(?:conta|contas|cartao|cartoes|boleto|fatura|orcamento|meta|assinatura)$/.test(firstNoun)) return false;
  if (/\b(exclua|excluir|apague|apagar|delete|deletar|remova|remover)\b/i.test(value)) return false;
  return true;
};

const DECISION_OR_COMMAND = /^(?:sim|s|nao|não|ok|okay|confirmo|confirma|confirmar|cancela|cancelar|desisto|exclua|excluir|apague|apagar|liste|listar|mostre|mostrar|crie|criar|renomeie|renomear)$/i;

export const extractCategoryDeactivateTarget = (text: string): string | undefined => {
  let value = (text ?? '').trim();
  const noun = CATEGORY_NOUN.exec(value);
  if (noun) value = value.slice((noun.index ?? 0) + noun[0].length);
  else value = value.replace(verbRe, ' ');
  value = value
    .replace(/^\s*(?:de\s+)?(?:despesa|gasto|gastos|receita|receitas)\b/i, '')
    .replace(/^\s*(?:a|as|o|os|uma|umas|um|uns)\s+/i, '')
    .replace(/^[\s"'“”‘’]+|[\s.,;:!?"'“”‘’]+$/g, '')
    .trim();
  if (!value || value.length > 120 || DECISION_OR_COMMAND.test(value)) return undefined;
  if (/\b(?:exclua|excluir|apague|apagar|remova|remover|desative|desativar|inative|inativar)\b/i.test(value)) return undefined;
  return value;
};

const parseTargetQualifier = (text: string): { name?: string; parentName?: string; kind?: 'expense' | 'income' } => {
  const target = extractCategoryDeactivateTarget(text);
  if (!target) return {};
  const parent = /^(.*?)\s+\(em\s+([^()]+)\)$/i.exec(target);
  let name = parent?.[1]?.trim() ?? target;
  const parentName = parent?.[2]?.trim();
  const kind = /\s+de\s+(receitas?|despesas?|gastos?)$/i.exec(name);
  let resolvedKind: 'expense' | 'income' | undefined;
  if (kind) {
    resolvedKind = /^receita/i.test(kind[1]!) ? 'income' : 'expense';
    name = name.slice(0, kind.index).trim();
  }
  return { name, ...(parentName ? { parentName } : {}), ...(resolvedKind ? { kind: resolvedKind } : {}) };
};

const usable = (row: EntitySummary, scope?: string): boolean =>
  !!row.id && !!row.name && row.isActive !== false &&
  (row.status === undefined || row.status.trim().toLowerCase() === 'active') &&
  (row.kind === 'expense' || row.kind === 'income') &&
  (!scope || row.scopeId === undefined || row.scopeId === scope);

export type CategoryDeactivateResolution =
  | Readonly<{ kind: 'resolved'; category: EntitySummary }>
  | Readonly<{ kind: 'ambiguous'; options: readonly string[]; clarification: string }>
  | Readonly<{ kind: 'none'; clarification: string }>;

export const resolveCategoryDeactivateTarget = (
  text: string,
  categories: readonly EntitySummary[],
  scope?: string,
): CategoryDeactivateResolution => {
  const scopedRows = categories.filter((row) => usable(row, scope));
  const rows = scopedRows.filter((row) => !row.parentId || scopedRows.some((parent) =>
    parent.id === row.parentId && !parent.parentId && parent.kind === row.kind,
  ));
  const target = parseTargetQualifier(text);
  const query = target.name;
  if (!query) return { kind: 'none', clarification: `Qual categoria devo desativar?${rows.length ? `\n• ${rows.slice(0, 10).map((row) => row.name).join('\n• ')}` : ''}` };
  let matches = rows.filter((row) => fold(row.name) === fold(query));
  if (target.kind) matches = matches.filter((row) => row.kind === target.kind);
  if (target.parentName) matches = matches.filter((row) => {
    const parent = row.parentId ? rows.find((candidate) => candidate.id === row.parentId) : undefined;
    return parent !== undefined && fold(parent.name) === fold(target.parentName!);
  });
  if (matches.length === 1) return { kind: 'resolved', category: matches[0]! };
  if (matches.length > 1) {
    const labels = matches.map((row) => {
      const parent = row.parentId ? rows.find((candidate) => candidate.id === row.parentId) : undefined;
      return parent?.name ? `${row.name} (em ${parent.name})` : `${row.name} (${row.kind === 'income' ? 'receita' : 'despesa'})`;
    });
    return { kind: 'ambiguous', options: labels, clarification: `Encontrei mais de uma categoria chamada "${query}". Qual delas devo desativar?\n• ${labels.join('\n• ')}` };
  }
  return { kind: 'none', clarification: `Não encontrei a categoria ativa "${query}". Informe o nome exato da categoria que deseja desativar.` };
};

export const categoryDeactivateProposeSummary = (name: string): string =>
  `desativar a categoria "${name.trim()}"`;

export const isCategoryDeactivateCancelText = (text: string): boolean =>
  /^\s*(?:cancela|cancele|cancelar|desisto|desista|não\s+desative|nao\s+desative|não\s+quero\s+desativar|nao\s+quero\s+desativar|deixa\s+(?:pra\s+lá|isso))\s*[.!]*\s*$/i.test(text ?? '');

export const CATEGORY_DEACTIVATE_READ_FAILURE_TEXT =
  'Não consegui acessar suas categorias agora. Tente novamente em instantes.';

export const hasExplicitCategoryDeactivateVerb = (text: string): boolean =>
  new RegExp(`\\b(?:${VERBS.map(escapeRe).join('|')})\\b`, 'i').test(text ?? '');
