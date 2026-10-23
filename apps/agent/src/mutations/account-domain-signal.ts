/**
 * Account-domain signal guards (ted-local-account-domain-guards).
 *
 * Decides WHAT the verb governs (the action object/clause) BEFORE the
 * account noun is trusted — without ever vetoing on a bare keyword that may
 * live inside a name. Explicitly named spans (quoted excerpts and
 * `chamada`/`chamado`/`nome`/`de nome` regions) are blanked first, so
 * `"Conta a Pagar"` and `chamada Categoria Mercado` keep their names while a
 * bare `conta a pagar` / `categoria` object fails the signal.
 *
 * Deliberately lexical and bounded: the verb's governed noun plus a closed
 * idiom list (`conta a pagar`, `conta vencida/atrasada/pendente`). No
 * generic parser, no framework, no new write paths — unsupported turns
 * (payables, cards, installments, categories) simply do not signal, so they
 * can never open or confirm an account draft.
 */

const QUOTED_SPAN_SRC = '"([^"]+)"|\'([^\']+)\'|"([^"]+)"|\'([^\']+)\'';
const INTRODUCER_RE_SRC = '\\b(chamada|chamado|de\\s+nome|nome)\\b';

/** Explicitly named spans: quoted excerpts + introducer name regions. */
export const namedSpanRanges = (text: string): Array<[number, number]> => {
  const spans: Array<[number, number]> = [];
  const quoteRe = new RegExp(QUOTED_SPAN_SRC, 'g');
  let m: RegExpExecArray | null;
  while ((m = quoteRe.exec(text)) !== null) spans.push([m.index, m.index + m[0].length]);
  const intro = new RegExp(INTRODUCER_RE_SRC, 'i').exec(text);
  if (intro && intro.index !== undefined) {
    const start = intro.index;
    const endRel = text.slice(start).search(new RegExp('\\bsaldos?\\b|\\btipo\\b|R\\$', 'i'));
    spans.push([start, endRel < 0 ? text.length : start + endRel]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  return spans;
};

/** Blank named spans with spaces (length- and offset-preserving). */
export const blankNamedSpans = (text: string): string => {
  const spans = namedSpanRanges(text);
  if (spans.length === 0) return text;
  let out = '';
  let pos = 0;
  for (const [s, e] of spans) {
    if (s < pos) continue;
    out += text.slice(pos, s) + ' '.repeat(Math.max(0, e - s));
    pos = Math.max(pos, e);
  }
  return out + text.slice(pos);
};

const escapeRe = (word: string): string =>
  word.replace(new RegExp('[.+*?^${}()|[\\]\\\\]', 'g'), '\\$&');

/**
 * A negated verb ("não/nunca/jamais/nem crie", "não quero criar") is no
 * account signal. The negator must govern the verb directly (optional
 * "quero" in between); a "não"/"menos" elsewhere — e.g. "saldo negativo",
 * "-50", "não quero ver" — never vetoes. Checked on blanked text so a
 * quoted name cannot smuggle a negation.
 */
/**
 * A negated verb ("não/nunca/jamais/nem crie/desative", optionally with a
 * modal — "não pode/quero criar") is no account signal. The negator must
 * govern the verb directly (adjacent, commas allowed); distant negations
 * ("não sei, crie ...") and balance vocabulary ("saldo negativo", "-50")
 * never veto. Evaluated on blanked text: a quoted/named span can neither
 * smuggle a negation in ("crie conta \"Não crie\"") nor be vetoed by one —
 * a real negation OUTSIDE the spans still vetoes ("não crie conta
 * \"Não crie\""). No universal grammar, no distant-negator paranoia.
 */
const MODAL_AUXILIARIES = ['quero', 'quer', 'pode', 'podem', 'consegue', 'conseguem', 'vai', 'vou'];

export const isNegatedVerb = (blanked: string, verbs: readonly string[]): boolean =>
  new RegExp(`\\b(n[aã]o|nunca|jamais|nem)\\b[\\s,]+((?:${MODAL_AUXILIARIES.join('|')})\\s+)?(${verbs.map(escapeRe).join('|')})\\b`).test(
    blanked,
  );

/**
 * Foreign object vocabulary: entity nouns of OTHER domains that, as the
 * verb's governed object, veto the account signal. Deliberately WITHOUT the
 * transactional nouns (`despesa`, `receita`, `transacao`, `lancamento`):
 * those keep their existing contract elsewhere (an explicit "desative"
 * still wins over them and downstream resolution clarifies).
 */
const FOREIGN_OBJECT_WORDS: ReadonlySet<string> = new Set([
  'categoria',
  'categorias',
  'cartao',
  'cartoes',
  'fatura',
  'faturas',
  'parcela',
  'parcelas',
  'parcelamento',
  'parcelamentos',
  'assinatura',
  'assinaturas',
  'boleto',
  'boletos',
  'compromisso',
  'compromissos',
  'orcamento',
  'orcamentos',
  'meta',
  'metas',
]);

/**
 * True when a verb's governed noun is a foreign-domain entity ("desative
 * categoria ...", "crie parcelamento ... conta QA Aurora banco"), or when a
 * foreign entity sits between the verb and the first "conta" (mixed
 * foreign+bank commands clarify instead of writing). A "conta" noun stays
 * account-domain UNLESS it opens the payable idiom ("conta a pagar",
 * "contas vencidas"), which is never a bank account. Quoted/named spans are
 * already blanked by the caller, so `"Conta a Pagar"` and
 * `chamada Categoria Mercado` keep working.
 */
export const governedNounIsForeign = (blanked: string, verbs: readonly string[]): boolean => {
  const verbRe = new RegExp(`\\b(?:${verbs.map(escapeRe).join('|')})\\b`, 'g');
  const foreignRe = new RegExp(`\\b(?:${[...FOREIGN_OBJECT_WORDS].join('|')})\\b`);
  const contaRe = /\bcontas?\b/;
  const payableIdiomAt = (fragment: string): boolean =>
    /^(?:contas?\s+a\s+pagar|contas?\s+(?:vencidas?|atrasadas?|pendentes?))\b/.test(fragment);
  let m: RegExpExecArray | null;
  while ((m = verbRe.exec(blanked)) !== null) {
    let rest = blanked.slice(m.index + m[0].length).replace(/^\s+/, '');
    const det = /^(o|a|os|as|um|uma|uns|umas|meu|minha|meus|minhas|esse|essa|este|esta|novo|nova)\b\s*/.exec(rest);
    if (det) rest = rest.slice(det[0].length);
    const noun = /^[a-z0-9]+/.exec(rest)?.[0];
    if (noun && FOREIGN_OBJECT_WORDS.has(noun)) return true;
    const conta = contaRe.exec(rest);
    if (conta && conta.index !== undefined) {
      if (foreignRe.test(rest.slice(0, conta.index))) return true;
      if (payableIdiomAt(rest.slice(conta.index))) return true;
    }
  }
  return false;
};
