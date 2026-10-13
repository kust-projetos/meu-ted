/**
 * ATTACHMENT-CONTENT-QUERY — delimited classification for "question about the
 * admitted attachment data" turns (debugger proposal).
 *
 * PROBLEM: a turn carrying an admitted STT transcript (or other extraction)
 * plus a TYPED question about that content fell into financial flows — INV-06
 * mistook the attachment data for a financial claim (unsupported with no
 * reads), grounding rejected "O áudio informa …" as provenance, and a
 * recoverable draft captured the question (INV-10).
 *
 * CONTRACT (deliberately narrow):
 * - ONLY the human-typed text is classified (`decisionText`, never the
 *   composed turn text, never the transcript). A transcript that says "sim
 *   confirmo" can neither confirm nor become a query.
 * - A query ALSO requires server-side admitted extraction (`hasAttachmentData`
 *   + non-empty `attachmentTexts`, both from server-side options only). A bare
 *   "o que diz o áudio?" with no admitted data keeps the legacy flow.
 * - `confirmation` / `cancel` plans are NEVER intercepted (F1): a typed
 *   decision owns the turn even when it names the attachment ("confirmo o
 *   áudio" still confirms). The detector alone may match such a text; the
 *   resolver below refuses it by plan mode, and the orchestrator gate applies
 *   the resolver — never the detector directly.
 * - REVIEW-P2: an explicit financial intent in the TYPED text vetoes the
 *   query (mixed requests clarify in the legacy flow), and a denial scoping
 *   the query verb voids it (the denied text is never reproduced). Both are
 *   decided from the TYPED text only — transcript words never veto nor match.
 * - No fuzzy/account matching: the classifier never resolves entities, never
 *   proposes, never executes. INV-06, `decisionText` and the financial
 *   pipelines are untouched.
 */
const fold = (value: string): string =>
  (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Attachment nouns the pipeline actually produces (audio/STT transcript, PDF,
 * image) plus the generic document words. Folded (unaccented) matching, so
 * `áudio`/`transcrição` match their plain forms. CLOSED: finance nouns
 * (`conta`, `saldo`, `mercado`, `gasto`) are NOT here — a transcript carrying
 * them must never turn the typed question into something else, and a typed
 * "qual meu saldo?" names no attachment and stays a financial turn.
 */
const ATTACHMENT_NOUN_RE =
  /\b(audio|transcricao|transcricoes|transcrito|transcritos|pdf|imagem|imagens|foto|fotos|anexo|anexos|anexado|arquivo|documento|video|gravacao)\b/;

/**
 * Consultation verbs: repeat/transcribe/summarise/ask-about. CLOSED and
 * deliberately free of mutation verbs (`lance`, `registre`, `crie`) and of
 * bare decision words (`sim`, `cancela`) — an explicitly requested proposal
 * ("lance 50 reais no mercado") never becomes a content query. FULL
 * inflections (never bare stems): a trailing `\b` must hold, so `qual` never
 * matches `qualquer` and `diz` never matches `dizeres`.
 */
const CONTENT_QUERY_VERB_SRC =
  'repita|repito|repete|reproduza|reproduz|transcreva|transcreve|transcrever|resuma|resume|resumir|diz|dizem|diga|verifique|verifica|verificar|confira|leia|mostre|mostra|explique|explica|informa|informe|informar|qual|quais|quanto|o que|contem';

const CONTENT_QUERY_VERB_RE = new RegExp(`\\b(?:${CONTENT_QUERY_VERB_SRC})\\b`);

/**
 * Verbatim (deterministic repeat) verbs: the request asks for the transcript
 * ITSELF, not for a reading of it ("repita a transcrição", "transcreva palavra
 * por palavra"). "Resuma" and "o que diz" are generative queries, never
 * verbatim.
 */
const VERBATIM_VERB_RE =
  /\b(repita|repito|repete|reproduza|reproduz|transcreva|transcreve|transcrever|palavra por palavra|na integra|integralmente|verbatim)\b/;

/**
 * REVIEW-P2 financial veto (TYPED text only, folded): an explicit ledger
 * intent keeps the legacy flow owning the turn — even when the same text
 * names the attachment ("qual meu saldo? Segue o áudio", "gastei 50 reais
 * no mercado; mostre o áudio"). CLOSED: ledger-state nouns
 * (`saldo`, `conta`, `fatura`, `extrato`), conjugated financial
 * statement/mutation verbs (`gastei`, `lance`, `registre`, `pague`, …) and
 * possession verbs of balance inquiries (`tenho`, `possuo`). Deliberately
 * NOT vetoed: content words that may name what the attachment says
 * (`mercado`, `valor`, `palavra`) — "verifique a palavra mercado no áudio"
 * and "o áudio informa qual valor?" stay queries; only the TYPED intent
 * decides, transcript words never do.
 */
const FINANCIAL_VETO_RE =
  /\b(saldo|saldos|conta|contas|fatura|faturas|extrato|extratos|gastei|gastou|gastamos|gastaram|gaste|gastem|gastar|lance|lancam|lancar|registre|registra|registrar|crie|cria|criar|adicione|pague|pagar|paguei|transfira|transferir|quite|quitar|tenho|temos|possuo)\b/;

/**
 * REVIEW-P2 negation guard (TYPED text only, folded): a denial scoping the
 * query verb voids the query ("não repita a transcrição", "nunca mostre o
 * anexo"). The denial must PRECEDE the verb within three words, so a denial
 * scoping something else keeps a positive query ("repita tudo do áudio,
 * não omita nada" still repeats; "não sei, o que diz o áudio?" still asks).
 */
const NEGATED_QUERY_RE = new RegExp(
  `\\b(?:nao|nunca|jamais|nem)\\b(?:\\s+\\w+){0,3}?\\s+(?:${CONTENT_QUERY_VERB_SRC})\\b`,
);

/**
 * REVIEW-P2b ambiguous-negation guard (TYPED text only, folded): a denial
 * word ANYWHERE before a query verb also voids the query — not just within
 * the three-word window above ("não quero que você me repita a
 * transcrição" must never reproduce the denied text). A distant denial is
 * ambiguous (it may or may not scope the verb), so the turn fail-closes to
 * the legacy flow, which clarifies. A denial AFTER every query verb still
 * keeps a positive query ("repita tudo do áudio, não omita nada" still
 * repeats). Deliberately NOT widened to a larger word window: distance is
 * irrelevant once a denial precedes the verb — the turn is ambiguous.
 */
const NEGATION_WORD_RE = /\b(?:nao|nunca|jamais|nem)\b/;

const hasPrecedingNegation = (normalized: string): boolean => {
  const negation = NEGATION_WORD_RE.exec(normalized);
  if (!negation) return false;
  return CONTENT_QUERY_VERB_RE.test(normalized.slice(negation.index + negation[0].length));
};

/** True when the TYPED text asks about attachment content (verbatim or generative). */
export const isAttachmentContentQuery = (typedText: string): boolean => {
  const normalized = fold(typedText);
  if (!normalized) return false;
  // REVIEW-P2: an explicit financial intent in the TYPED text owns the turn
  // (mixed requests clarify in the legacy flow, never intercept).
  if (FINANCIAL_VETO_RE.test(normalized)) return false;
  // REVIEW-P2: a negation scoping the query verb is not a positive delimited
  // query ("não repita a transcrição" must never reproduce the denied text).
  if (NEGATED_QUERY_RE.test(normalized)) return false;
  // REVIEW-P2b: a distant/ambiguous preceding denial also belongs to the
  // legacy flow ("não quero que você me repita a transcrição").
  if (hasPrecedingNegation(normalized)) return false;
  return CONTENT_QUERY_VERB_RE.test(normalized) && ATTACHMENT_NOUN_RE.test(normalized);
};

/** True when the TYPED text asks for the literal transcript (deterministic repeat). */
export const isVerbatimTranscriptRequest = (typedText: string): boolean => {
  const normalized = fold(typedText);
  if (!normalized) return false;
  if (FINANCIAL_VETO_RE.test(normalized)) return false;
  if (NEGATED_QUERY_RE.test(normalized)) return false;
  if (hasPrecedingNegation(normalized)) return false;
  return VERBATIM_VERB_RE.test(normalized) && ATTACHMENT_NOUN_RE.test(normalized);
};

export type AttachmentContentQueryInput = Readonly<{
  decisionText?: string;
  text: string;
  hasAttachmentData?: boolean;
  attachmentTexts?: readonly string[];
}>;

export type AttachmentContentQuery = Readonly<{
  verbatim: boolean;
  admitted: readonly string[];
}>;

/**
 * Gate resolver: returns the content-query handling for this turn, or null
 * when the legacy pipeline owns it. Precedes financial routing and draft
 * continuation — the caller applies it right after plan validation, before
 * undo/forget/draft branches.
 *
 * Refusals (all fail-closed toward the legacy flow):
 * - `confirmation` / `cancel` plan: the typed DECISION owns the turn (F1).
 * - no server-side `hasAttachmentData`: nothing admitted, nothing to quote.
 * - no non-empty admitted `attachmentTexts`: idem.
 * - typed text is not a content query: balance/proposal/decision/small talk
 *   keep their normal flow.
 */
export const resolveAttachmentContentQuery = (
  input: AttachmentContentQueryInput,
  planMode: string,
): AttachmentContentQuery | null => {
  if (planMode === 'confirmation' || planMode === 'cancel') return null;
  if (input.hasAttachmentData !== true) return null;
  const admitted = (input.attachmentTexts ?? []).filter(
    (item): item is string => typeof item === 'string' && item.trim() !== '',
  );
  if (admitted.length === 0) return null;
  const typed = input.decisionText ?? input.text;
  if (!isAttachmentContentQuery(typed)) return null;
  return { verbatim: isVerbatimTranscriptRequest(typed), admitted };
};
