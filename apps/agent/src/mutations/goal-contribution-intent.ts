const fold = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export const hasGoalCreationIntent = (text: string): boolean =>
  /\b(?:criar|crie|nova|definir|montar)\b.{0,30}\b(?:meta|objetivo|reserva)\b/i.test(fold(text));

export const hasGoalCancellationIntent = (text: string): boolean =>
  /\bcancelar\b/i.test(fold(text));

export const isGoalContributionIntent = (text: string): boolean => {
  const folded = fold(text);
  if (!folded || hasGoalCreationIntent(folded) || hasGoalCancellationIntent(folded)) return false;
  if (/\b(?:quanto|qual|quando|como|posso|onde)\b/i.test(folded)) return false;
  if (/\b(?:parcelad[oa]s?|compra|cartao|credito)\b/i.test(folded)) return false;
  const verb = /\b(?:aportar|aporte|aporto|aport(?:e|a|ar|ando|ado)|contribu(?:ir|icao|icoes|o|a|indo)|guardar|guarde|guardo|guardando|colocar|coloque|coloco|colocando|depositar|deposite|deposito|depositando|separar|separe|separo|separando)\b/i.test(folded);
  const goal = /\b(?:meta|metas|objetivo|objetivos|reserva|reservas)\b/i.test(folded);
  return verb && goal;
};
