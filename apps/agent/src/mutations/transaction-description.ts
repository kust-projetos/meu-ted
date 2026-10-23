/** Deterministic, description-only transaction edit intent and target resolution. */
export const TRANSACTION_DESCRIPTION_TOOL = 'transactions.update' as const;
export type EditableTransaction = Readonly<{
  id: string;
  description: string;
  amountCents: number;
  date: string;
  accountId: string;
  kind: 'expense' | 'income' | 'transfer';
  scopeId?: string;
}>;
export type TransactionTargetOption = Readonly<{ transactionId:string; date:string; amountCents:number; accountId:string; accountName?:string }>;

const fold = (value: string): string => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').trim();
const SIGNAL = /\b(?:altere|alterar|alterar|edite|editar|renomeie|renomear|mude|mudar)\b.*\b(?:descri(?:cao|ções|coes)|lancamento|lancamentos)\b/i;
const SPLIT = /\s+\bpara\b\s+|\s+\bpra\b\s+/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

export const hasTransactionDescriptionSignal = (text: string): boolean => {
  const normalized = fold(text ?? '');
  return !/\bnao\s+altere\b/.test(normalized) && SIGNAL.test(normalized);
};

export const parseTransactionDescriptionEdit = (text: string): { targetHint?: string; description?: string } => {
  const normalized = (text ?? '').trim();
  if (!hasTransactionDescriptionSignal(normalized)) return {};
  const split = normalized.split(SPLIT);
  const hasSeparator = split.length > 1;
  const right = hasSeparator ? split.pop()?.trim().replace(/^["'“”]|["'“”.,!?]+$/g, '').trim() : undefined;
  const left = hasSeparator ? split.join(' para ').trim() : normalized;
  const prefix = left.replace(/^.*(?:lançamento|lancamento|descrição|descricao)\s*/i, '').trim();
  const description = right && !/^(cancelar|cancela|confirmar|sim|nao|não)$/i.test(right) ? right.slice(0, 240) : undefined;
  const targetHint = prefix || UUID.exec(left)?.[0];
  return { ...(targetHint ? { targetHint } : {}), ...(description ? { description } : {}) };
};

export const resolveTransactionDescriptionTarget = (
  hint: string,
  transactions: readonly EditableTransaction[],
  workspaceId?: string,
  qualifier?: { date?: string; amountCents?: number },
): { kind: 'resolved'; transaction: EditableTransaction } | { kind: 'missing' | 'ambiguous' | 'unsupported' } => {
  const candidates = transactions.filter((row) => !workspaceId || row.scopeId === workspaceId);
  const id = UUID.exec(hint)?.[0];
  let matches = id
    ? candidates.filter((row) => row.id === id)
    : candidates.filter((row) => fold(row.description) === fold(hint));
  if (qualifier?.date) matches = matches.filter((row) => row.date === qualifier.date);
  if (qualifier?.amountCents !== undefined) matches = matches.filter((row) => row.amountCents === qualifier.amountCents);
  if (!matches.length) return { kind: 'missing' };
  if (matches.every((row)=>row.kind==='transfer')) return { kind:'unsupported' };
  if (matches.length !== 1) return { kind: 'ambiguous' };
  if (matches[0]!.kind === 'transfer') return { kind: 'unsupported' };
  return { kind: 'resolved', transaction: matches[0]! };
};

/** Resolve a persisted ambiguity only from an explicit distinguishing value. */
export const resolveTransactionTargetChoice = (text:string, options:readonly TransactionTargetOption[]): string|undefined => {
  const folded=fold(text);
  const dateMatch=/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}))?\b/.exec(folded);
  const date=dateMatch ? `${dateMatch[3] ?? ''}-${dateMatch[2]!.padStart(2,'0')}-${dateMatch[1]!.padStart(2,'0')}` : undefined;
  const amountMatch=/\br\$\s*(\d[\d.]*)(?:,([0-9]{1,2}))?\b/i.exec(folded);
  const amountCents=amountMatch ? Math.round(Number(amountMatch[1]!.replace(/\./g,''))*100 + Number((amountMatch[2] ?? '0').padEnd(2,'0'))):undefined;
  const accountMatches=options.filter((option)=>option.accountName && folded.includes(fold(option.accountName)));
  const hasQualifier=date!==undefined || amountCents!==undefined || accountMatches.length>0;
  if(!hasQualifier)return undefined;
  const matches=options.filter((option)=>
    (!date || option.date===date || (dateMatch?.[3]===undefined && option.date.endsWith(date.slice(4)))) &&
    (amountCents===undefined || option.amountCents===amountCents) &&
    (accountMatches.length===0 || accountMatches.some((candidate)=>candidate.transactionId===option.transactionId)),
  );
  return matches.length===1?matches[0]!.transactionId:undefined;
};
