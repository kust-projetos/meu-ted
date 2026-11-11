import type { PlannedOperation } from './conversation-orchestrator.js';
import { hasMutationIntentSignal, interpretMutationUtterance } from '../mutations/semantic-interpretation.js';
import { hasAccountCreationSignal } from '../mutations/account-creation.js';
import { hasCategoryRenameSignal } from '../mutations/category-rename.js';
import { hasCategoryDeactivateSignal } from '../mutations/category-deactivation.js';
import { hasTransactionDescriptionSignal } from '../mutations/transaction-description.js';
import { selectToolsFor } from '../agent-config/tools.js';
import { validateTurnPlan, type TurnPlanV2 } from './turn-plan.js';

/**
 * Canonical domain→skill mapping (#236/#237). Skill names come from the
 * single catalog (`apps/agent/src/agent-config/skills/*`, `ALL_SKILLS`);
 * skill→tool derivation lives ONLY in `selectToolsFor`/`toolSkillLines`
 * (`agent-config/tools.ts`). The legacy `skill-inventory.ts` names
 * (`financial-analysis`, `financial-mutations`) and tool lists are retired.
 */
const DOMAIN_SKILLS: Readonly<Record<string, readonly string[]>> = {
  accounts: ['saldo-extrato', 'contas-cartoes'],
  transactions: ['registros', 'saldo-extrato'],
  cards: ['contas-cartoes'],
  payables: ['compromissos'],
  budgets: ['orcamentos-metas'],
  goals: ['orcamentos-metas'],
  categories: ['categorias'],
  memory: ['memoria'],
  web: ['web-search'],
  general: ['conversation'],
};

const skillsForDomain = (domain: string): readonly string[] =>
  DOMAIN_SKILLS[domain] ?? ['conversation'];

const fold = (value: string): string => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const typoNormalize = (value: string): string => value.replace(/\bsald\b/g, 'saldo').replace(/\bextrat\b/g, 'extrato').replace(/\bcontas?\b/g, 'contas');
const operation = (name: string): PlannedOperation => ({ name, kind: 'read' });

// S8 + P1: ano como armadilha de valor. "<mes> de <ano>", "em <ano>" ou
// "de <ano>" ("total de 2020", "no ano de 2020") com ano 19xx/20xx. A
// isenção pelo marcador monetário vale SOMENTE quando o marcador está COLADO ao número consumido pelo parser ("R$ 2020",
// "2020 reais") — "em reais" solto + ano em contexto de data ("janeiro de
// 2020", "em 2020") NÃO isenta: 4 dígitos em contexto de data nunca é valor
// sem marcador colado ao número. `parseFinancialMutation` não expõe
// proveniência/offsets, por isso a heurística é conservadora e textual.
const PAST_PERIOD_YEAR = '(?:19|20)\\d{2}';
const MONTH_NAME = 'janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro';
const PAST_PERIOD_REF = new RegExp(`\\b(?:${MONTH_NAME})\\s+de\\s+(${PAST_PERIOD_YEAR})\\b|\\bem\\s+(${PAST_PERIOD_YEAR})\\b`);

const hasGluedMoneyMarker = (normalized: string, year: number): boolean => {
  const token = String(year);
  return new RegExp(`r\\$\\s*${token}\\b|\\b${token}\\s*(?:reais?|centavos?)\\b|\\b(?:reais?|centavos?)\\s*(?:de\\s+)?${token}\\b`).test(normalized);
};

/**
 * S8 (POC Fase 2) + P1: detecta o ano lido como valor ("Quanto gastei em
 * janeiro de 2020?" → amountCents 202000). So e armadilha quando o valor do
 * candidato E o proprio ano da referencia de periodo e NAO ha marcador
 * monetario COLADO ao numero consumido — "Gastei R$ 50 em janeiro de 2020"
 * (5000 != 202000) continua mutacao, e "Gastei R$ 2020 no mercado" (R$ colado
 * ao 2020) continua mutacao. Guarda do router por menor blast radius: o
 * parser nao muda (ver semantic-interpretation/financial-parser).
 */
const isYearAsAmountTrap = (normalized: string, amountCents: number): boolean => {
  const match = PAST_PERIOD_REF.exec(normalized) ?? BARE_YEAR_REF.exec(normalized);
  if (!match) return false;
  const year = Number(match.slice(1).find((group) => group !== undefined));
  if (!Number.isFinite(year) || amountCents !== year * 100) return false;
  return !hasGluedMoneyMarker(normalized, year);
};

/**
 * P2c — ano isolado sem mês ("Quanto gastei em 2020?"). Sem agregação anual
 * no backend, o turno nunca resolve o mês corrente em silêncio: plano sem
 * operação + copy determinística honesta (o orquestrador responde
 * `UNSUPPORTED_YEAR_TEXT` sem provider e sem leitura).
 */
export const UNSUPPORTED_YEAR_TEXT =
  'Ainda não consigo resumir o ano inteiro — me diga o mês que você quer (por exemplo, "quanto gastei em janeiro de 2020?").';

/**
 * F1-B036 — subintervalo dentro do mês ("total ... do mês ... 10/10 a 15/10",
 * "do dia 10 ao dia 15"). O resumo mensal prova o `yearMonth` cheio, nunca um
 * subintervalo; sem capacidade de filtro por intervalo no contrato, responder
 * o mês cheio alegaria período não aplicado e a listagem não filtrada
 * sugeriria cobertura da janela. Limitação honesta: sem operação, sem tool,
 * sem provider e sem leitura — espelho do plano do ano isolado acima.
 */
export const UNSUPPORTED_CUSTOM_RANGE_TEXT =
  'Ainda não consigo somar um período específico dentro do mês — só o mês cheio. Me diga o mês que você quer (por exemplo, "quanto gastei em outubro de 2026?").';

/**
 * F1-B036 — total por categoria explícita ("total ... da categoria X"). Sem
 * agregação por categoria no contrato: o mês cheio alegaria soma não pedida e
 * o catálogo como resposta fingiria atendimento. Limitação honesta: sem
 * operação, sem tool, sem provider e sem leitura.
 */
export const UNSUPPORTED_CATEGORY_TOTAL_TEXT =
  'Ainda não consigo somar por categoria — só o total do mês cheio ou o extrato. Me diga qual dos dois você quer.';

/**
 * F1-B036 — total com faixa de VALOR ("total mensal entre 10 e 15 reais").
 * Restrição de valor, nunca janela: sem filtro por valor no contrato, o mês
 * cheio alegaria soma não filtrada. Copy própria — reutilizar a de período
 * rotularia valor como data, e a de categoria rotularia valor como categoria.
 * Limitação honesta: sem operação, sem tool, sem provider e sem leitura.
 */
export const UNSUPPORTED_VALUE_RANGE_TEXT =
  'Ainda não consigo somar uma faixa de valores como essa — só o total do mês cheio ou o extrato. Me diga qual dos dois você quer.';

/**
 * F1-B036 — "entre/de N a M" sem moeda, sem mês e sem "dia" ("total mensal
 * entre 10 e 15"): impossível saber se é dia ou valor — classificar como um
 * dos dois seria invenção. Esclarecimento honesto (pergunta, não afirmação),
 * sem operação, sem tool, sem provider e sem leitura. Marcados seguem nos
 * limites específicos (moeda→valor, mês/dia→período).
 */
export const AMBIGUOUS_TOTAL_RANGE_TEXT =
  'Não consegui entender se esse intervalo é de dias ou de valores. Pode esclarecer? Se for um período, me diga o mês (por exemplo, "quanto gastei em outubro de 2026?").';

/**
 * F1-B036 — mês nomeado sem ano ("total mensal de outubro"). Resolver o mês
 * corrente em silêncio consulta o mês errado (com now em novembro, lê
 * novembro); presumir o ano seria invenção. Pede o ano: sem operação, sem
 * tool, sem provider e sem leitura. Com ano ("... de 2026") segue resumo.
 */
export const UNSUPPORTED_MONTH_YEAR_TEXT =
  'Me diga de qual ano é esse mês (por exemplo, "total mensal de outubro de 2026").';

/**
 * F1-B036 — total com idiom payables ("total ... a pagar/vencidas/boleto").
 * Pede o TOTAL das contas a pagar, mas o contrato só tem a LISTA (sem soma):
 * responder o resumo geral mascararia o total pedido. Limitação honesta: sem
 * operação, sem tool, sem provider e sem leitura. Sem "total" a leitura
 * payables segue (B005/B020).
 */
export const UNSUPPORTED_PAYABLES_TOTAL_TEXT =
  'Ainda não consigo somar suas contas a pagar — só listar. Quer ver a lista?';

/**
 * F1-B036 — total de fatura ("total da fatura ...", com ou sem "vencimento").
 * O objeto é a fatura, não payables: "vencimento" sozinho não converte a
 * pergunta. Soma de fatura também não tem contrato (só lista) — responder a
 * lista fingiria atender o total. Limitação honesta própria: sem operação,
 * sem tool, sem provider e sem leitura. Sem "total" a listagem de faturas
 * segue (B010/S3).
 */
export const UNSUPPORTED_STATEMENT_TOTAL_TEXT =
  'Ainda não consigo somar sua fatura — só listar. Quer ver a lista?';

/**
 * Cartão imperativo ("crie cartão ...", "cadastrar cartão ..."):
 * criação de cartão não é suportada pelo TED. Copy honesta: nunca um
 * read (que responderia vazio ou prometeria cadastro) e nunca mutação.
 */
export const UNSUPPORTED_CARD_CREATE_TEXT =
  'Criar cartões ainda não é suportado pelo TED. Posso listar seus cartões e faturas, se quiser.';

/** Explicit card-creation imperative (unsupported capability, never a read). */
export const hasCardCreateSignal = (text: string): boolean => {
  const normalized = typoNormalize(fold(text));
  return /\b(criar|cria|crie|criei|criou|cadastrar|cadastra|cadastre|adicionar|adicione|novo|nova)\b/.test(normalized) && /\b(cartaos?|cartoes)\b/.test(normalized);
};

/**
 * Categoria update/delete ("renomeie/exclua categoria ..."): o RENAME tem
 * fluxo V2 próprio (`categories.update`, nome-only, manual); o resto
 * (excluir, mudar tipo/pai) segue sem fluxo V2 nesta fatia. Copy honesta:
 * nunca um read (que responderia a lista como se fosse a mutação) e nunca
 * mutação.
 */
export const UNSUPPORTED_CATEGORY_MUTATION_TEXT =
  'Excluir categorias ou alterar tipo e hierarquia ainda não é suportado pelo TED. Posso renomear ou desativar uma categoria, ou listar as suas.';

/** Verbo de CUD + "categoria(s)/subcategoria": mutação de catálogo, nunca leitura. */
export const hasCategoryMutationSignal = (text: string): boolean => {
  const normalized = typoNormalize(fold(text));
  return /\b(criar|cria|crie|criei|criou|cadastrar|cadastra|cadastre|adicionar|adicione|renomear|renomeia|renomeie|renomeei|atualizar|atualiza|atualize|editar|edita|edite|alterar|altera|altere|excluir|exclua|exclui|excluiu|deletar|delete|desativar|desativa|desative|apagar|apague|remover|remove|nova|novo)\b/.test(normalized) && /\b(categoria|categorias|subcategoria)\b/.test(normalized);
};

/** Verbo de CRIAÇÃO + "categoria(s)/subcategoria": só `categories.create` passa. */
export const hasCategoryCreateSignal = (text: string): boolean => {
  const normalized = typoNormalize(fold(text));
  return /\b(criar|cria|crie|criei|criou|cadastrar|cadastra|cadastre|adicionar|adicione|nova|novo)\b/.test(normalized) && /\b(categoria|categorias|subcategoria)\b/.test(normalized);
};

/** Verbo de UPDATE/DELETE + "categoria(s)/subcategoria": recusa específica, nunca forget. */
export const hasCategoryUpdateDeleteSignal = (text: string): boolean => {
  const normalized = typoNormalize(fold(text));
  return /\b(renomear|renomeia|renomeie|renomeei|atualizar|atualiza|atualize|editar|edita|edite|alterar|altera|altere|excluir|exclua|exclui|excluiu|deletar|delete|desativar|desativa|desative|apagar|apague|remover|remove)\b/.test(normalized) && /\b(categoria|categorias|subcategoria)\b/.test(normalized);
};

/**
 * Conceito PURO de categorias ("o que são categorias?"): pergunta sobre o
 * conceito, sem comando, sem consulta pessoal e sem sinal de mutação. A
 * resposta é determinística e breve, sem leitura, sem provider e sem
 * mutação. O tolerante a typo cobre só formas do radical (`categrias`,
 * `catgorias`) e SÓ alcança este ramo com cabeça conceitual — uma listagem
 * com typo ("liste minhas categrias") não cai aqui.
 */
export const CONCEPT_CATEGORIES_TEXT =
  'Categorias organizam seus lançamentos em grupos como Alimentação e Transporte; subcategorias detalham cada grupo. Posso listar as suas, se quiser.';

const CATEGORY_CONCEPT_WORD = /\b(categorias?|subcategorias?|categrias|catgorias)\b/;

// Composto com pedido de listagem ("... e liste os cartões?"): a leitura
// executa — o ramo conceito nunca a suprime. Só verbos de pedido explícito
// desviam para as heurísticas de leitura; substantivo solto ("O que é mesmo
// fatura?") mantém o caminho de conversa anterior.
const CATEGORY_CONCEPT_LISTING_REQUEST = /\b(liste|listar|listas?|mostre|mostrar|mostra|exib[aeiou]|quero|preciso|me\s+diga|me\s+mostre|trag[ao]|traz)\b/;

// Exceção estreita: segundo substantivo nu de categoria ("categoria e
// subcategoria") continua conceito puro — não há pedido, só outro nome. A
// regex é ancorada no fim: qualquer verbo depois ("... e liste ...") mantém
// o composto fora do conceito.
const stripTrailingCategoryPair = (normalized: string): string =>
  normalized.replace(/\s+e\s+(?:(?:a|o|as|os)\s+)?(categorias?|subcategorias?|categrias|catgorias)\s*[?.!]*$/, '');

// Cabeça conceitual fora da análise de "extras": o `e` de "o que É ..." é
// cópula, não cláusula — sem o strip, todo "o que é ..." seria rejeitado.
const stripConceptHead = (normalized: string): string =>
  normalized.replace(/^(?:o\s+que\s+(?:e|sao)|o\s+que\s+significa|como\s+funciona|me\s+expli)\b\s*/, '');

const PURE_CONCEPT_EXTRA_RE = /\s+e\s+|\s+mas\s+|\s+ou\s+|\s+nem\s+|[,;]|\b(liste|listar|listas?|mostre|mostrar|mostra|exib[aeiou]|quero|preciso|me\s+diga|me\s+mostre|trag[ao]|traz)\b/;

const isPureCategoryConcept = (normalized: string, text: string): boolean => {
  if (hasMutationIntentSignal(text)) return false;
  // Cabeça primeiro: em "o que É subcategoria?" o `e` é cópula, não
  // conjunção — o strip do par rodando antes a comeria com a palavra toda.
  const remainder = stripTrailingCategoryPair(stripConceptHead(normalized));
  return CATEGORY_CONCEPT_WORD.test(remainder) && !PURE_CONCEPT_EXTRA_RE.test(remainder);
};

/**
 * Composto conceito+leitura ("o que são categorias e liste os cartões?"): o
 * turno pede UMA escolha por vez — nunca promete composição ampla nem finge
 * atender listando só metade (o render anterior respondia categorias e
 * calava os cartões). Copy honesta pedindo para separar, sem leitura, sem
 * tool e sem provider.
 */
export const AMBIGUOUS_COMPOUND_REQUEST_TEXT =
  'Esse pedido mistura explicação e consulta. Me diga um de cada vez: por exemplo, "o que são categorias?" ou "liste meus cartões".';

/**
 * Kind misto do breakdown ("receitas e gastos por categoria"): o turno agrega
 * UM kind por vez, nunca os dois — copy honesta que pede a escolha, sem
 * leitura, sem tool e sem provider.
 */
export const AMBIGUOUS_BREAKDOWN_KIND_TEXT =
  'Você quer o resumo por categoria de receitas ou de gastos? Me diga um dos dois.';

/**
 * Kind do breakdown a partir do texto: "receita(s)" pede income; o default
 * é expense — correto para pedido de gastos, resumo geral ou sem marcador
 * de kind ("resumo do mês por categoria"). Fonte única usada pela evidência
 * e pelo render determinístico.
 */
export const breakdownKindForText = (text: string): 'expense' | 'income' =>
  /\breceita/.test(fold(text)) ? 'income' : 'expense';

const BARE_YEAR_REF = /\b(?:em|de)\s+((?:19|20)\d{2})\b/;

export type FastPathKind = 'balance' | 'recent_transactions' | 'confirm' | 'cancel' | 'none';
export type FastPathOptions = Readonly<{ stageCalls?: number; turnCalls?: number; cacheHit?: boolean }>;
export type FastPathResult = Readonly<{
  kind: FastPathKind;
  plannerRequired: boolean;
  allowed: boolean;
  reason?: 'call_budget_exceeded';
  apiCallBudget: number;
  cacheAuthoritative: false;
  requiresFreshApi: boolean;
}>;

/** Classifies high-volume requests without invoking a generative planner. */
export const classifyFastPath = (text: string, options: FastPathOptions = {}): FastPathResult => {
  const normalized = typoNormalize(fold(text));
  // P0 #174: a negated confirmation ("não confirmo", "não autorizo",
  // "sim, mas não confirme") is NEVER a confirmation. The affirmative token
  // (`confirmo`, `autorizo`, `sim`) matches inside the negation, so the
  // negation check runs FIRST and fails closed to `cancel` (abort the pending
  // proposal — the same terminal `resolveConfirmation` assigns to an explicit
  // negation. The negated turn routes to `cancel` fail-closed (aborts the
  // pending proposal instead of confirming it); nothing is executed from a
  // negated turn).
  const negated = /\b(nao|nunca|jamais)\b/.test(normalized);
  const confirmSignal = /\b(confirmar|confirma|confirmo|confirmado|autorizo|sim)\b/.test(normalized);
  const kind: FastPathKind = negated && confirmSignal ? 'cancel'
    : confirmSignal ? 'confirm'
    : /\b(cancelar|cancela|cancele|desistir|deixa pra la)\b/.test(normalized) ? 'cancel'
    : /\b(saldo|quanto tenho|quanto eu tenho)\b/.test(normalized) ? 'balance'
    : /\b(ultimos? lancamentos?|extrato recente|ultimas? transac)\b/.test(normalized) ? 'recent_transactions' : 'none';
  const apiCallBudget = kind === 'balance' ? 2 : kind === 'recent_transactions' ? 1 : kind === 'confirm' || kind === 'cancel' ? 1 : 0;
  const stageCalls = options.stageCalls ?? 0;
  const turnCalls = options.turnCalls ?? 0;
  const allowed = stageCalls < apiCallBudget && turnCalls < 2;
  return {
    kind,
    plannerRequired: kind === 'none',
    allowed,
    ...(allowed ? {} : { reason: 'call_budget_exceeded' as const }),
    apiCallBudget,
    cacheAuthoritative: false,
    requiresFreshApi: kind === 'balance' || kind === 'recent_transactions' || options.cacheHit === true,
  };
};

/**
 * F1 (BLOCKER) — decision routing is driven by what the HUMAN TYPED.
 *
 * `routeIntent` receives the composed turn text, which may carry attachment-derived
 * data (a PDF text layer, an STT transcript, a vision extraction). That data is
 * DATA: a document whose text says "sim confirmo" must never confirm a pending
 * operation. `decisionText` is the user-typed text and is the ONLY source for the
 * DECISION modes (`confirmation` / `cancel`); when it is omitted it defaults to
 * `text`, so every channel without attachment data behaves exactly as before.
 *
 * Read/proposal routing keeps reading the full composed text — an extracted
 * document may legitimately complete a proposal (which still requires the
 * human confirmation flow).
 */
export const routeIntent = (text: string, decisionText?: string): TurnPlanV2 => {
  const normalized = typoNormalize(fold(text));
  // The decision surface: never attachment-derived data.
  const decision = decisionText === undefined ? normalized : typoNormalize(fold(decisionText));
  if (!normalized) return fallbackPlan();
  if (/\b(?:orcament\w*|budget\w*)\b/.test(decision)
    && /\b(?:cancele|cancelar|cancela)\s+(?:o\s+)?rascunho\b/.test(decision)
    && /(?:[;,]|\be\s+(?:cancele|cancelar|cancela)\b)/.test(decision)) {
    return ambiguousCompoundRequestPlan();
  }
  if (/\bnao\s+(?:crie|criar|cria|cadastre|cadastrar|adicione|adicionar|defina|definir|monte|montar)\b/.test(decision)
    && /\b(?:orcament\w*|budget\w*)\b/.test(decision)) {
    return unsupportedBudgetCreatePlan();
  }
  if (/\bnao\s+sei\s+como\s+(?:criar|cadastrar|adicionar|definir|montar)\b/.test(decision)
    && /\b(?:orcament\w*|budget\w*)\b/.test(decision)) {
    return unsupportedBudgetCreatePlan();
  }
  if (/^cancele o rascunho\b/.test(decision) && !/^cancele o rascunho\s*[.!?]*$/.test(decision)) {
    return ambiguousCancelDraftCompoundPlan();
  }
  if (/\bnao\b/.test(decision) && /\b(registre|registrar|lance|lancar|crie|criar|apague|apagar|exclua|excluir|transfira|transferir)\b/.test(decision)) {
    return makePlan('cancel', 'general', [], [], ['conversation']);
  }
  // In an explicit rename/edit command, cancel-looking words in the new
  // literal value are data, not a decision command.
  const literalEditCommand = hasCategoryRenameSignal(decision) || hasTransactionDescriptionSignal(decision);
  const decisionFastPath = literalEditCommand ? { kind: 'none' as const } : classifyFastPath(decision);
  // ONLY these two kinds are decision modes; `balance`/`recent_transactions`
  // are reads and stay on the full text below.
  if (decisionFastPath.kind === 'confirm') return makePlan('confirmation', 'general', [], [], ['conversation']);
  if (decisionFastPath.kind === 'cancel') return makePlan('cancel', 'general', [], [], ['conversation']);
  // Budget creation has no V2 writer. Do not turn a creation request into a read.
  if (normalized.split(/\b(?:e|mas|ou)\b|[;,]/).some((clause) =>
    /\b(crie|criar|cria|cadastre|cadastrar|adicione|adicionar|defina|definir|monte|montar)\b/.test(clause)
      && /\b(orcament\w*|budget\w*)\b/.test(clause)
      && !/\bnao\b/.test(clause))) {
    return unsupportedBudgetCreatePlan();
  }
  // S7 (POC Fase 2) + P2a: pergunta CONCEITUAL ("o que e X?", "como funciona
  // X?") sobre entidade financeira, sem verbo de acao nem consulta de dados,
  // e conversa geral — nunca leitura. O possessivo ("o que e MEU saldo?")
  // pede DADO do workspace e continua nas heuristicas de leitura abaixo. Um
  // pedido EXPLICITO de consulta (extrato/saldo/quanto/gastei/mês/período)
  // nunca é conceito: "Me explique quanto gastei este mês" e "Me explique o
  // extrato de janeiro" são leituras. Modo `conversation` (nao
  // `unsupported`): nao e falha de entendimento, e o caminho deterministico
  // responde pelo provider em vez de fail-closed.
  // P2a: os radicais levam `\w*` final (plurais: "extratos", "saldos",
  // "gastos"); `mes` usa alternativa fechada (`mes|meses`) para não casar o
  // filler "mesmo" ("O que é mesmo fatura?" continua conceito).
  const hasExplicitReadSignal = /\b(extrato\w*|saldo\w*|quanto\w*|gast\w*|transac\w*|lancamento\w*|fatura\w*|meses?\b|mensal\w*|periodo\w*)/.test(normalized);
  const isPureConceptHead = /^(o\s+que\s+e|o\s+que\s+sao|o\s+que\s+significa|como\s+funciona)/.test(normalized);
  const hasConceptBreakingSignal = /\b(extrato\w*|saldo\w*|quanto\w*|gast\w*|meses?\b|mensal\w*|periodo\w*)/.test(normalized);
  const isConceptQuestion = /^(o\s+que\s+e|o\s+que\s+sao|o\s+que\s+significa|como\s+funciona|me\s+expli)/.test(normalized)
    && !/\b(meu|minha|meus|minhas|mim)\b/.test(normalized)
    && (isPureConceptHead ? !hasConceptBreakingSignal : !hasExplicitReadSignal);
  if (isConceptQuestion) {
    if (isPureCategoryConcept(normalized, text)) return conceptCategoriesPlan();
    // Composto conceito+leitura ("... e liste os cartões?"): clarificação
    // determinística pedindo para separar — nunca promete composição ampla
    // nem finge atender. Sem pedido de listagem, conversa genérica.
    if (CATEGORY_CONCEPT_LISTING_REQUEST.test(normalized)) return ambiguousCompoundRequestPlan();
    return makePlan('conversation', 'general', [], ['conversation']);
  }
  // SPEC §7.6: a parseable mutation attempt carries its real missing fields
  // from the start — accountId/categoryId always pending authoritative
  // resolution (§7.2/§7.3). Never []. Amount-less or negated utterances keep
  // the legacy read/unsupported routing below (no proposal either way).
  // R06/A06: the interpretation layer decides "this is a mutation candidate",
  // so clipped verbs ("gstei") route exactly like their canonical form and an
  // ambiguous amount (AC13) plans no mutation operation at all. The intent
  // gate itself is unchanged — only clipped verbs were added to it.
  if (hasMutationIntentSignal(text)) {
    const interpretation = interpretMutationUtterance(text);
    // S8 (POC Fase 2): consulta com periodo explicito passado nunca propoe
    // mutacao. O ano ("...de 2020") casa como valor no parser (R$ 2020,00
    // inventado); a guarda abaixo devolve o turno as leituras. So desvia
    // quando o UNICO numero aproveitavel e o proprio ano e nao ha marcador
    // monetario explicito — mutacao datada com valor real ("Gastei R$ 50 em
    // janeiro de 2020") continua `mutation-proposal`.
    if (interpretation.status === 'candidate' && !isYearAsAmountTrap(normalized, interpretation.parsed.amountCents)) {
      const tool = interpretation.parsed.kind === 'income' ? 'transactions.income.create' : 'transactions.expense.create';
      const skills = [...skillsForDomain('transactions')].slice(0, 2);
      return makePlan(
        'mutation-proposal',
        'transactions',
        [{ name: tool, kind: 'mutation' }],
        skills,
        undefined,
        ['accountId', 'categoryId'],
      );
    }
    // AC13: an ambiguous mutation intent must NOT fall through to the read
    // heuristics below — "gastei uns 80 no mercado" is not a transactions
    // query, it is a mutation the assistant refuses to guess. This plan
    // carries NO operation (no mutation, no authoritative read, no tool) and
    // is answered by the orchestrator's existing deterministic
    // `ambiguousClarification` terminal.
    if (interpretation.status === 'clarify') {
      return ambiguityPlan(interpretation.missingFields, interpretation.ambiguities);
    }
  }
  // P2c: ano isolado sem mês ("Quanto gastei em 2020?") nunca resolve o mês
  // corrente em silêncio — sem agregação anual no backend. O guard roda DEPOIS
  // do bloco de mutação acima (mutação datada com valor real já retornou) e
  // exige ausência de nome de mês: "janeiro de 2020" é janela mensal (S8),
  // "em 2020" sozinho é limitação honesta.
  if (BARE_YEAR_REF.test(normalized) && !new RegExp(`\\b(?:${MONTH_NAME})\\b`).test(normalized)) {
    return unsupportedYearPlan();
  }
  const operations: PlannedOperation[] = [];
  let domain: TurnPlanV2['domain'] = 'general';
  // #256: pergunta de TOTAL do período ("quanto gastei esse mês?", "total
  // mensal", "resumo do mês") roteia para `get_month_summary`, nunca SÓ para
  // `list_transactions`. "extrato/transações" e "gastos de <categoria>" (sem
  // mês) continuam transacionais abaixo.
  // P2b: pedido explícito de LISTAGEM (`extrato`/`transações`/`lançamentos`)
  // vence o predicado mensal — "mostre o extrato dos gastos deste mês" é
  // extrato com filtro, não TOTAL. Qualificador de categoria ("gastos DE
  // supermercado neste mês") também é listagem filtrada, não resumo. O
  // predicado de categoria cobre `de|em|com|no|na|nos|nas|do|da|dos|das`
  // para alcançar "gastei NO mercado/NA farmácia/DO ifood". O lookahead
  // `(?!mes\b|mensal\b)` protege o período ("gastei NO mês passado" continua
  // resumo); o `\s` após a preposição impede casar o prefixo "na" de "não".
  // FIX3: `isExplicitListing` e o gatilho `list_transactions` abaixo usam os
  // radicais truncados SEM `\b` final — o boundary após `transac`/`lancamento`
  // `extrato` impedia o match dos plurais ("transacoes", "lancamentos",
  // "extratos"). O radical `transac` só ocorre em palavras de listagem.
  const wantsMonthTotal = /\bquanto\s+gastei\b/.test(normalized)
    || (/\bgast/.test(normalized) && /\b(mes|mensal)\b/.test(normalized))
    || /\b(total\s+mensal|resumo\s+do\s+mes)\b/.test(normalized)
    // F1-B036: "total das despesas do mes (atual)" — total + objeto + periodo.
    // Guarda de categoria espelhando `isCategoryQualified` abaixo, estendida a
    // `despesas?`: "total das despesas DE supermercado" e listagem filtrada,
    // nunca resumo — so "despesas DO mes" (periodo) resume.
    || (/\btotal\b/.test(normalized) && /\b(despesas?|gast\w*)\b/.test(normalized) && /\b(mes|mensal)\b/.test(normalized) && !/\b(despesas?|gast\w*)\s+(de|em|com|no|na|nos|nas|do|da|dos|das)\s+(?!mes\b|mensal\b|janeiro\b|fevereiro\b|marco\b|abril\b|maio\b|junho\b|julho\b|agosto\b|setembro\b|outubro\b|novembro\b|dezembro\b|reais?\b|centavos?\b)[a-z]+\b/.test(normalized));
  const isExplicitListing = /\b(extrato|transac|lancamento)/.test(normalized);
  // F1-B036 custom-range: subintervalo dd/mm ("10/10 a 15/10") ou por extenso
  // ("dia 10 ao dia 15", "entre os dias 10 e 15"). "dia 10" sozinho também é
  // subintervalo (um dia específico), nunca o mês cheio. Janela relativa
  // ("há 3 dias", "últimos 10 dias", "em 10 dias") com mês é o mesmo caso:
  // sem filtro por intervalo no contrato, o mês cheio alegaria período não
  // aplicado. Só dispara no que resumiria sem o intervalo (ver terminal
  // abaixo) — "em 2020" (ano, 4 dígitos) nunca casa `\d{1,2}` com boundary.
  // "entre 10 e 15 de outubro": dia-a-dia sem "dia"/dd/mm — exige o mês por
  // extenso para não confundir faixa de VALOR ("entre 10 e 15 reais") com
  // janela: valor nunca vira período. Idem "de 10 a 15 de outubro" (sem
  // "entre" e sem mês por extenso após o intervalo seria faixa de valor —
  // "de 10 a 15 reais" não dispara).
  const hasEntreDayRange = new RegExp(
    `\\bentre\\s+(?:os?\\s+)?(?:dias?\\s+)?\\d{1,2}\\s+e\\s+(?:os?\\s+)?(?:dias?\\s+)?\\d{1,2}\\s+de\\s+(?:${MONTH_NAME})\\b`,
  ).test(normalized);
  const hasDeDayRange = new RegExp(
    `\\bde\\s+\\d{1,2}\\s+(?:a|ate)\\s+\\d{1,2}\\s+de\\s+(?:${MONTH_NAME})\\b`,
  ).test(normalized);
  // "entre/de N a M" sem moeda, sem mês e sem "dia": ambíguo entre dia e
  // valor. Os lookaheads mantêm os marcados nos limites específicos
  // (moeda→valor, `de <mês>`→período); o resto pede esclarecimento em vez de
  // assumir o mês inteiro.
  const hasBareRange = new RegExp(
    `\\bentre\\s+\\d{1,2}\\s+e\\s+\\d{1,2}\\b(?!\\s*(?:reais?|centavos?|rs\\.?|r\\$))(?!\\s+de\\s+(?:${MONTH_NAME})\\b)`,
  ).test(normalized)
    || new RegExp(
      `\\bde\\s+\\d{1,2}\\s+(?:a|ate)\\s+\\d{1,2}\\b(?!\\s*(?:reais?|centavos?|rs\\.?|r\\$))(?!\\s+de\\s+(?:${MONTH_NAME})\\b)`,
    ).test(normalized);
  // Faixa de VALOR com moeda explícita ("entre 10 e 15 reais", "de 10 a 15
  // reais", "de 10 até 15 reais"): restrição de valor, nunca janela. Exige o
  // marcador de moeda — sem ele ("entre 10 e 15") é ambíguo com dia e fica
  // fora (residual documentado). Sem "total" não dispara (ver terminal).
  const hasValueRange = /\bentre\s+(?:r\$\s*)?\d[\d.,]*\s+e\s+(?:r\$\s*)?\d[\d.,]*\s*(?:reais?|centavos?|rs\.?)\b/.test(normalized)
    || /\bde\s+(?:r\$\s*)?\d[\d.,]*\s+(?:a|ate)\s+(?:r\$\s*)?\d[\d.,]*\s*(?:reais?|centavos?|rs\.?)\b/.test(normalized);
  const hasCustomDateRange = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(normalized)
    || /\bdias?\s+\d{1,2}\b/.test(normalized)
    || /\bha\s+\d{1,2}\s+dias?\b/.test(normalized)
    || /\bultimos?\s+\d{1,2}\s+dias?\b/.test(normalized)
    || /\bem\s+\d{1,2}\s+dias?\b/.test(normalized)
    || hasEntreDayRange
    || hasDeDayRange;
  // Resumo por categoria ("resumo do mês por categoria", "gastos por
  // categoria"): usa o breakdown real de analytics, nunca o resumo simples.
  // Detectado por "por categoria(s)" — "liste minhas categorias" (sem "por")
  // continua listagem do catálogo abaixo.
  const isBreakdown = /\bpor\s+categorias?\b/.test(normalized);
  const isCategoryListing = /\b(categoria|categorias|subcategoria)/.test(normalized);
  // Misto pede os dois kinds na mesma frase ("receitas e gastos ..."): sem
  // agregação dupla — o turno só clarifica qual dos dois agregar.
  const isMixedBreakdownKind = /\breceita/.test(normalized) && /\b(gast\w*|despesas?)\b/.test(normalized);
  // Categoria create passa; o RENAME tem plano próprio (`categories.update`,
  // nome-only, manual); delete (e demais edições) seguem recusa específica.
  // O check roda antes de qualquer push de leitura — "Crie categoria ..."
  // nunca lista nem resume, "Renomeie categoria ..." nunca vira leitura e
  // "Exclua ..." nunca propõe.
  if (hasCategoryCreateSignal(text)) {
    return categoryCreatePlan();
  }
  if (hasCategoryRenameSignal(text)) {
    return categoryUpdatePlan();
  }
  if (hasCategoryDeactivateSignal(text)) {
    return categoryDeactivatePlan();
  }
  if (hasCategoryUpdateDeleteSignal(text)) {
    return unsupportedCategoryMutationPlan();
  }
  // Kind misto ("receitas e gastos por categoria"): uma agregação por turno,
  // nunca duas — clarificação determinística, sem tool e sem provider.
  if (isBreakdown && isMixedBreakdownKind) {
    return ambiguousBreakdownKindPlan();
  }
  // F1-B036 — total do mês com subintervalo explícito: limitação honesta,
  // nunca o mês cheio nem listagem não filtrada. O disparo usa os mesmos
  // guardas do `isMonthSummary` (ver abaixo, após `isCategoryQualified`) —
  // resto byte-idêntico.
  if (
    !isBreakdown
    && /\btotal\b/.test(normalized)
    && /\b(despesas?|gast\w*)\b/.test(normalized)
    && /\bcategorias?\b/.test(normalized)
  ) {
    return unsupportedCategoryTotalPlan();
  }
  // F1-B036 — total com faixa de VALOR ("total mensal entre 10 e 15 reais"):
  // restrição de valor, nunca janela — copy própria (a de período rotularia
  // valor como data). Exige "total": sem ele a listagem/clarificação segue
  // (#256 e mutações preservados). Fora do breakdown como os demais.
  if (!isBreakdown && /\btotal\b/.test(normalized) && hasValueRange) {
    return unsupportedValueRangePlan();
  }
  // F1-B036 — total de fatura ("total da fatura ..."): o objeto é a fatura —
  // "vencimento" sozinho não converte em payables, e soma de fatura também
  // não tem contrato. Antes do payables abaixo e do implícito; sem "total" a
  // listagem de faturas segue (B010/S3). Guarda P2b como no payables.
  if (!isBreakdown && /\btotal\b/.test(normalized) && !isExplicitListing && /\bfaturas?\b/.test(normalized)
    && /\b(contas?\s+a\s+pagar|boletos?)\b/.test(normalized)) {
    return ambiguousCompoundRequestPlan();
  }
  if (!isBreakdown && /\btotal\b/.test(normalized) && !isExplicitListing && /\bfaturas?\b/.test(normalized)) {
    return unsupportedStatementTotalPlan();
  }
  // F1-B036 — total explícito de payables ("a pagar", "venc*", "boleto"), com
  // ou sem âncora mensal ("total mensal a pagar", "total das contas vencidas
  // do mês", "total de boletos"): o contrato só tem a LISTA (sem soma), então
  // resumo ou listagem fingiriam atender o total. Antes do implícito de
  // categoria (o "a pagar" não é preposição do qualificador — e o payables é
  // o substantivo dominante). Exige "total" + guarda P2b: sem "total" a
  // leitura payables segue (B005/B020); "saldo total" bancário passa longe
  // (sem idiom). (Sem o guarda de categoria qualificada aqui —
  // `isCategoryQualified` só existe abaixo; com ambos os sinais o payables
  // vence por precedência, ambos honestos.)
  if (!isBreakdown && /\btotal\b/.test(normalized) && !isExplicitListing && /\b(venc\w*|a pagar|boleto\w*)\b/.test(normalized)) {
    return unsupportedPayablesTotalPlan();
  }
  // F1-B036 — total com filtro IMPLÍCITO de categoria ("total das despesas DE
  // supermercado", "total dos gastos NO mercado", "total mensal DE
  // supermercado"): soma por categoria, capacidade inexistente no contrato.
  // Exige "total" explícito — sem ele a listagem com filtro segue (#256-7 e
  // #256-12 preservados: "gastos de supermercado", "quanto gastei no
  // mercado"). O lookahead protege período/moeda como o de categoria ("...
  // DO mês", "... mensal", "... de outubro", "... em reais" não disparam).
  if (
    !isBreakdown
    && /\btotal\b/.test(normalized)
    && /\b(despesas?|gast\w*|total\s+mensal)\b\s+(de|em|com|no|na|nos|nas|do|da|dos|das)\s+(?!mes\b|mensal\b|janeiro\b|fevereiro\b|marco\b|abril\b|maio\b|junho\b|julho\b|agosto\b|setembro\b|outubro\b|novembro\b|dezembro\b|reais?\b|centavos?\b)[a-z]+\b/.test(normalized)
  ) {
    return unsupportedCategoryTotalPlan();
  }
  if (isBreakdown) { domain = 'categories'; operations.push(operation('analytics_category_breakdown')); }
  // FIX3 + S8 + P1: o lookahead protege o periodo ("mes/mensal" E nomes de
  // mes — "gastei NO mes passado" e "gastei EM janeiro" sao resumo/janela,
  // nunca filtro de categoria; "gastei NO mercado" continua listagem) e o
  // marcador de moeda ("gastei EM reais EM janeiro" é total em reais, nunca
  // filtro pela "categoria" reais).
  const isCategoryQualified = /\bgast\w*\s+(de|em|com|no|na|nos|nas|do|da|dos|das)\s+(?!mes\b|mensal\b|janeiro\b|fevereiro\b|marco\b|abril\b|maio\b|junho\b|julho\b|agosto\b|setembro\b|outubro\b|novembro\b|dezembro\b|reais?\b|centavos?\b)[a-z]+\b/.test(normalized);
  // F1-B036 — o que resumiria sem o subintervalo vira limitação honesta
  // (`unsupported_custom_range`), nunca o mês cheio nem listagem não
  // filtrada. Mesmos guardas do `isMonthSummary` + intervalo presente.
  if (wantsMonthTotal && !isExplicitListing && !isCategoryQualified && !isBreakdown && hasCustomDateRange) {
    return unsupportedCustomRangePlan();
  }
  // F1-B036 — mês nomeado sem ano ("total mensal de outubro", sem "de 2026"):
  // nunca resolve o corrente em silêncio nem inventa o ano — pede o ano. Com
  // ano segue resumo; "mês atual/passado" não têm nome de mês e passam direto.
  const hasMonthWithoutYear = new RegExp(`\\b(?:${MONTH_NAME})\\b`).test(normalized)
    && !/\b(?:19|20)\d{2}\b/.test(normalized);
  // F1-B036 — "entre/de N a M" sem marcador em pedido de total: ambíguo entre
  // dia e valor; assumir o mês inteiro ignoraria a restrição. Esclarecimento
  // (pergunta honesta, nunca afirmação), sem leitura e sem valor. Exige
  // "total" — sem ele a listagem segue (#256 preservado).
  if (wantsMonthTotal && !isExplicitListing && !isCategoryQualified && !isBreakdown && hasBareRange) {
    return ambiguousTotalRangePlan();
  }
  // F1-B036 — mês nomeado sem ano com os mesmos guardas: pede o ano em vez de
  // resolver o corrente em silêncio. Intervalos marcados já retornaram acima.
  if (wantsMonthTotal && !isExplicitListing && !isCategoryQualified && !isBreakdown && hasMonthWithoutYear) {
    return unsupportedMonthYearPlan();
  }
  const isMonthSummary = wantsMonthTotal && !isExplicitListing && !isCategoryQualified && !isBreakdown && !hasCustomDateRange;
  if (isMonthSummary) { domain = 'transactions'; operations.push(operation('get_month_summary')); }
  // Cartão imperativo ("crie cartão ...", "cadastrar cartão ...",
  // "novo cartão ..."): criação de cartão não é suportada — nunca um
  // read (o "vencimento" somaria `list_payables` ao `list_cards` do
  // "cartão") e nunca promessa de cadastro. Plano sem operação; o
  // orquestrador responde a copy honesta sem provider e sem leitura. Só
  // vale para turnos não-mutacionais (o bloco de mutação acima já
  // retornou), então nenhum fluxo de proposta é interceptado.
  if (hasCardCreateSignal(text)) {
    return unsupportedCardCreatePlan();
  }
  if (/\b(saldo|quanto tenho|quanto eu tenho)\b/.test(normalized)) { domain = 'accounts'; operations.push(operation('get_balance')); }
  // "contas vencidas"/"contas a pagar" override: o idiom payables ("a
  // pagar", "venc*", "boleto") absorve a menção a "conta(s)" — a leitura
  // bancária mascarava o empty do payables no gate de ausência (um `ok`
  // de outro escopo vencia o `empty`). MED (round 3): reconhecimento por
  // CLÁUSULAS, non-greedy — o texto é fatiado nas conjunções antes de
  // casar, então um idiom nunca atravessa "e"/"ou"/"," para absorver uma
  // menção de outra cláusula. Dentro da cláusula: gap de até 2 termos ou
  // só qualificadores ("que", "já", "estão", ...); outra "conta" no gap
  // QUEBRA a absorção (pedido explicitamente misto preserva as duas
  // leituras).
  // F1-B005: "conta(s)" + verbo pagar na MESMA cláusula ("quais contas
  // tenho que pagar", "pague a conta de luz") é idiom payables — o trigger
  // global acima só cobre "a pagar"/"venc*"/"boleto" e deixava o "que pagar"
  // / "pagar" + "conta" cair em `list_accounts` (baseline: B005/B020 liam
  // /accounts em vez de /payables). Escopo por cláusula (mesmo split do
  // strip): "pagar a fatura" sem "conta" e "quais contas eu tenho?" sem
  // pagar seguem intocados; "paguei" nunca chega aqui (mutação acima).
  // Reviewer (criação): imperativo explícito de criação de conta ("Crie uma
  // conta para pagar o aluguel", `hasAccountCreationSignal`) NUNCA é idiom
  // payables — o orquestrador já desvia esses turnos para o fluxo de criação
  // (`runAccountCreationTurn`, esclarecimento sem executar); o roteador só
  // não pode mascará-lo como leitura payables. O idiom estrangeiro ("crie
  // conta a pagar", sinal falso por `governedNounIsForeign`) segue payables.
  const contaPagarClause = normalized
    .split(/\s+e\s+|\s+mas\s+|\s+ou\s+|\s+nem\s+|[,;]/)
    .some((clause) => /\bcontas?\b/.test(clause) && /\b(pagar|pague\w*|pago\w*|pagamento\w*|quit\w*)\b/.test(clause))
    && !hasAccountCreationSignal(text);
  const payablesOverride = /\b(venc\w*|a pagar|boleto\w*)\b/.test(normalized) || contaPagarClause;
  const CONTA_IDIOM_GAP_BLOCK = new Set(['conta', 'contas']);
  const CONTA_IDIOM_QUALIFIERS: ReadonlySet<string> = new Set([
    'que', 'ja', 'estao', 'esta', 'eram', 'foram', 'sejam', 'sao',
    'minha', 'minhas', 'meu', 'meus', 'sua', 'suas', 'seu', 'seus',
    'toda', 'todas', 'todo', 'todos', 'as', 'os', 'a', 'o',
    'da', 'do', 'das', 'dos', 'de', 'em', 'no', 'na', 'nos', 'nas',
  ]);
  const contaGapAbsorbed = (gap: string): boolean => {
    const words = gap.trim().split(/\s+/).filter((word) => word.length > 0);
    if (words.some((word) => CONTA_IDIOM_GAP_BLOCK.has(word))) return false;
    return words.length <= 2 || words.every((word) => CONTA_IDIOM_QUALIFIERS.has(word));
  };
  const stripClauseIdiom = (clause: string): string => {
    const stripped = clause
      .replace(/\bcontas?\b((?:\s+\w+)*?)\s+(a\s+pagar|venc\w*|boleto\w*)\b/g, (match, gap: string) =>
        contaGapAbsorbed(gap ?? '') ? ' ' : match,
      )
      .replace(/(a\s+pagar|venc\w*|boleto\w*)((?:\s+\w+)*?)\s+contas?\b/g, (match, head: string, gap: string) =>
        contaGapAbsorbed(gap ?? '') ? `${head} ` : match,
      );
    // F1-B005 fallback: mesma cláusula com "conta(s)" + pagar ("que pagar",
    // "pagar", "pague a conta") absorve a menção bancária, como o gap acima
    // faz para "a pagar"/"venc*"/"boleto". Só roda quando a cláusula tem os
    // dois lados; cláusulas vizinhas já foram separadas no split.
    if (/\bcontas?\b/.test(stripped) && /\b(pagar|pague\w*|pago\w*|pagamento\w*|quit\w*)\b/.test(stripped)) {
      return stripped.replace(/\bcontas?\b/g, ' ');
    }
    return stripped;
  };
  const withoutPayablesIdiom = normalized
    .split(/\s+e\s+|\s+mas\s+|\s+ou\s+|\s+nem\s+|[,;]/)
    .map(stripClauseIdiom)
    .join(' ');
  if (/\b(conta|contas)\b/.test(payablesOverride ? withoutPayablesIdiom : normalized)) { domain = 'accounts'; operations.push(operation('list_accounts')); }
  if (/\b(extrato|transac|lancamento|gast\w*|despesas?)/.test(normalized) && !isMonthSummary && !isBreakdown) { domain = 'transactions'; operations.push(operation('list_transactions')); }
  // S3 (#257/POC Fase 2): "fatura" nua e fatura de CARTAO (`list_statements`,
  // contrato da tool gerada + skill `contas-cartoes`) — nunca o pool de
  // cartoes (`list_cards`). O dominio segue `payables` (nao ha dominio
  // `statements` no contrato; o fallback de dominio mantem
  // `list_accounts_payable` como cobertura secundaria) e o override
  // vencer/boleto/"a pagar" abaixo continua somando `list_payables`.
  if (/\b(fatura|faturas|cartao|cartoes)\b/.test(normalized)) { domain = /fatura/.test(normalized) ? 'payables' : 'cards'; operations.push(operation(/fatura/.test(normalized) ? 'list_statements' : 'list_cards')); }
  // T3.1 (SPEC §14): finance-seeking asks must map to evidence reads, never
  // fall through to unsupported/general (which yields evidence=null).
  if (/\b(orcament\w*|budget\w*)\b/.test(normalized)) { domain = 'budgets'; operations.push(operation('list_budgets')); }
  // "contas vencidas" overrides the generic accounts match above: overdue
  // bills are payables evidence, not account balances. S3: `venc\w*` cobre
  // as formas conjugadas ("vence", "vencimento") — "quando vence minha
  // fatura?" soma payables ao statements da fatura nua. F1-B005: o
  // `contaPagarClause` ("conta(s)" + pagar na mesma cláusula) soma aqui.
  if (/\b(venc\w*|a pagar|boleto\w*)\b/.test(normalized) || contaPagarClause) { domain = 'payables'; operations.push(operation('list_payables')); }
  // Categorias: listagem do catálogo real. O breakdown ("por categoria")
  // já planejou acima e nunca soma a listagem — uma leitura por turno.
  if (!isBreakdown && isCategoryListing) { domain = 'categories'; operations.push(operation('list_categories')); }
  if (!operations.length) return fallbackPlan();
  const skills = [...skillsForDomain(domain)].slice(0, 2);
  return makePlan('read', domain, operations.slice(0, 4), skills);
};

/**
 * P2b — operação planejada → tool do modelo (aliases explícitos). As leituras
 * `list_transactions`/`list_payables` do plano não têm o nome da tool gerada:
 * sem o alias, o slice do teto as amputava ("faturas" planejava
 * `list_statements` mas o plano só carregava reads do núcleo + auto_create).
 * Mutação mapeia para a tool de criação correspondente.
 */
const OPERATION_TOOL_ALIASES: Readonly<Record<string, string>> = {
  list_transactions: 'list_recent_transactions',
  list_recent_transactions: 'list_recent_transactions',
  list_payables: 'list_accounts_payable',
  list_accounts_payable: 'list_accounts_payable',
  check_payable_reminders: 'list_accounts_payable',
  get_statement_details: 'get_statement_details',
  'transactions.expense.create': 'create_expense',
  'transactions.income.create': 'create_income',
};

const toolForOperation = (name: string): string => OPERATION_TOOL_ALIASES[name] ?? name;

const makePlan = (mode: TurnPlanV2['mode'], domain: TurnPlanV2['domain'], requestedOperations: readonly PlannedOperation[], skillNames: readonly string[], explicitTools?: readonly string[], missingFields: readonly string[] = []): TurnPlanV2 => {
  // P2b: as tools das operações do plano têm prioridade — resolvem os aliases
  // acima, entram primeiro e o restante completa até o teto (8, cf.
  // turn-plan.ts). Antes, `selectToolsFor(...).slice(0, 8)` truncava as tools
  // planejadas fora do núcleo.
  const opTools = [...new Set(
    requestedOperations.map((operation) => toolForOperation(operation.name)).filter((tool) => tool.trim().length > 0),
  )];
  const rest = selectToolsFor([...skillNames]).filter((tool) => !opTools.includes(tool));
  const plan: TurnPlanV2 = { version: '2', mode, domain, skillNames, requestedOperations, requestedTools: explicitTools ?? [...opTools, ...rest].slice(0, 8), missingFields: [...missingFields], ambiguity: null, confidence: requestedOperations.length ? 0.95 : 1, correctionCount: 0 };
  const result = validateTurnPlan(plan);
  return result.success ? result.plan : fallbackPlan();
};

const fallbackPlan = (): TurnPlanV2 => ({ version: '2', mode: 'unsupported', domain: 'general', skillNames: ['conversation'], requestedOperations: [], requestedTools: [], missingFields: ['intent'], ambiguity: 'unsupported', confidence: 0, correctionCount: 0 });

/**
 * Cartão imperativo: plano sem operação, sem tool, `missingFields`
 * `['capability']` e `ambiguity` `unsupported_card_create`. O orquestrador
 * responde a copy honesta sem provider e sem evidência (espelho do plano
 * do ano isolado acima).
 */
const unsupportedCardCreatePlan = (): TurnPlanV2 => {
  const result = validateTurnPlan({
    version: '2',
    mode: 'unsupported',
    domain: 'cards',
    skillNames: ['conversation'],
    requestedOperations: [],
    requestedTools: [],
    missingFields: ['capability'],
    ambiguity: 'unsupported_card_create',
    confidence: 0,
    correctionCount: 0,
  } satisfies TurnPlanV2);
  return result.success ? result.plan : fallbackPlan();
};

/**
 * Categoria CUD: plano sem operação, sem tool, `missingFields`
 * `['capability']` e `ambiguity` `unsupported_category_mutation`. O
 * orquestrador responde a copy honesta sem provider e sem evidência
 * (espelho do plano do imperativo de cartão acima).
 */
const unsupportedCategoryMutationPlan = (): TurnPlanV2 => {
  const result = validateTurnPlan({
    version: '2',
    mode: 'unsupported',
    domain: 'categories',
    skillNames: ['conversation'],
    requestedOperations: [],
    requestedTools: [],
    missingFields: ['capability'],
    ambiguity: 'unsupported_category_mutation',
    confidence: 0,
    correctionCount: 0,
  } satisfies TurnPlanV2);
  return result.success ? result.plan : fallbackPlan();
};

/**
 * Categoria create (`categories.create`, manual-only): plano `mutation-proposal`
 * com a operação `categories.create` — o orquestrador resolve nome/kind/pai
 * contra o catálogo completo e propõe via Pending V2 (nunca autoexecuta).
 * Update/delete continuam na recusa acima.
 */
const categoryCreatePlan = (): TurnPlanV2 => {
  const result = validateTurnPlan({
    version: '2',
    mode: 'mutation-proposal',
    domain: 'categories',
    skillNames: ['conversation'],
    requestedOperations: [{ name: 'categories.create', kind: 'mutation' }],
    requestedTools: [],
    missingFields: [],
    ambiguity: null,
    confidence: 1,
    correctionCount: 0,
  } satisfies TurnPlanV2);
  return result.success ? result.plan : fallbackPlan();
};

/**
 * Categoria update (`categories.update`, nome-only, manual-only): plano
 * `mutation-proposal` com a operação `categories.update` — o orquestrador
 * resolve o alvo contra o catálogo autoritativo e propõe via Pending V2
 * (nunca autoexecuta). Delete (e demais edições) continuam na recusa acima.
 */
const categoryUpdatePlan = (): TurnPlanV2 => {
  const result = validateTurnPlan({
    version: '2',
    mode: 'mutation-proposal',
    domain: 'categories',
    skillNames: ['conversation'],
    requestedOperations: [{ name: 'categories.update', kind: 'mutation' }],
    requestedTools: [],
    missingFields: [],
    ambiguity: null,
    confidence: 1,
    correctionCount: 0,
  } satisfies TurnPlanV2);
  return result.success ? result.plan : fallbackPlan();
};

const categoryDeactivatePlan = (): TurnPlanV2 => {
  const result = validateTurnPlan({
    version: '2', mode: 'mutation-proposal', domain: 'categories', skillNames: ['conversation'],
    requestedOperations: [{ name: 'categories.deactivate', kind: 'mutation' }],
    requestedTools: [], missingFields: [], ambiguity: null, confidence: 1, correctionCount: 0,
  } satisfies TurnPlanV2);
  return result.success ? result.plan : fallbackPlan();
};

/**
 * Kind misto do breakdown: plano sem operação, sem tool, `missingFields`
 * `['kind']` e `ambiguity` `ambiguous_breakdown_kind`. O orquestrador
 * responde a escolha determinística sem provider e sem evidência.
 */
const ambiguousBreakdownKindPlan = (): TurnPlanV2 => {
  const result = validateTurnPlan({
    version: '2',
    mode: 'unsupported',
    domain: 'categories',
    skillNames: ['conversation'],
    requestedOperations: [],
    requestedTools: [],
    missingFields: ['kind'],
    ambiguity: 'ambiguous_breakdown_kind',
    confidence: 0,
    correctionCount: 0,
  } satisfies TurnPlanV2);
  return result.success ? result.plan : fallbackPlan();
};

/**
 * P2c — plano do ano isolado: sem operação, sem tool, `missingFields`
 * `['period']` e `ambiguity` `unsupported_year`. Domínio `general` (fallback
 * de evidência nulo: nenhuma leitura espúria) — o orquestrador responde a
 * copy honesta sem provider e sem evidência.
 */
const unsupportedYearPlan = (): TurnPlanV2 => {
  const result = validateTurnPlan({
    version: '2',
    mode: 'unsupported',
    domain: 'general',
    skillNames: ['conversation'],
    requestedOperations: [],
    requestedTools: [],
    missingFields: ['period'],
    ambiguity: 'unsupported_year',
    confidence: 0,
    correctionCount: 0,
  } satisfies TurnPlanV2);
  return result.success ? result.plan : fallbackPlan();
};

/**
 * F1-B036 — subintervalo dentro do mês: sem operação, sem tool,
 * `missingFields` `['period']` e `ambiguity` `unsupported_custom_range`.
 * Domínio `general` (fallback de evidência nulo: nenhuma leitura espúria) —
 * o orquestrador responde a copy honesta sem provider e sem evidência.
 */
const unsupportedCustomRangePlan = (): TurnPlanV2 => {
  const result = validateTurnPlan({
    version: '2',
    mode: 'unsupported',
    domain: 'general',
    skillNames: ['conversation'],
    requestedOperations: [],
    requestedTools: [],
    missingFields: ['period'],
    ambiguity: 'unsupported_custom_range',
    confidence: 0,
    correctionCount: 0,
  } satisfies TurnPlanV2);
  return result.success ? result.plan : fallbackPlan();
};

/**
 * F1-B036 — total por categoria explícita: sem operação, sem tool,
 * `missingFields` `['capability']` e `ambiguity` `unsupported_category_total`.
 * O orquestrador responde a copy honesta sem provider e sem evidência
 * (espelho do plano do intervalo customizado acima).
 */
const unsupportedCategoryTotalPlan = (): TurnPlanV2 => {
  const result = validateTurnPlan({
    version: '2',
    mode: 'unsupported',
    domain: 'general',
    skillNames: ['conversation'],
    requestedOperations: [],
    requestedTools: [],
    missingFields: ['capability'],
    ambiguity: 'unsupported_category_total',
    confidence: 0,
    correctionCount: 0,
  } satisfies TurnPlanV2);
  return result.success ? result.plan : fallbackPlan();
};

/**
 * F1-B036 — total com faixa de valor: sem operação, sem tool, `missingFields`
 * `['capability']` e `ambiguity` `unsupported_value_range`. Domínio `general`
 * (nenhuma leitura espúria) — o orquestrador responde a copy honesta sem
 * provider e sem evidência.
 */
const unsupportedValueRangePlan = (): TurnPlanV2 => {
  const result = validateTurnPlan({
    version: '2',
    mode: 'unsupported',
    domain: 'general',
    skillNames: ['conversation'],
    requestedOperations: [],
    requestedTools: [],
    missingFields: ['capability'],
    ambiguity: 'unsupported_value_range',
    confidence: 0,
    correctionCount: 0,
  } satisfies TurnPlanV2);
  return result.success ? result.plan : fallbackPlan();
};

/**
 * F1-B036 — "entre/de N a M" sem marcador em pedido de total: sem operação,
 * sem tool, `missingFields` `['intent']` e `ambiguity` `ambiguous_total_range`.
 * Pergunta honesta (nunca afirma dia nem valor) — o orquestrador responde a
 * copy sem provider e sem evidência.
 */
const ambiguousTotalRangePlan = (): TurnPlanV2 => {
  const result = validateTurnPlan({
    version: '2',
    mode: 'unsupported',
    domain: 'general',
    skillNames: ['conversation'],
    requestedOperations: [],
    requestedTools: [],
    missingFields: ['intent'],
    ambiguity: 'ambiguous_total_range',
    confidence: 0,
    correctionCount: 0,
  } satisfies TurnPlanV2);
  return result.success ? result.plan : fallbackPlan();
};

/**
 * F1-B036 — mês nomeado sem ano: sem operação, sem tool, `missingFields`
 * `['period']` e `ambiguity` `unsupported_month_year`. Domínio `general`
 * (nenhuma leitura espúria) — o orquestrador responde a copy honesta sem
 * provider e sem evidência.
 */
const unsupportedMonthYearPlan = (): TurnPlanV2 => {
  const result = validateTurnPlan({
    version: '2',
    mode: 'unsupported',
    domain: 'general',
    skillNames: ['conversation'],
    requestedOperations: [],
    requestedTools: [],
    missingFields: ['period'],
    ambiguity: 'unsupported_month_year',
    confidence: 0,
    correctionCount: 0,
  } satisfies TurnPlanV2);
  return result.success ? result.plan : fallbackPlan();
};

/**
 * F1-B036 — total com idiom payables: sem operação, sem tool, `missingFields`
 * `['capability']` e `ambiguity` `unsupported_payables_total`. Domínio
 * `payables` (coerente com a leitura que existiria) — o orquestrador responde
 * a copy honesta sem provider e sem evidência.
 */
const unsupportedBudgetCreatePlan = (): TurnPlanV2 => {
  const result = validateTurnPlan({
    version: '2', mode: 'unsupported', domain: 'budgets', skillNames: ['conversation'],
    requestedOperations: [], requestedTools: [], missingFields: ['capability'],
    ambiguity: 'unsupported_budget_create', confidence: 0, correctionCount: 0,
  } satisfies TurnPlanV2);
  return result.success ? result.plan : fallbackPlan();
};

const unsupportedStatementTotalPlan = (): TurnPlanV2 => {
  const result = validateTurnPlan({
    version: '2',
    mode: 'unsupported',
    domain: 'payables',
    skillNames: ['conversation'],
    requestedOperations: [],
    requestedTools: [],
    missingFields: ['capability'],
    ambiguity: 'unsupported_statement_total',
    confidence: 0,
    correctionCount: 0,
  } satisfies TurnPlanV2);
  return result.success ? result.plan : fallbackPlan();
};

const unsupportedPayablesTotalPlan = (): TurnPlanV2 => {
  const result = validateTurnPlan({
    version: '2',
    mode: 'unsupported',
    domain: 'payables',
    skillNames: ['conversation'],
    requestedOperations: [],
    requestedTools: [],
    missingFields: ['capability'],
    ambiguity: 'unsupported_payables_total',
    confidence: 0,
    correctionCount: 0,
  } satisfies TurnPlanV2);
  return result.success ? result.plan : fallbackPlan();
};

const ambiguousCancelDraftCompoundPlan = (): TurnPlanV2 => {
  const result = validateTurnPlan({
    version: '2', mode: 'unsupported', domain: 'general', skillNames: ['conversation'],
    requestedOperations: [], requestedTools: [], missingFields: ['intent'],
    ambiguity: 'ambiguous_cancel_draft_compound', confidence: 0, correctionCount: 0,
  } satisfies TurnPlanV2);
  return result.success ? result.plan : fallbackPlan();
};

/**
 * Conceito puro de categorias: plano `conversation` sem operação, sem tool,
 * `ambiguity` `concept_categories`. O orquestrador responde o texto
 * determinístico sem provider e sem leitura.
 */
const conceptCategoriesPlan = (): TurnPlanV2 => {
  const result = validateTurnPlan({
    version: '2',
    mode: 'conversation',
    domain: 'general',
    skillNames: ['conversation'],
    requestedOperations: [],
    requestedTools: [],
    missingFields: [],
    ambiguity: 'concept_categories',
    confidence: 1,
    correctionCount: 0,
  } satisfies TurnPlanV2);
  return result.success ? result.plan : fallbackPlan();
};

/**
 * Composto conceito+leitura: plano sem operação, sem tool, `missingFields`
 * `['intent']` e `ambiguity` `ambiguous_compound_request`. O orquestrador
 * responde a escolha determinística sem provider e sem evidência.
 */
const ambiguousCompoundRequestPlan = (): TurnPlanV2 => {
  const result = validateTurnPlan({
    version: '2',
    mode: 'unsupported',
    domain: 'general',
    skillNames: ['conversation'],
    requestedOperations: [],
    requestedTools: [],
    missingFields: ['intent'],
    ambiguity: 'ambiguous_compound_request',
    confidence: 0,
    correctionCount: 0,
  } satisfies TurnPlanV2);
  return result.success ? result.plan : fallbackPlan();
};

/**
 * R06/A06 (AC13): the deterministic plan for an AMBIGUOUS mutation intent.
 *
 * It declares no operation at all — no mutation, no read, no tool — and names
 * the real missing fields plus the ambiguities, so the turn can only be
 * answered by asking the user. `confidence: 0` mirrors `fallbackPlan`: nothing
 * about this utterance is actionable yet.
 */
const ambiguityPlan = (
  missingFields: readonly string[],
  ambiguities: readonly string[],
): TurnPlanV2 => {
  const result = validateTurnPlan({
    version: '2',
    mode: 'unsupported',
    domain: 'transactions',
    skillNames: ['conversation'],
    requestedOperations: [],
    requestedTools: [],
    missingFields: [...missingFields],
    ambiguity: `ambiguous:${ambiguities.join(',')}`,
    confidence: 0,
    correctionCount: 0,
  } satisfies TurnPlanV2);
  return result.success ? result.plan : fallbackPlan();
};
