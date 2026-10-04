"use client";

/**
 * A05 — R05 (SPEC §5) / AC11: renderer de Markdown **restrito e in-house**.
 *
 * Decisão de implementação (fechada pelo Planner, jev_decide 0.84): sem
 * `react-markdown`/`remark-gfm` e sem qualquer dependência nova (postura de
 * supply chain + bundle mobile + modo de falha cosmético).
 *
 * Invariantes absolutas deste módulo:
 *  1. A saída é construída EXCLUSIVAMENTE com elementos React a partir de nós
 *     de texto. NÃO existe `dangerouslySetInnerHTML`/innerHTML em nenhum
 *     caminho — HTML bruto do conteúdo é apenas TEXTO (React escapa).
 *  2. Link só vira `<a>` com `http`/`https` ABSOLUTO (`isSafeExternalUrl`).
 *     `javascript:`, `data:`, `file:`, esquemas desconhecidos e URLs relativas
 *     continuam texto inerte. Todo link externo abre com `target="_blank"` +
 *     `rel="noopener noreferrer"`.
 *  3. Imagem (`![alt](url)`) NUNCA vira `<img>` — vira texto (nenhum tracking
 *     remoto, nenhum `onerror` executável).
 *  4. Conteúdo de código (inline e em bloco) é texto puro, sem parsing interno.
 *
 * Subset suportado: parágrafos/quebras, `**negrito**`, `*itálico*`, `_itálico_`,
 * `código inline`, blocos cercados ``` , links `[texto](url)`, listas
 * `-`/`*`/`+` e `1.`, headings `#`..`######` e tabelas GFM.
 */

import { Fragment, useMemo, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// Helpers de caractere (por code point — evita regex com classes frágeis)
// ---------------------------------------------------------------------------

function isWordChar(code: number): boolean {
  if (code >= 0x30 && code <= 0x39) return true; // 0-9
  if (code >= 0x41 && code <= 0x5a) return true; // A-Z
  if (code >= 0x61 && code <= 0x7a) return true; // a-z
  if (code >= 0x00c0 && code <= 0x024f) return true; // latin supplement/extended
  if (code >= 0x0370 && code <= 0x1fff) return true; // demais alfabetos (não separadores)
  return false;
}

/** `\`, seguido de pontuação ASCII: escape de markdown. */
function isEscapable(code: number): boolean {
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
}

/**
 * Espaço, controle, DEL, aspas, angle brackets e backslash são rejeitados no
 * valor AUTORADO (sem tolerar trim): é exatamente aí que o navegador
 * reinterpreta o que a aplicação apenas "olhou" (ex.: `java\nscript:`).
 */
function hasUnsafeUrlChar(raw: string): boolean {
  for (const ch of raw) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x20 || code === 0x7f) return true;
    if (ch === "<" || ch === ">" || ch === '"' || ch === "'" || ch === "\\") return true;
  }
  return false;
}

/**
 * Whitelist de protocolo. Aceita SOMENTE `http:`/`https:` absolutos.
 * Qualquer outra coisa — `javascript:`, `data:`, `file:`, `vbscript:`,
 * esquema desconhecido, caminho relativo, protocolo-relativo (`//host`),
 * ou URL com espaço/controle/aspas — é rejeitada.
 */
export function isSafeExternalUrl(raw: string): boolean {
  if (!raw || hasUnsafeUrlChar(raw)) return false;
  // A marca de autoridade `//` é exigida EXPLICITAMENTE: `new URL("https:relatorio")`
  // NÃO lança — o parser WHATWG resolve um esquema especial sem base e devolve
  // `https://relatorio/` com hostname não-vazio, o que faria o link virar uma
  // rota da própria PWA em vez de destino externo.
  const schemeMatch = /^(https?):\/\//i.exec(raw);
  if (!schemeMatch) return false;
  try {
    // Parse estrito (sem base): rejeita o que não é URL absoluta.
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.hostname.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Modelo de nós
// ---------------------------------------------------------------------------

export type TedInlineNode =
  | { kind: "text"; value: string }
  | { kind: "strong"; children: TedInlineNode[] }
  | { kind: "emphasis"; children: TedInlineNode[] }
  | { kind: "code"; value: string }
  | { kind: "link"; href: string; children: TedInlineNode[] }
  | { kind: "break" };

export type TedBlockNode =
  | { kind: "paragraph"; children: TedInlineNode[] }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: TedInlineNode[] }
  | { kind: "codeBlock"; value: string; language: string | null }
  | { kind: "list"; ordered: boolean; items: TedInlineNode[][] }
  | { kind: "table"; header: TedInlineNode[][]; rows: TedInlineNode[][][] };

// ---------------------------------------------------------------------------
// Parser inline
// ---------------------------------------------------------------------------

/** Uma ênfase só abre/fecha se o vizinho não for parte de uma palavra. */
function canOpenEmphasis(src: string, index: number): boolean {
  if (index === 0) return true;
  return !isWordChar(src.codePointAt(index - 1) ?? 0);
}

function canCloseEmphasis(src: string, index: number): boolean {
  if (index >= src.length) return true;
  return !isWordChar(src.codePointAt(index) ?? 0);
}

function pushText(nodes: TedInlineNode[], value: string): void {
  if (!value) return;
  const last = nodes[nodes.length - 1];
  if (last && last.kind === "text") last.value += value;
  else nodes.push({ kind: "text", value });
}

/**
 * Fecha um parêntese de URL-balanced em `src`, a partir do '(' em `open`.
 * Cada caractere inspecionado é debitado do orçamento: um '(' que nunca fecha
 * custa O(sufixo) e é a revarredura quadrática dominante deste parser.
 */
function findClosingParen(src: string, open: number, scan: ScanBudget): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (!spend(scan, 1)) return -1;
    const ch = src[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * `indexOf` com orçamento: debita exatamente o trecho varrido (distância até o
 * achado, ou até o fim quando não há). Sem isso, um `]` ausente faz cada `[`
 * varrer o sufixo inteiro — quadrático em entrada patológica.
 */
function indexOfScanned(src: string, needle: string, from: number, scan: ScanBudget): number {
  const at = src.indexOf(needle, from);
  const scanned = at === -1 ? src.length - from : at - from + 1;
  if (!spend(scan, scanned)) return -1;
  return at;
}

/**
 * Teto de recursão do parser inline. Além dele o restante vira TEXTO (o
 * conteúdo é preservado, só a formatação é abandonada): entrada patológica
 * não pode estourar a stack do navegador.
 */
const MAX_INLINE_DEPTH = 8;

/**
 * ORÇAMENTO de inspeção por chamada de topo. Cada caractere realmente inspecionado
 * (laço principal, busca de fechamento de parêntese, `indexOf` de agulha) consome
 * uma unidade.
 *
 * Por que orçamento e não só "rastrear posições já vistas": as revarreduras do
 * parser têm duas fontes independentes — o `indexOf` de `]` e o
 * `findClosingParen` — e a segunda (`[a](` repetido) é a que domina: media ~1s
 * para 64KB, quadrático. Um teto único trava as duas sem duplicar mecanismo.
 *
 * Dimensionamento: mensagens legítimas do assistente são de poucos KB e gastam
 * ordens de grandeza menos que o teto (uma mensagem de 40KB fica em ~10% dele,
 * verificado); 2M unidades correspondem a poucos ms de pior caso, então o teto
 * nunca é o gargalo de UX. O teto vale POR CHAMADA INLINE DE TOPO (cada bloco
 * da mensagem tem o seu), e o efeito de estouro é degradação de formatação com
 * texto preservado — nunca perda de conteúdo.
 */
const MAX_INLINE_SCAN = 2_000_000;

/** Contador de orçamento compartilhado por toda a árvore de chamadas de um parse. */
interface ScanBudget {
  ops: number;
}

/** Debita `cost` unidades; devolve false (e zera o orçamento) quando não cabe. */
function spend(budget: ScanBudget, cost: number): boolean {
  if (budget.ops < cost) {
    budget.ops = 0;
    return false;
  }
  budget.ops -= cost;
  return true;
}

/**
 * Parser inline por varredura. Sem dependência externa e sem lookbehind no
 * regex (compatibilidade de runtime mobile não é negociável).
 *
 * `budget` é interno: criado na chamada de topo (profundidade 0) e repassado às
 * recursões, de modo que o teto vale para o parse INTEIRO e não por trecho.
 */
export function parseInline(src: string, depth = 0, budget?: ScanBudget): TedInlineNode[] {
  if (depth > MAX_INLINE_DEPTH) return [{ kind: "text", value: src }];
  const scan: ScanBudget = budget ?? { ops: MAX_INLINE_SCAN };
  const nodes: TedInlineNode[] = [];
  let i = 0;

  /**
   * Estouro de orçamento: o resto do trecho entra como TEXTO LITERAL. Preserva
   * todos os caracteres restantes — só a formatação é abandonada.
   */
  const drainAsText = (): void => {
    pushText(nodes, src.slice(i));
    i = src.length;
  };

  while (i < src.length) {
    if (!spend(scan, 1)) {
      drainAsText();
      break;
    }
    const ch = src[i]!;

    // Quebra de linha dentro do parágrafo (o bubble mantém whitespace-pre-wrap).
    if (ch === "\n") {
      nodes.push({ kind: "break" });
      i += 1;
      continue;
    }

    // Escape: \X devolve X literal (o marcador escapado nunca é processado).
    if (ch === "\\" && i + 1 < src.length && isEscapable(src.codePointAt(i + 1) ?? 0)) {
      pushText(nodes, src[i + 1]!);
      i += 2;
      continue;
    }

    // Código inline: o conteúdo é TEXTO PURO (sem parsing interno).
    if (ch === "`") {
      let ticks = 0;
      while (src[i + ticks] === "`") {
        ticks += 1;
        if (!spend(scan, 1)) break;
      }
      const fence = "`".repeat(ticks);
      const close = indexOfScanned(src, fence, i + ticks, scan);
      if (close !== -1) {
        nodes.push({ kind: "code", value: src.slice(i + ticks, close) });
        i = close + ticks;
        continue;
      }
    }

    // Imagem: NUNCA vira <img> — a sintaxe completa fica como texto inerte.
    if (ch === "!" && src[i + 1] === "[") {
      const labelEnd = indexOfScanned(src, "]", i + 2, scan);
      const parenOpen = labelEnd === -1 ? -1 : indexOfScanned(src, "(", labelEnd, scan);
      if (parenOpen === labelEnd + 1) {
        const close = findClosingParen(src, parenOpen, scan);
        if (close !== -1) {
          pushText(nodes, src.slice(i, close + 1));
          i = close + 1;
          continue;
        }
      }
      pushText(nodes, "!");
      i += 1;
      continue;
    }

    // Link: só vira <a> quando o destino passa na whitelist.
    if (ch === "[") {
      const labelEnd = indexOfScanned(src, "]", i + 1, scan);
      const parenOpen = labelEnd === -1 ? -1 : indexOfScanned(src, "(", labelEnd, scan);
      if (parenOpen === labelEnd + 1) {
        const close = findClosingParen(src, parenOpen, scan);
        if (close !== -1) {
          const rawLabel = src.slice(i + 1, labelEnd);
          const rawHref = src.slice(parenOpen + 1, close);
          if (isSafeExternalUrl(rawHref)) {
            nodes.push({
              kind: "link",
              href: rawHref,
              children: parseInline(rawLabel, depth + 1, scan),
            });
            i = close + 1;
            continue;
          }
          // Destino não aprovado: a sintaxe ORIGINAL fica como texto inerte.
          pushText(nodes, src.slice(i, close + 1));
          i = close + 1;
          continue;
        }
      }
      pushText(nodes, "[");
      i += 1;
      continue;
    }

    // Negrito: ** … **
    if (ch === "*" && src[i + 1] === "*") {
      if (canOpenEmphasis(src, i)) {
        const close = indexOfScanned(src, "**", i + 2, scan);
        if (close !== -1 && close > i + 2) {
          nodes.push({
            kind: "strong",
            children: parseInline(src.slice(i + 2, close), depth + 1, scan),
          });
          i = close + 2;
          continue;
        }
      }
      pushText(nodes, "**");
      i += 2;
      continue;
    }

    // Itálico: * … * e _ … _ (protegido de matemática/ snake_case).
    if ((ch === "*" || ch === "_") && canOpenEmphasis(src, i)) {
      const close = indexOfScanned(src, ch, i + 1, scan);
      if (close !== -1 && close > i + 1 && canCloseEmphasis(src, close + 1)) {
        nodes.push({
          kind: "emphasis",
          children: parseInline(src.slice(i + 1, close), depth + 1, scan),
        });
        i = close + 1;
        continue;
      }
    }

    // HTML bruto (<script>, <img onerror>, <a href=javascript:…>) NÃO tem
    // tratamento: cai como texto abaixo e React o renderiza escapado.
    pushText(nodes, ch);
    i += 1;
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Parser de blocos
// ---------------------------------------------------------------------------

/**
 * Cabeçalho: `^\s{0,3}(#{1,6})\s+(.*)$` — reconhece até 3 espaços, 1–6 `#`,
 * pelo menos um espaço e devolve o resto da linha. O marcador vira o nível.
 *
 * Substitui `HEADING_RE`, cujo `\s+(.*)$` reexaminava os espaços no backtracking
 * quando o conteúdo trazia U+2028/U+2029 (esses caracteres sobrevivem ao
 * `split("\n")`, mas `.` não os consome): custo quadrático, medido em 616ms com
 * 30k espaços. Aqui o índice só avança — uma passada, sem recuo.
 */
export type TedHeadingMatch = { level: 1 | 2 | 3 | 4 | 5 | 6; content: string };

function matchHeading(line: string): TedHeadingMatch | null {
  const start = skipIndent(line);
  if (start === -1) return null;

  let i = start;
  while (i < line.length && line[i] === "#") i++;
  const hashes = i - start;
  if (hashes < 1 || hashes > 6) return null;

  // `\s+`: ao menos um espaço entre o marcador e o texto.
  const contentStart = skipSpaces(line, i);
  if (contentStart === i) return null;

  // `(.*)$`: `.` não consome os separadores de linha U+2028/U+2029, então uma
  // linha que os contém no miolo nunca fecha o grupo. Preservar esse desfecho é
  // o que mantém a semântica do regex — e é justamente o caso patológico.
  if (!canMatchDotToEnd(line, contentStart)) return null;

  return { level: hashes as 1 | 2 | 3 | 4 | 5 | 6, content: line.slice(contentStart) };
}

/** Item de lista não-ordenada: `^\s{0,3}([-*+])\s+(.*)$`. */
export type TedListItemMatch = { marker: string; content: string };

function matchListItem(line: string): TedListItemMatch | null {
  const start = skipIndent(line);
  if (start === -1) return null;

  const marker = line[start]!;
  if (marker !== "-" && marker !== "*" && marker !== "+") return null;

  const contentStart = skipSpaces(line, start + 1);
  if (contentStart === start + 1) return null;
  if (!canMatchDotToEnd(line, contentStart)) return null;

  return { marker, content: line.slice(contentStart) };
}

/** Item de lista ordenada: `^\s{0,3}(\d{1,9})[.)]\s+(.*)$`. */
function matchOrderedListItem(line: string): TedListItemMatch | null {
  const start = skipIndent(line);
  if (start === -1) return null;

  let i = start;
  while (i < line.length && line.charCodeAt(i) >= 0x30 && line.charCodeAt(i) <= 0x39) i++;
  const digits = i - start;
  if (digits < 1 || digits > 9) return null;

  const delimiter = line[i];
  if (delimiter !== "." && delimiter !== ")") return null;

  const contentStart = skipSpaces(line, i + 1);
  if (contentStart === i + 1) return null;
  if (!canMatchDotToEnd(line, contentStart)) return null;

  return { marker: line.slice(start, i), content: line.slice(contentStart) };
}

/**
 * Consome até 3 espaços iniciais (o `\s{0,3}` dos três reconhecedores) e devolve
 * o índice do marcador, ou -1 quando a indentação passa de 3 — caso em que o
 * regex original recusava a linha.
 */
function skipIndent(line: string): number {
  let i = 0;
  let spaces = 0;
  while (i < line.length && isSpaceCode(line.charCodeAt(i))) {
    i++;
    spaces++;
    if (spaces > 3) return -1;
  }
  return i;
}

/**
 * Equivale ao fechamento de `(.*)$` a partir de `from`: o ponto do regex casa
 * com qualquer caractere EXCETO os separadores de linha (U+2028/U+2029 — `\n` e
 * `\r` já foram normalizados pelo split), e o `$` exige o fim da linha. Basta
 * procurar um separador no trecho restante: uma varredura limpa, sem backtracking.
 */
function canMatchDotToEnd(line: string, from: number): boolean {
  for (let i = from; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) return false;
  }
  return true;
}

/**
 * `\s` do JavaScript, enumerado pelo próprio engine (25 code points do BMP).
 * Reimplementado como predicado para que a varredura linear case EXATAMENTE o
 * mesmo conjunto que a classe do regex — inclusive U+00A0, U+2000–U+200A e
 * U+FEFF, que aparecem em texto copiado de navegador.
 */
export function isSpaceCode(code: number): boolean {
  if (code >= 0x09 && code <= 0x0d) return true; // TAB, LF, VT, FF, CR
  if (code === 0x20) return true;
  if (code === 0xa0) return true;
  if (code === 0x1680) return true;
  if (code >= 0x2000 && code <= 0x200a) return true;
  if (code >= 0x2028 && code <= 0x2029) return true;
  if (code === 0x202f || code === 0x205f || code === 0x3000) return true;
  if (code === 0xfeff) return true;
  return false;
}

/** Caractere de linguagem de fence: `[A-Za-z0-9_+-]`. */
function isFenceLangCode(code: number): boolean {
  if (code >= 0x30 && code <= 0x39) return true; // 0-9
  if (code >= 0x41 && code <= 0x5a) return true; // A-Z
  if (code >= 0x61 && code <= 0x7a) return true; // a-z
  return code === 0x5f || code === 0x2b || code === 0x2d; // _ + -
}

/** Consome espaços a partir de `i` e devolve o novo índice (lookahead O(1)). */
function skipSpaces(line: string, i: number): number {
  let j = i;
  while (j < line.length && isSpaceCode(line.charCodeAt(j))) j++;
  return j;
}

export type TedFenceMatch = { marker: string; language: string | null };

/**
 * Reconhece a LINHA DE ABERTURA de um bloco cercado, em varredura LINEAR.
 *
 * Substitui `FENCE_RE = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/`, cujos `\s*`
 * adjacentes disputavam os mesmos caracteres no backtracking: com n espaços o
 * custo era quadrático (~500ms com n=30000, medido) e rodava FORA do orçamento de
 * varredura do parser inline. Aqui cada caractere é examinado uma vez e o
 * resultado é o mesmo do regex, inclusive nos cantos que o teste congela
 * (marcador ` ou ~ de 3+, linguagem opcional, espaços nas pontas).
 */
function matchFence(line: string): TedFenceMatch | null {
  const start = skipSpaces(line, 0);
  const markerChar = line[start];
  if (markerChar !== "`" && markerChar !== "~") return null;

  let markerEnd = start;
  while (markerEnd < line.length && line[markerEnd] === markerChar) markerEnd++;
  if (markerEnd - start < 3) return null; // menos de 3 marcadores não abre bloco
  const marker = line.slice(start, markerEnd);

  // A linguagem só existe se não houver nada além de espaços até o fim da linha;
  // se o resto for lixo (ex.: `!`), a linha NÃO é fence — o mesmo desfecho do
  // regex, que falhava no `$` e não tinha como recuperar.
  let i = skipSpaces(line, markerEnd);
  const langStart = i;
  while (i < line.length && isFenceLangCode(line.charCodeAt(i))) i++;
  const rawLang = line.slice(langStart, i);

  if (skipSpaces(line, i) !== line.length) return null;
  return { marker, language: rawLang ? rawLang : null };
}

/**
 * Reconhece a LINHA SEPARADORA de tabela, em varredura LINEAR.
 *
 * Substitui `TABLE_DELIM_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/`, que tinha
 * os mesmos `\s*` adjacentes em disputa (custo quadrático também fora do orçamento
 * de varredura). Semântica preservada: zero ou mais espaços, pipe externo opcional,
 * células `:?-+:?` separadas por `|`, e nada mais na linha.
 */
function isTableDelimiterLine(line: string): boolean {
  let i = skipSpaces(line, 0);
  if (line[i] === "|") i = skipSpaces(line, i + 1);

  // Primeira célula: `:?-+:?` — o `-+` exige pelo menos um hífen.
  if (line[i] === ":") i++;
  let dashes = 0;
  while (i < line.length && line[i] === "-") {
    i++;
    dashes++;
  }
  if (dashes === 0) return false;
  if (line[i] === ":") i++;

  // Células seguintes: `(\|\s*:?-+:?\s*)*`. O laço só avança o índice de forma
  // monotônica — sem backtracking e sem reexaminar o que já foi consumido. Ao
  // não casar uma nova célula, o índice volta para o pipe em questão (não
  // depois dele): o pipe externo final é opcional e tratado na fase seguinte.
  for (;;) {
    const beforePipe = i;
    i = skipSpaces(line, i);
    if (line[i] !== "|") {
      i = beforePipe;
      break;
    }
    i = skipSpaces(line, i + 1);
    if (line[i] === ":") i++;
    let cellDashes = 0;
    while (i < line.length && line[i] === "-") {
      i++;
      cellDashes++;
    }
    if (cellDashes === 0) {
      i = beforePipe; // o `|` era o externo final, não um separador de célula
      break;
    }
    if (line[i] === ":") i++;
  }

  // Pipe externo final opcional + espaços, e nada mais até o fim da linha.
  i = skipSpaces(line, i);
  if (line[i] === "|") i = skipSpaces(line, i + 1);
  return i === line.length;
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) trimmed = trimmed.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Reconhece o início de uma tabela GFM: cabeçalho com pipe + separador válido
 * cuja contagem de células é COMPATÍVEL com a do cabeçalho.
 *
 * Sem essa comparação, `"a | b\n---"` (separador de 1 célula para um cabeçalho
 * de 2) virava tabela de verdade — inventando estrutura que o texto não tem. O
 * critério é tolerante como o GFM: basta o separador ter pelo menos as células do
 * cabeçalho (células de Align extras no separador não invalidam a tabela).
 */
function isTableStart(headerLine: string, delimiterLine: string): boolean {
  if (!headerLine.includes("|")) return false;
  if (!delimiterLine.includes("-") || !isTableDelimiterLine(delimiterLine)) return false;
  return splitTableRow(delimiterLine).length >= splitTableRow(headerLine).length;
}

/**
 * Reconhece a LINHA DE FECHAMENTO de um bloco cercado: espaços, marcador do
 * tipo `~` (ou `` ` ``) com pelo menos o comprimento do de abertura, espaços, fim.
 * Substitui o `closingRe` montado por concatenação (mesma semântica, sem regex).
 */
function isFenceClosingLine(line: string, marker: string): boolean {
  const markerChar = marker[0]!;
  const minLength = marker.length;
  let i = skipSpaces(line, 0);
  let run = 0;
  while (i < line.length && line[i] === markerChar) {
    i++;
    run++;
  }
  if (run < minLength) return false;
  return skipSpaces(line, i) === line.length;
}

/**
 * Parser de blocos. Função pura e determinística — memoizada por `content`
 * no componente (nenhum parser global, nenhum estado compartilhado).
 */
export function parseMarkdown(source: string): TedBlockNode[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: TedBlockNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Bloco de código cercado (``` ou ~~~): conteúdo é texto puro.
    const fence = matchFence(line);
    if (fence) {
      const { marker, language } = fence;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !isFenceClosingLine(lines[i]!, marker)) {
        body.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1; // consome a linha de fechamento
      blocks.push({
        kind: "codeBlock",
        value: body.length ? `${body.join("\n")}\n` : "",
        language,
      });
      continue;
    }

    const heading = matchHeading(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading.level, children: parseInline(heading.content.trim()) });
      i += 1;
      continue;
    }

    // Tabela GFM: cabeçalho + linha separadora. SEM separador não é tabela
    // (a linha cai como parágrafo — nenhuma tabela é inventada).
    const nextLine = i + 1 < lines.length ? lines[i + 1]! : "";
    if (isTableStart(line, nextLine)) {
      // `cell => parseInline(cell)`: `.map(parseInline)` passaria o ÍNDICE como
      // `depth` e a formatação dependeria da posição da coluna (a 10ª caía no
      // fallback literal).
      const header = splitTableRow(line).map((cell) => parseInline(cell));
      i += 2;
      const rows: TedInlineNode[][][] = [];
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) {
        rows.push(splitTableRow(lines[i]!).map((cell) => parseInline(cell)));
        i += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    const unorderedItem = matchListItem(line);
    const orderedItem = unorderedItem ? null : matchOrderedListItem(line);
    if (unorderedItem || orderedItem) {
      // O tipo de item é fixado pela PRIMEIRA linha; a lista consome só linhas do
      // mesmo tipo (mesma regra do `itemRe` anterior).
      const matchItem = orderedItem ? matchOrderedListItem : matchListItem;
      const items: TedInlineNode[][] = [];
      while (i < lines.length) {
        const match = matchItem(lines[i]!);
        if (!match) break;
        items.push(parseInline(match.content));
        i += 1;
      }
      blocks.push({ kind: "list", ordered: Boolean(orderedItem), items });
      continue;
    }

    // Parágrafo: acumula até linha vazia ou início de outro bloco.
    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim()) {
      const current = lines[i]!;
      if (
        paragraph.length > 0 &&
        (matchHeading(current) !== null ||
          matchListItem(current) !== null ||
          matchOrderedListItem(current) !== null ||
          matchFence(current) !== null)
      ) {
        break;
      }
      const lookahead = i + 1 < lines.length ? lines[i + 1]! : "";
      // Mesma condição do início de tabela: um separador incompatível NÃO deve
      // quebrar o parágrafo (a linha permanece texto, como manda o GFM).
      if (paragraph.length > 0 && isTableStart(current, lookahead)) {
        break;
      }
      paragraph.push(current);
      i += 1;
    }
    blocks.push({ kind: "paragraph", children: parseInline(paragraph.join("\n")) });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Render (elementos React — nunca innerHTML)
// ---------------------------------------------------------------------------

/** Hierarquia decrescente e consistente, sem h1–h6 reais (outline limpo). */
const HEADING_CLASSES: Record<number, string> = {
  1: "mt-2 mb-1 text-[15px] font-bold leading-snug text-text-primary first:mt-0",
  2: "mt-2 mb-1 text-[14px] font-bold leading-snug text-text-primary first:mt-0",
  3: "mt-1.5 mb-1 text-[13.5px] font-semibold leading-snug text-text-primary first:mt-0",
  4: "mt-1.5 mb-0.5 text-[13.5px] font-semibold leading-snug text-text-secondary first:mt-0",
  5: "mt-1 mb-0.5 text-[12.5px] font-semibold leading-snug text-text-secondary first:mt-0",
  6: "mt-1 mb-0.5 text-[12px] font-semibold uppercase tracking-wide text-text-muted first:mt-0",
};

const LINK_CLASSES =
  "rounded-[3px] font-medium text-primary underline decoration-primary/40 underline-offset-2 break-all hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

function renderInline(nodes: TedInlineNode[]): ReactNode {
  return nodes.map((node, index) => {
    const key = `${node.kind}-${index}`;
    switch (node.kind) {
      case "text":
        return <Fragment key={key}>{node.value}</Fragment>;
      case "strong":
        return (
          <strong key={key} className="font-bold text-text-primary">
            {renderInline(node.children)}
          </strong>
        );
      case "emphasis":
        return <em key={key}>{renderInline(node.children)}</em>;
      case "code":
        return (
          <code
            key={key}
            className="rounded-[4px] bg-surface-1 px-1 py-px font-mono text-[12px] text-text-primary"
          >
            {node.value}
          </code>
        );
      case "link":
        return (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className={LINK_CLASSES}
          >
            {renderInline(node.children)}
          </a>
        );
      case "break":
        return <br key={key} />;
    }
  });
}

function renderBlock(block: TedBlockNode, index: number): ReactNode {
  const key = `${block.kind}-${index}`;
  switch (block.kind) {
    case "paragraph":
      return <p key={key}>{renderInline(block.children)}</p>;
    case "heading":
      return (
        <p key={key} role="heading" aria-level={block.level} className={HEADING_CLASSES[block.level]}>
          {renderInline(block.children)}
        </p>
      );
    case "codeBlock":
      return (
        <div key={key} className="my-1.5 overflow-x-auto">
          <pre
            data-language={block.language ?? undefined}
            className="overflow-x-auto whitespace-pre rounded-[10px] border border-border-subtle bg-surface-1 p-2.5 font-mono text-[12px] leading-relaxed text-text-primary"
          >
            <code>{block.value}</code>
          </pre>
        </div>
      );
    case "list":
      return block.ordered ? (
        <ol key={key} className="my-1 list-decimal space-y-0.5 pl-4 marker:text-text-muted">
          {block.items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`}>{renderInline(item)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key} className="my-1 list-disc space-y-0.5 pl-4 marker:text-text-muted">
          {block.items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`}>{renderInline(item)}</li>
          ))}
        </ul>
      );
    case "table":
      return (
        // R05: scroll no contêiner + quebra de palavra/URL dentro da tabela.
        <div key={key} className="my-1.5 overflow-x-auto">
          <table className="w-full min-w-[280px] border-collapse text-[12.5px]">
            <thead>
              <tr>
                {block.header.map((cell, cellIndex) => (
                  <th
                    key={`${key}-th-${cellIndex}`}
                    scope="col"
                    className="break-words border-b border-border-subtle px-2 py-1.5 text-left font-bold text-text-secondary"
                  >
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${key}-tr-${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`${key}-td-${rowIndex}-${cellIndex}`}
                      className="break-words border-b border-border-subtle/60 px-2 py-1.5 align-top text-text-primary"
                    >
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/**
 * R05: Markdown restrito para mensagens do ASSISTENTE. Mensagem de usuário e
 * de membro NUNCA passam por aqui (permanecem texto literal em `TedMessage`).
 *
 * Streaming: hoje não existe renderização parcial — o turno chega inteiro do
 * Agent e só então a mensagem entra no log (caracterizado em
 * `TedChat.optimistic.test.tsx`). O renderer não tem estado intermediário,
 * logo não existe caminho que exiba claim antes da verificação.
 */
export function TedMarkdown({ content }: { content: string }) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);
  return <>{blocks.map((block, index) => renderBlock(block, index))}</>;
}