// TED prompt adapter — P1 product (OpenCode SDK 2.2.4 facts only).
//
// Exact 2.2.4 API surface used here (no newer SDK, no V1 names):
//   - `OpenCode.create(...)` / `oc.close()` lifecycle (see bootstrap).
//   - `oc.session.prompt({ sessionID, id?, text })` admits a user message
//     and returns the admitted SessionInboxUser
//     `{ id, sessionID, time: { created: number }, type: 'user', payload,
//       delivery }` — NOT the assistant output.
//   - `oc.message.list({ sessionID, limit, order, cursor, type })` returns
//     `{ data: SessionMessageInfo[], cursor: { previous, next } }`; the
//     adapter re-reads NATIVE history (order 'asc') and projects ONLY the
//     assistant text AFTER the admitted user id. It never fabricates output
//     text: when no assistant message is observable (provider absent/denied,
//     empty result), the turn fails with a typed error (no fake success, no
//     paid-inference retry, no silent second prompt). `oc.session.context`
//     returns an array (context query, not a turn result) — never output.
//     `event.subscribe` returns an AsyncIterable (never awaited here — the
//     adapter polls message history with explicit id correlation instead).
//   - The effective tool catalog is available ONLY inside plugin context
//     via `ctx.tool.list()` (see `getEffectiveToolNames` in plugin.mjs);
//     the HTTP SDK surface has no tool group — there is nothing to
//     enumerate from the gateway process.
//   - `RequestOptions.signal` is LOCAL request cancellation only: aborting
//     it stops the gateway wait, but the server-side run continues until
//     `oc.session.interrupt({ sessionID })` is issued. The adapter maps an
//     aborted caller signal to abort → interrupt, surfaced as
//     `prompt.cancelled`. There is no `session.abort` in 2.2.4.
//   - If a provider is absent/denied, the adapter returns a typed error
//     (`provider.unavailable` / `provider.denied`) and never invokes paid
//     inference as a fallback.
//   - Native idempotency is NOT verified in 2.2.4: a repeated intentionId
//     canNOT be proven to dedup server-side, so duplicates fail closed
//     (`prompt.duplicate`) instead of issuing a second prompt.
//   - PROCESS-LOCAL ONLY: the seen-intention registry below dies with the
//     process. Cross-restart replay protection lives in the conversation
//     registry (conversations.mjs intentions — id/status metadata only),
//     enforced by the gateway BEFORE this host is ever called.

export class PromptError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PromptError';
    this.code = code;
    this.details = details;
  }
}

// Turn diagnostics (Etapa C-WIRE): observation-only boundary events for the
// real SDK path. The sink is OFF unless explicitly provided (unit doubles
// stay silent); the gateway entrypoint provides it. Events share the
// per-turn opaque correlation threaded via `diagnosticCorrelationId` (a
// valid UUID is reused, anything else mints fresh — never derived from
// turn identifiers). Emission never changes behavior: sink failures are
// swallowed, the original error is rethrown unchanged, and no second
// native prompt is ever issued.
import {
  classifyTerminalCause as classifyDiagCause,
  createDiagnosticContext,
} from './diagnostics.mjs';

function diagContextFor(sink, diagnosticCorrelationId) {
  if (typeof sink !== 'function') return null;
  return createDiagnosticContext({ sink, correlationId: diagnosticCorrelationId });
}

function noteDiagFailure(diag, e) {
  if (!diag) return;
  try {
    const c = classifyDiagCause(e);
    diag.emit({ phase: c.phase, outcome: 'failure', cause: c.cause, httpStatus: c.httpStatus });
  } catch { /* diagnostics never alter the turn */ }
}

// Native history paging bounds (pinned 2.2.4 `message.list` contract:
// `{ sessionID, limit, order?, cursor?, type? }` → `{ data, cursor }` where
// `cursor` is `{ previous, next }` with opaque cursors. The server encodes
// order/direction in each cursor and rejects a request that combines `order`
// with `cursor`; only the first page sends order, later pages send cursor only.
// A single page is 50 rows; a bounded read walks at most 10 pages / 500
// rows total. Past that the read fails closed with `prompt.history_overflow`
// — history is NEVER silently truncated (a cut transcript would fabricate
// a false turn or hide the admitted message).
//
// P2-TODO (bounded history, no behavior change): if transcripts ever need to
// grow past MESSAGE_MAX_TOTAL, page the NATIVE SDK cursor incrementally
// (opaque `cursor` chaining, same fail-closed overflow) and render the PWA
// list incrementally (append-only newest-first) instead of raising this
// bound. No unlimited read is authorized here.
export const MESSAGE_PAGE_LIMIT = 50;
export const MESSAGE_MAX_PAGES = 10;
export const MESSAGE_MAX_TOTAL = 500;
// Current-turn polling reads at most 3 recent pages (≤150 rows) per wait
// round: the admitted turn is always at the recent end, so polling never
// re-walks the whole transcript every 250ms.
export const POLL_MAX_PAGES = 3;

// Fixed client-facing message for history-origin failures (P2-R-FIX2).
// History errors never carry native detail to the browser: the raw SDK
// exception text stays server-side (logs only) — the client sees ONLY this.
export const HISTORY_UNAVAILABLE_MESSAGE =
  'history temporarily unavailable — please retry; completed turns stand';

function isoCreated(time) {
  const created = time && typeof time.created === 'number' ? time.created : NaN;
  if (!Number.isFinite(created)) return undefined;
  try {
    return new Date(created).toISOString();
  } catch {
    return undefined;
  }
}

// Projects native message history (EXACT 2.2.4 union) into PWA history
// items. Pure, exported for tests and reused by the gateway history route.
//   - user: `{ id, type: 'user', text, time: { created: number } }`.
//   - assistant: `{ id, type: 'assistant', content: [{ type: 'text', text }],
//     time: { created: number } }` — only `text` parts; reasoning/tool parts
//     are never user-visible content.
//   - `userMeta` (optional): `{ [nativeUserId]: { intentionId?, actorId? } }`
//     built server-side from the persisted intention registry
//     (`userMessageId -> PWA intentionId`, author `actorId` — ids only, no
//     text/output/token). A mapped user item carries its PWA `intentionId`
//     (identity correlation for PWA reload anchors, which use the PWA id
//     while the admitted native id may differ) and its own author `actorId`
//     (collective workspace visibility must not rewrite a second member's
//     message to the conversation owner). Unmapped user rows fall back to
//     `ownerActor` with no `intentionId`.
// Unknown shapes (system/skill/shell/compaction/idle/switched rows, legacy
// `{ role, parts }` rows that never existed in 2.2.4) are skipped — never
// fabricated. `isOwn` is viewer-relative for user rows: the PWA derives its
// "Você" label from it, so it compares the message's author against the
// verified viewer (`viewerActor`, the freshly API-revalidated
// `identity.actorId` passed by the gateway). Without a viewer (legacy
// records/tests) user rows keep the prior `true`.
// Assistant rows are never own.
export function projectHistoryItems(nativeMessages, { ownerActor, userMeta, viewerActor } = {}) {
  const rows = Array.isArray(nativeMessages) ? nativeMessages : nativeMessages?.data;
  if (!Array.isArray(rows)) return [];
  const items = [];
  for (const m of rows) {
    if (!m || typeof m !== 'object') continue;
    const id = typeof m.id === 'string' && m.id.length > 0 ? m.id : null;
    if (!id) continue;
    if (m.type === 'user') {
      if (typeof m.text !== 'string' || m.text.trim().length === 0) continue;
      const meta = userMeta && typeof userMeta === 'object' ? userMeta[id] : null;
      const mappedIntention = meta && typeof meta === 'object' && typeof meta.intentionId === 'string' && meta.intentionId.length > 0
        ? meta.intentionId
        : null;
      const mappedActor = meta && typeof meta === 'object' && typeof meta.actorId === 'string' && meta.actorId.length > 0
        ? meta.actorId
        : null;
      const authorId = mappedActor ?? (typeof ownerActor === 'string' && ownerActor.length > 0 ? ownerActor : 'unknown');
      items.push({
        id,
        actorId: authorId,
        role: 'user',
        content: m.text,
        createdAt: isoCreated(m.time),
        isOwn: typeof viewerActor === 'string' && viewerActor.length > 0 ? authorId === viewerActor : true,
        ...(mappedIntention !== null ? { intentionId: mappedIntention } : {}),
      });
      continue;
    }
    if (m.type === 'assistant') {
      const parts = Array.isArray(m.content) ? m.content : [];
      const texts = [];
      for (const p of parts) {
        if (p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string') texts.push(p.text);
      }
      const content = texts.join('').trim();
      if (!content) continue;
      items.push({
        id,
        actorId: 'ted',
        role: 'assistant',
        content,
        createdAt: isoCreated(m.time),
        isOwn: false,
      });
      continue;
    }
    // system/skill/shell/compaction/idle/switched/legacy rows: skipped.
  }
  return items;
}

// Assistant text of ONE turn: strictly after the admitted user message id
// (native array order is time order — callers read with order 'asc') and
// BEFORE the next user message (the current turn boundary). Anything at or
// before the admitted id (older turns, pre-prompt snapshot rows) and anything
// from a later turn is never returned: when the admitted id is not yet
// visible, there is no output yet. Retrying an older intention therefore
// replays only its own turn, never later unrelated turns.
// Exported for the gateway replay path (completed-intention rebuild).
export function assistantTextAfterAdmitted(rows, admittedId) {
  if (!Array.isArray(rows) || typeof admittedId !== 'string' || admittedId.length === 0) {
    return { text: '', turnId: null };
  }
  const idx = rows.findIndex((m) => m && typeof m === 'object' && m.id === admittedId);
  if (idx === -1) return { text: '', turnId: null };
  let out = '';
  let turnId = null;
  for (const m of rows.slice(idx + 1)) {
    if (!m || typeof m !== 'object') continue;
    // A subsequent user message opens a NEW turn: stop (never bleed a
    // later turn's answer into this turn's output).
    if (m.type === 'user') break;
    if (m.type !== 'assistant') continue;
    const parts = Array.isArray(m.content) ? m.content : [];
    for (const p of parts) {
      if (p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string') out += p.text;
    }
    if (typeof m.id === 'string' && m.id.length > 0) turnId = m.id;
  }
  return { text: out, turnId };
}

// Terminal provider-transport marker persisted by the SDK as an assistant
// row with `finish: 'error'` and `error.type: 'provider.transport'` (2.2.4
// native history; content is empty, cost/tokens null). Pure predicate so
// both the live poll, the gateway pending-retry recovery, and any future
// replay path agree on the shape. ONLY this exact shape surfaces
// `provider.transport` — assistant rows without text and without
// `finish:'error'` keep the existing `prompt.no_output` path, and raw native
// detail (message/body/request/secret) never leaves this module: the caller
// throws a FIXED safe message.
export function isProviderTransportTerminal(m) {
  return (
    !!m &&
    typeof m === 'object' &&
    m.type === 'assistant' &&
    m.finish === 'error' &&
    !!m.error &&
    typeof m.error === 'object' &&
    m.error.type === 'provider.transport'
  );
}

// oc: live OpenCode SDK host (or double with session.prompt /
// session.interrupt / message.list). Seen-intention registry is
// process-local: a repeated intentionId fails closed — the adapter never
// issues a second native prompt for one PWA intention.
// diagnosticsSink (optional): when a function, the turn emits bounded
// observation-only events (admit + terminal) sharing the per-turn opaque
// correlation (`diagnosticCorrelationId` per call). Undefined keeps the
// host silent.
export function createPromptHost({ oc, timeoutMs = 60000, pollIntervalMs = 250, diagnosticsSink } = {}) {
  if (!oc || typeof oc !== 'object') {
    throw new PromptError('prompt.invalid_args', 'prompt host requires an OpenCode host (oc)');
  }
  const seen = new Set(); // intentionId -> 'pending' | 'done'
  const pending = new Set();

  function requireSessionShape() {
    if (!oc.session || typeof oc.session.prompt !== 'function') {
      throw new PromptError('provider.unavailable', 'prompt loop unavailable: session.prompt is not present on this host');
    }
  }

  // One native history page. Returns { rows, next } where `next` is the
  // opaque cursor for the following page or null when exhausted (a
  // cursorless envelope — bare array, missing/null cursor — is one page).
  // Returns null when there is no message surface at all.
  async function fetchHistoryPage(sessionID, { order = 'asc', limit = MESSAGE_PAGE_LIMIT, cursor } = {}) {
    if (!oc.message || typeof oc.message.list !== 'function') return null;
    const page = await oc.message.list({
      sessionID,
      limit,
      ...(cursor !== undefined ? { cursor } : { order }),
    });
    const rows = Array.isArray(page) ? page : page?.data;
    if (!Array.isArray(rows)) return null;
    const rawNext = !Array.isArray(page) && page && typeof page === 'object' && page.cursor && typeof page.cursor === 'object'
      ? page.cursor.next
      : undefined;
    return { rows, next: typeof rawNext === 'string' ? rawNext : null };
  }

// Bounded full-history read (ascending, order preserved). Walks at most
// MESSAGE_MAX_PAGES non-empty pages / MESSAGE_MAX_TOTAL rows, plus the SDK's
// final empty cursor page when the last non-empty page still carries `next`;
// past either data bound it throws prompt.history_overflow, never truncating.
  // `rowLimit` caps the returned rows for callers that only need a prefix.
  async function readAllMessages(sessionID, { order = 'asc', rowLimit = MESSAGE_MAX_TOTAL } = {}) {
    const out = [];
    const seenNext = new Set();
    const seenIds = new Set();
    let cursor;
    let pages = 0;
    for (;;) {
      const fetched = await fetchHistoryPage(sessionID, { order, limit: MESSAGE_PAGE_LIMIT, ...(cursor !== undefined ? { cursor } : {}) });
      if (fetched === null) {
        if (out.length === 0) return null;
        throw new PromptError('history.unavailable', HISTORY_UNAVAILABLE_MESSAGE);
      }
      // Corruption guards (fail closed, never silently incomplete/duplicated):
      // duplicate native message IDs across (or within) cursor pages mean the
      // pages overlap or the transcript forked — refusing to merge them.
      for (const m of fetched.rows) {
        const id = m && typeof m === 'object' && typeof m.id === 'string' && m.id.length > 0 ? m.id : null;
        if (id === null) continue;
        if (seenIds.has(id)) {
          throw new PromptError('prompt.history_overflow', 'conversation history pages repeat a message id — refusing to merge a looped transcript');
        }
        seenIds.add(id);
      }
      out.push(...fetched.rows);
      if (out.length > MESSAGE_MAX_TOTAL) {
        throw new PromptError('prompt.history_overflow', `conversation history exceeds ${MESSAGE_MAX_TOTAL} messages — refusing to truncate silently`);
      }
      pages++;
      if (pages > MESSAGE_MAX_PAGES && fetched.rows.length > 0) {
        throw new PromptError('prompt.history_overflow', `conversation history exceeds ${MESSAGE_MAX_PAGES} pages — refusing to truncate silently`);
      }
      if (fetched.next == null) break;
      // No-progress guard: an empty page with a continuation cursor, or a
      // repeated opaque cursor, means the pager is looped — fail fast instead
      // of walking all 10 pages before overflowing.
      if (fetched.rows.length === 0) {
        throw new PromptError('prompt.history_overflow', 'conversation history page made no progress — refusing to follow a looped cursor');
      }
      if (seenNext.has(fetched.next)) {
        throw new PromptError('prompt.history_overflow', 'conversation history cursor repeated — refusing to follow a looped cursor');
      }
      seenNext.add(fetched.next);
      cursor = fetched.next;
    }
    return out.slice(0, rowLimit);
  }

  // Current-turn poll over a BOUNDED recent window: walks newest-first
  // (order 'desc') and stops at the page containing the admitted id, so a
  // long transcript is never re-fetched whole every 250ms. Returns the
  // admitted turn's text (stopping at the next user message — the turn
  // boundary) or { text: '', turnId: null } when the admitted id (or its
  // answer) is not observable yet. Returns null when there is no surface.
  async function pollTurnOutput(sessionID, admittedId) {
    const newerDesc = [];
    const seenNext = new Set();
    const seenIds = new Set();
    let cursor;
    let found = false;
    for (let p = 0; p < POLL_MAX_PAGES; p++) {
      const fetched = await fetchHistoryPage(sessionID, { order: 'desc', limit: MESSAGE_PAGE_LIMIT, ...(cursor !== undefined ? { cursor } : {}) });
      if (fetched === null) return null;
      for (const m of fetched.rows) {
        const id = m && typeof m === 'object' && typeof m.id === 'string' && m.id.length > 0 ? m.id : null;
        if (id === null) continue;
        if (seenIds.has(id)) {
          throw new PromptError('prompt.history_overflow', 'conversation history pages repeat a message id — refusing to merge a looped transcript');
        }
        seenIds.add(id);
      }
      const idx = fetched.rows.findIndex((m) => m && typeof m === 'object' && m.id === admittedId);
      if (idx !== -1) {
        newerDesc.push(...fetched.rows.slice(0, idx));
        found = true;
        break;
      }
      newerDesc.push(...fetched.rows);
      if (fetched.next == null) break;
      if (fetched.rows.length === 0) {
        throw new PromptError('prompt.history_overflow', 'conversation history page made no progress — refusing to follow a looped cursor');
      }
      if (seenNext.has(fetched.next)) {
        throw new PromptError('prompt.history_overflow', 'conversation history cursor repeated — refusing to follow a looped cursor');
      }
      seenNext.add(fetched.next);
      cursor = fetched.next;
    }
    if (!found) return { text: '', turnId: null, terminalError: null };
    // Oldest→newest among the rows newer than the admitted message, then
    // the turn boundary: a subsequent user message ends this turn.
    let out = '';
    let turnId = null;
    let terminalError = null;
    for (const m of newerDesc.reverse()) {
      if (!m || typeof m !== 'object') continue;
      if (m.type === 'user') break;
      if (m.type !== 'assistant') continue;
      if (isProviderTransportTerminal(m)) {
        terminalError = 'provider.transport';
        continue;
      }
      const parts = Array.isArray(m.content) ? m.content : [];
      for (const part of parts) {
        if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') out += part.text;
      }
      if (typeof m.id === 'string' && m.id.length > 0) turnId = m.id;
    }
    return { text: out, turnId, terminalError };
  }

  async function interrupt(sessionID) {
    if (oc.session && typeof oc.session.interrupt === 'function') {
      await oc.session.interrupt({ sessionID }).catch(() => {});
      return true;
    }
    return false;
  }

  return {
    // intentionId: stable PWA id (SPEC §7.7). It travels as the native
    // prompt `id` ONLY when it satisfies the native Session.Message.ID
    // shape (`msg_*`, the only id the 2.2.4 admission accepts); otherwise
    // the native side mints the id and this host correlates via the
    // admitted receipt (admitted.id -> userMessageId) instead of failing.
    // Either way the same PWA intention never issues a second native
    // prompt (seen-set + persisted intention registry).
    // Returns { turnId, output, userMessageId }. Throws typed PromptError, never ''.
    async chat({ sessionID, text, intentionId, signal, diagnosticCorrelationId } = {}) {
      if (typeof sessionID !== 'string' || sessionID.length === 0) {
        throw new PromptError('prompt.invalid_args', 'sessionID is required');
      }
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw new PromptError('prompt.invalid_args', 'text (non-empty) is required');
      }
      if (typeof intentionId !== 'string' || intentionId.length === 0) {
        throw new PromptError('prompt.invalid_args', 'stable intentionId is required (never a second prompt without identity)');
      }
      if (seen.has(intentionId) || pending.has(intentionId)) {
        throw new PromptError('prompt.duplicate', 'intention already submitted — duplicate fails closed (no second prompt issued)');
      }
      requireSessionShape();
      if (signal && signal.aborted) {
        throw new PromptError('prompt.cancelled', 'turn cancelled before prompt');
      }
      // Per-turn diagnostic context (null when the sink is off). The
      // correlation is the threaded opaque UUID when valid, else fresh —
      // never derived from session/intention/message IDs.
      const diag = diagContextFor(diagnosticsSink, diagnosticCorrelationId);

      pending.add(intentionId);
      let interrupted = false;
      const interruptOnce = async () => {
        if (interrupted) return;
        interrupted = true;
        await interrupt(sessionID).catch(() => {});
      };
      const onAbort = () => {
        interruptOnce().catch(() => {});
      };
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const deadline = Date.now() + timeoutMs;
      // Post-admission failures carry the admitted native id in details so
      // the gateway can persist it (pending + userMessageId) and correlate
      // a retry WITHOUT resubmitting. The status stays pending — the turn
      // may still be running server-side. Declared BEFORE first use (no TDZ):
      // admittedId is assigned once the prompt admits.
      let admittedId = null;
      const failAfterAdmit = (code, message) => {
        const err = new PromptError(code, message);
        if (typeof admittedId === 'string' && admittedId.length > 0) err.details = { userMessageId: admittedId };
        return err;
      };
      try {
        // Admit the turn. The return is the admitted SessionInboxUser
        // `{ id, ... }` — NOT the assistant output. No event subscription:
        // output is correlated below by re-reading native history in time
        // order and taking assistant text strictly after the admitted id
        // (event.subscribe is an AsyncIterable, not an awaitable
        // unsubscribe handle — polling with id correlation is authoritative).
        let admitted;
        try {
          // Native admission accepts ONLY msg_-shaped ids; a stable PWA
          // intention that already satisfies it is reused verbatim (retry
          // with the same id addresses the same native message), otherwise
          // the id is omitted and correlation uses the admitted receipt.
          const promptArgs = typeof intentionId === 'string' && intentionId.startsWith('msg_')
            ? { sessionID, id: intentionId, text }
            : { sessionID, text };
          admitted = await oc.session.prompt(promptArgs);
        } catch (e) {
          throw classifyPromptFailure(e);
        }

        if (signal && signal.aborted) {
          await interruptOnce();
          throw failAfterAdmit('prompt.cancelled', 'turn cancelled during prompt');
        }

        admittedId = typeof admitted?.id === 'string' && admitted.id.length > 0 ? admitted.id : null;
        if (!admittedId) {
          throw new PromptError('prompt.failed', 'prompt admit returned no native message id — failing closed');
        }
        // SDK admission observed: the native side accepted the turn (the
        // returned receipt is the admitted user message, not the output).
        if (diag) diag.emit({ phase: 'sdk_prompt', outcome: 'success', cause: 'none' });

        // Collect the assistant answer for THIS turn by polling a BOUNDED
        // recent window (desc, at most POLL_MAX_PAGES pages per round —
        // never the whole transcript every 250ms). Only assistant text of
        // the admitted turn counts (stops at the next user message);
        // older answers are never returned. Empty/deadline without
        // assistant text is a typed failure — never empty success.
        let output = '';
        let turnId = null;
        let deadlineHit = false;
        const start = Date.now();
        for (;;) {
          if (signal && signal.aborted) {
            await interruptOnce();
            throw failAfterAdmit('prompt.cancelled', 'turn cancelled while waiting for output');
          }
          let found = null;
          try {
            found = await pollTurnOutput(sessionID, admittedId);
          } catch (e) {
            throw classifyPromptFailure(e);
          }
          if (found === null) {
            throw new PromptError('provider.unavailable', 'no message history surface on this host — output cannot be observed, failing closed');
          }
          if (found.terminalError === 'provider.transport') {
            // Stream-interruption evidence lives ONLY here: the poll loop
            // observed assistant text before the terminal `finish:'error'`
            // marker. Surfaced as `details.outputBegan` (boolean only — no
            // text) so the classifier can distinguish interruption from an
            // opaque transport failure without reading message content.
            const began = found.text.trim().length > 0;
            const terminal = failAfterAdmit('provider.transport', 'provider transport failed — failing closed (no fabricated output)');
            if (began) terminal.details = { ...terminal.details, outputBegan: true };
            throw terminal;
          }
          if (found.text.trim().length > 0) {
            output = found.text;
            turnId = found.turnId ?? admittedId;
            break;
          }
          if (Date.now() - start > Math.min(5000, timeoutMs)) {
            // One patient re-read grace, then keep polling to deadline.
          }
          if (Date.now() >= deadline) {
            deadlineHit = true;
            break;
          }
          await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))));
        }
        if (!output || output.trim().length === 0) {
          if (interrupted || (signal && signal.aborted)) {
            throw failAfterAdmit('prompt.cancelled', 'turn cancelled while waiting for output');
          }
          // Local deadline evidence (finding 1): the wait hit the runtime
          // `timeoutMs` bound with no output. Boolean-only internal marker
          // for diagnostics (runtime timeout vs physical cause); the public
          // code/message are unchanged and details never cross HTTP (the
          // gateway DTO carries only code/message).
          const noOutput = failAfterAdmit('prompt.no_output', 'prompt admitted but no assistant output observable — failing closed (no fabricated output)');
          if (deadlineHit) noOutput.details = { ...noOutput.details, deadlineExceeded: true };
          throw noOutput;
        }
        seen.add(intentionId);
        if (diag) diag.emit({ phase: 'terminal_result', outcome: 'success', cause: 'none' });
        return { turnId, output, userMessageId: admittedId };
      } catch (e) {
        // Post-validation failures emit ONE terminal observation event.
        // Pre-admit validation errors (`prompt.invalid_args`, thrown before
        // any SDK contact) stay silent — no turn boundary was crossed.
        // Post-validation failures emit ONE terminal observation event.
        // Pre-admit validation errors (`prompt.invalid_args`, thrown before
        // any SDK contact) stay silent — no turn boundary was crossed.
        if (diag && (!(e instanceof PromptError) || e.code !== 'prompt.invalid_args')) {
          noteDiagFailure(diag, e);
        }
        if (e instanceof PromptError) {
          // Admitted or admit-uncertain failures keep the mark: retry with the
          // same id fails closed rather than risk a double turn. Only
          // pre-admit validation errors (invalid args, provider unavailable
          // before any prompt call) leave the intention unmarked.
          if (e.code === 'prompt.duplicate' || e.code === 'prompt.no_output' || e.code === 'prompt.cancelled' || e.code === 'prompt.failed' || (e.code && String(e.code).startsWith('provider.'))) {
            seen.add(intentionId);
          } else if (e.code !== 'prompt.invalid_args') {
            // Unknown whether the native side admitted: keep fail-closed.
            seen.add(intentionId);
          }
          throw e;
        }
        seen.add(intentionId);
        throw classifyPromptFailure(e);
      } finally {
        pending.delete(intentionId);
        try {
          if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
        } catch { /* settle never fails */ }
      }
    },

    async readHistory({ sessionID, ownerActor, limit = MESSAGE_MAX_TOTAL, userMeta, viewerActor, diagnosticCorrelationId } = {}) {
      if (typeof sessionID !== 'string' || sessionID.length === 0) {
        throw new PromptError('prompt.invalid_args', 'sessionID is required');
      }
      const hdiag = diagContextFor(diagnosticsSink, diagnosticCorrelationId);
      try {
        const rows = await readAllMessages(sessionID, {
          rowLimit: typeof limit === 'number' && limit > 0 ? Math.floor(limit) : MESSAGE_MAX_TOTAL,
        }).catch((e) => { throw classifyHistoryFailure(e); });
        if (rows === null) {
          throw new PromptError('history.unavailable', HISTORY_UNAVAILABLE_MESSAGE);
        }
        const items = projectHistoryItems(rows, { ownerActor, userMeta, viewerActor });
        if (hdiag) hdiag.emit({ phase: 'history_poll', outcome: 'success', cause: 'none' });
        return items;
      } catch (e) {
        if (hdiag && (!(e instanceof PromptError) || e.code !== 'prompt.invalid_args')) {
          noteDiagFailure(hdiag, e);
        }
        throw e;
      }
    },

    // Raw native rows (EXACT 2.2.4 SessionMessageInfo union) for server-side
    // replay correlation (completed-intention rebuild without a new prompt).
    // Post-bind only — the gateway rebinds before calling.
    async readRawMessages({ sessionID, limit = MESSAGE_MAX_TOTAL, diagnosticCorrelationId } = {}) {
      if (typeof sessionID !== 'string' || sessionID.length === 0) {
        throw new PromptError('prompt.invalid_args', 'sessionID is required');
      }
      const hdiag = diagContextFor(diagnosticsSink, diagnosticCorrelationId);
      try {
        const rows = await readAllMessages(sessionID, {
          rowLimit: typeof limit === 'number' && limit > 0 ? Math.floor(limit) : MESSAGE_MAX_TOTAL,
        }).catch((e) => { throw classifyHistoryFailure(e); });
        if (rows === null) {
          throw new PromptError('history.unavailable', HISTORY_UNAVAILABLE_MESSAGE);
        }
        if (hdiag) hdiag.emit({ phase: 'history_poll', outcome: 'success', cause: 'none' });
        return rows;
      } catch (e) {
        if (hdiag && (!(e instanceof PromptError) || e.code !== 'prompt.invalid_args')) {
          noteDiagFailure(hdiag, e);
        }
        throw e;
      }
    },

    // Test seam: is this intention already consumed?
    hasIntention(intentionId) {
      return seen.has(intentionId) || pending.has(intentionId);
    },
  };
}

// History-path classifier (P2-R-FIX2): native history-read failures are
// history-origin (`history.unavailable`), NEVER prompt execution failures.
// The GET /rpc/history path never calls session.prompt, so labeling its
// errors `prompt.failed` misreports a completed send as failed. Only
// intentional history-path codes pass through unchanged (`history.unavailable`
// itself, `prompt.invalid_args` for bad input, and the existing
// `prompt.history_overflow` bound); every other typed error (notably
// `prompt.failed` / `provider.*` thrown during a GET) is reclassified to
// `history.unavailable`, and untyped native failures become
// `history.unavailable` with the FIXED safe message — raw SDK text never
// reaches the client. The chat turn path (admit/poll) keeps using
// classifyPromptFailure below, preserving prompt.failed/502 there.
const HISTORY_TYPED_PASSTHROUGH = new Set([
  'history.unavailable',
  'prompt.invalid_args',
  'prompt.history_overflow',
]);

export function classifyHistoryFailure(e) {
  if (e instanceof PromptError) {
    if (HISTORY_TYPED_PASSTHROUGH.has(e.code)) return e;
    return new PromptError('history.unavailable', HISTORY_UNAVAILABLE_MESSAGE);
  }
  return new PromptError('history.unavailable', HISTORY_UNAVAILABLE_MESSAGE);
}

export function classifyPromptFailure(e) {
  if (e instanceof PromptError) return e;
  const msg = String((e && e.message) || e || '');
  const code = e && (e.code || e.status || e.statusCode);
  if (code === 401 || /unauthorized|session_required|auth/i.test(msg) && /provider|auth/i.test(msg)) {
    // Provider explicitly denied the call (not a transport flake).
  }
  if (/provider.*denied|denied.*provider|forbidden.*provider|401|403/i.test(msg) && /provider/i.test(msg)) {
    return new PromptError('provider.denied', 'provider denied the prompt — failing closed (no fallback inference)');
  }
  if (/no-route|no route|model.*not.*found|provider.*not.*configured|provider.*unavailable/i.test(msg)) {
    return new PromptError('provider.unavailable', 'no provider route for this prompt — failing closed (no fallback inference)');
  }
  if (e && (e.name === 'AbortError' || e.code === 20)) {
    return new PromptError('prompt.cancelled', 'prompt wait aborted (local cancellation; server run interrupted where supported)');
  }
  // Untyped SDK failures carry raw native text (messages, bodies, secrets) —
  // NEVER surface it: fixed safe message only (typed provider codes above
  // keep their own fixed messages; provider.transport is detected elsewhere).
  return new PromptError('prompt.failed', 'prompt failed — failing closed (no fabricated output)');
}
