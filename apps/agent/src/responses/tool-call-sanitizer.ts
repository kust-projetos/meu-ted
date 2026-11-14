/**
 * TEDV3-003 deterministic defense (#2): neutralize model-emitted
 * tool-invocation markup before it reaches the user as message text.
 *
 * Finding (evals/reports/ted-v3-real-model-evals-2026-09-15.md, TEDV3-003):
 * on ambiguous grounded reads whose evidence is ok but not deterministically
 * renderable, small chat-completions models (glm-5.3-flash, deepseek-flash)
 * answer by printing tool-call markup (`<tool_call>…</tool_call>` and
 * variants) as reply text, trying to invoke tools that are NOT bound on the
 * read path. Grounding contains the numeric damage, but the raw markup still
 * reached the user. Defense #1 is the prompt instruction
 * (`TED_RESPONSE_DISCIPLINE` in agent-config/instructions.ts); this module
 * is defense #2 and must stay deterministic — no model in the loop.
 *
 * HEURISTIC - remove invocation-shaped markup at message boundaries, and
 * neutralize tool-call markers in ordinary prose without consuming the
 * surrounding text. Fenced citations remain verbatim unless they are
 * invocation-shaped JSON payloads at a message boundary:
 *   1. `<tool_call>…</tool_call>` pairs (repeated, whitespace or JSON
 *      arguments inside);
 *   2. a leading `<tool_call>` with NO closing tag anywhere (truncated
 *      dump) — the remainder of the message is consumed;
 *   3. special-token variants `<|tool_call|>` / `<|tool▁call|>` (U+2581),
 *      consuming an optional balanced JSON object and at most one following
 *      `<|…|>` special token (e.g. `<|end|>`);
 *   4. fenced code blocks whose body parses as a tool-call JSON object
 *      (string `name`, or `function.name`; optional `arguments`/
 *      `parameters`) are removed at a boundary. Fenced literal tool-call
 *      markup and other non-payload code are preserved verbatim.
 *
 * Markers recognized by the module (`<tool_call>`, `[TOOL_CALL]`, and
 * special-token variants) are removed from ordinary prose, preserving all
 * text around them. Thus a literal citation in a fence is retained while an
 * executable-looking marker cannot pass through normal text.
 *
 * Cost is trivial: sticky boundary regexes plus a bounded balanced-brace
 * scan per block; untrusted input larger than MAX_SANITIZE_INPUT chars is
 * returned unchanged (provider output is already capped at 20_000 chars
 * upstream in provider-adapter.ts).
 */

export type ToolCallSanitizeResult = Readonly<{
  /** Text after removing anchored invocation blocks (trimmed). */
  text: string;
  /** How many invocation blocks were removed. */
  removedBlocks: number;
  /** True when at least one block was removed. */
  changed: boolean;
}>;

const MAX_SANITIZE_INPUT = 200_000;
/** Upper bound for the balanced JSON scan inside a single block. */
const MAX_JSON_SCAN = 4_096;
/** Window for the closing special token after a leading `<|tool_call|>`. */
const SPECIAL_PAYLOAD_WINDOW = 512;
/** Bounded number of removable blocks per message (defensive loop guard). */
const MAX_REMOVED_BLOCKS = 64;

const OPEN_TAG = '<tool_call>';
const CLOSE_TAG = '</tool_call>';

const LEADING_PAIR = /^<tool_call>[\s\S]*?<\/tool_call>/;
const LEADING_TRUNCATED = /^<tool_call>(?![\s\S]*<\/tool_call>)/;
const LEADING_SPECIAL = /^<\|tool[_\u2581]call\|>/;
const SPECIAL_TOKEN = /^<\|[^|<>]{1,32}\|>/;
const FENCE = /^```[ \t]*[A-Za-z0-9_-]*[ \t]*\r?\n[\s\S]*?\r?\n?```/;
const isToolCallPayload = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.name === 'string' && record.name.trim() !== '') return true;
  const fn = record.function;
  return typeof fn === 'object' && fn !== null && typeof (fn as Record<string, unknown>).name === 'string';
};

/** End index (exclusive) of the balanced JSON object starting at `start`, or -1. */
const balancedJsonObjectEnd = (text: string, start: number): number => {
  if (text[start] !== '{') return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  const limit = Math.min(text.length, start + MAX_JSON_SCAN);
  for (let index = start; index < limit; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
};

const skipWhitespace = (text: string, from: number): number => {
  let index = from;
  while (index < text.length && /\s/.test(text[index]!)) index += 1;
  return index;
};

/** True only when the fenced block parses as an invocation-shaped JSON payload. */
const isToolCallFence = (fence: string): boolean => {
  const bodyStart = fence.indexOf('\n') + 1;
  const bodyEnd = fence.lastIndexOf('```');
  if (bodyStart <= 0 || bodyEnd <= bodyStart) return false;
  const body = fence.slice(bodyStart, bodyEnd).trim();
  if (!body.startsWith('{')) return false;
  const end = balancedJsonObjectEnd(body, 0);
  if (end !== body.length) return false;
  try {
    return isToolCallPayload(JSON.parse(body));
  } catch {
    // Not JSON: legitimate code block — keep it.
    return false;
  }
};

/** Length of one leading invocation segment, or 0 when none matches. */
const leadingSegmentLength = (text: string): number => {
  const pair = LEADING_PAIR.exec(text);
  if (pair) return pair[0].length;
  if (LEADING_TRUNCATED.test(text)) return text.length;
  const special = LEADING_SPECIAL.exec(text);
  if (special) {
    let cursor = skipWhitespace(text, special[0].length);
    const jsonEnd = balancedJsonObjectEnd(text, cursor);
    if (jsonEnd > 0) cursor = skipWhitespace(text, jsonEnd);
    const tail = SPECIAL_TOKEN.exec(text.slice(cursor));
    if (tail) return cursor + tail[0].length;
    // Bare-name payloads ("check_budgets<|end|>"): when the open token is
    // NOT followed by a JSON object, everything up to the NEXT special
    // token (bounded window) is the invocation payload — consume through
    // it. Without a closing token only the open token is removed, so
    // ordinary prose after a lone `<|tool_call|>` survives.
    if (jsonEnd < 0) {
      const window = text.slice(cursor, cursor + SPECIAL_PAYLOAD_WINDOW);
      const closing = /<\|[^|<>]{1,32}\|>/.exec(window);
      if (closing) return cursor + closing.index + closing[0].length;
    }
    return cursor;
  }
  const fence = FENCE.exec(text);
  if (fence && isToolCallFence(fence[0])) return fence[0].length;
  return 0;
};

/**
 * Length of one trailing invocation segment, or 0 when none matches.
 * Only the INNERMOST pair at the tail is taken (the content between the
 * last opener and the final closer), so prose between two separate pairs
 * is never swallowed.
 */
const trailingSegmentLength = (text: string): number => {
  const closeIndex = text.lastIndexOf(CLOSE_TAG);
  if (closeIndex >= 0 && text.slice(closeIndex + CLOSE_TAG.length).trim() === '') {
    const openIndex = text.lastIndexOf(OPEN_TAG, closeIndex);
    if (openIndex >= 0 && !text.slice(openIndex + OPEN_TAG.length, closeIndex).includes(CLOSE_TAG)) {
      return text.length - openIndex;
    }
  }
  const closing = text.lastIndexOf('```');
  if (closing >= 0 && text.slice(closing + 3).trim() === '') {
    const opener = text.lastIndexOf('```', closing - 1);
    if (opener >= 0 && (opener === 0 || /\s/.test(text[opener - 1]!))) {
      const fence = text.slice(opener, closing + 3);
      if (isToolCallFence(fence)) return text.length - opener;
    }
  }
  const special = /<\|tool[_\u2581]call\|>[ \t\r\n]*$/.exec(text);
  if (special) return special[0].length;
  return 0;
};

/**
 * Deterministically removes anchored tool-invocation markup from model text.
 * See the module heuristic comment: boundary-anchored, invocation-shaped
 * segments only; mid-prose occurrences (quotes, explanations) survive.
 */
export const stripToolCallMarkup = (raw: string): ToolCallSanitizeResult => {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_SANITIZE_INPUT) {
    return { text: typeof raw === 'string' ? raw : '', removedBlocks: 0, changed: false };
  }
  let text = raw.trim();
  let removedBlocks = 0;
  while (text.length > 0 && removedBlocks < MAX_REMOVED_BLOCKS) {
    const lead = leadingSegmentLength(text);
    if (lead > 0) {
      text = text.slice(lead).trim();
      removedBlocks += 1;
      continue;
    }
    const tail = trailingSegmentLength(text);
    if (tail > 0) {
      text = text.slice(0, text.length - tail).trim();
      removedBlocks += 1;
      continue;
    }
    break;
  }
  // Fenced code is quoted content: sanitize only the prose between fences.
  const parts = text.split(/(```[\s\S]*?```)/g);
  for (let index = 0; index < parts.length; index += 1) {
    if (index % 2 !== 0) continue;
    const sanitized = parts[index]!.replace(
      /<\/?tool_call>|\[\/?TOOL_CALL\]|<\|tool[_\u2581?]call\|>|<\|\/?tool[_\u2581?]call\|>/gi,
      '',
    );
    if (sanitized !== parts[index]) {
      parts[index] = sanitized;
      removedBlocks += 1;
    }
  }
  text = parts.join('');
  return { text, removedBlocks, changed: removedBlocks > 0 };
};
