/**
 * CHANNEL INVARIANT — source-contract guard on the `decisionText` wiring.
 *
 * `decisionText` (F1) is what keeps attachment-derived data out of the DECISION
 * surface. Two things feed it, and both matter:
 *
 *   1. `normalizeRestTurn(..., { typedText })` — the SERVER-SIDE option that puts
 *      the typed text on the turn, so `runTurn` reads
 *      `input.decisionText ?? input.text` and never falls back to the composed
 *      text;
 *   2. `routeIntent(text, decisionText)` — the explicit second argument, so the
 *      confirmation/cancel routing of THIS leg is computed from the typed text.
 *
 * Today both live in the `pwa-rest` leg, the only channel that composes
 * attachment data (STT transcript / vision extraction / PDF text layer) into the
 * turn text — `resolveTurnAttachmentRefs` has exactly ONE call site.
 *
 * The failure mode this guard exists for: a future channel that composes
 * attachment data but forgets to propagate the typed text. Its
 * `routeIntent(text)` call would omit the second argument, the
 * `decisionText === undefined ? text : ...` fallback would hand the DECISION
 * surface back to the composed text, and a PDF whose text layer contains
 * "sim confirmo" would confirm a pending operation again — the exact F1 BLOCKER.
 * Silent, because every existing test drives the `pwa-rest` leg.
 *
 * This is therefore a STRUCTURAL guard, not a behavioural one: it reads the
 * source and fails the moment a second call site appears, forcing whoever adds
 * it to propagate `decisionText` in the same change. It also pins the two
 * literal expressions the single call site depends on, so removing either one
 * is caught here rather than in production.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE_URL = new URL("../../src/finance-chat-agent.ts", import.meta.url);

const readAgentSource = (): string => readFileSync(SOURCE_URL, "utf8");

/** Calls look like `this.resolveTurnAttachmentRefs(`; the declaration does not. */
const CALL_SITES = /this\s*\.\s*resolveTurnAttachmentRefs\s*\(/g;

/** The single declaration of the helper itself (`private async ...(`). */
const DECLARATION = /private\s+async\s+resolveTurnAttachmentRefs\s*\(/g;

describe("channel invariant — `decisionText` is wired at every attachment call site", () => {
  it("`resolveTurnAttachmentRefs` has EXACTLY ONE call site (the declaration is not a call)", () => {
    const source = readAgentSource();

    const declarations = source.match(DECLARATION) ?? [];
    const callSites = source.match(CALL_SITES) ?? [];

    // The helper itself is declared once...
    expect(declarations).toHaveLength(1);
    // ...and invoked once. A second call site means a new channel is composing
    // attachment data, and it MUST pass the typed text through as well.
    expect(callSites).toHaveLength(1);
  });

  it("that single call site feeds BOTH the typed text and the two-argument `routeIntent`", () => {
    const source = readAgentSource();

    // (1) The server-side option that puts the typed text on the turn. Without
    // it the orchestrator falls back to `input.text` — the composed text.
    expect(source).toContain("typedText: unredactedText");
    // (2) The explicit decision argument at this call site's routing decision.
    // Note the OTHER `routeIntent(` in this file is the single-argument
    // proposal path (`mutationProposalPlan`), which reads only skillNames and
    // confidence — never a decision mode — and is deliberately left alone.
    expect(source).toContain("routeIntent(text, decisionText)");

    // Ordering: the attachment data is resolved BEFORE the routing decision, and
    // the routing decision sits in the same composed-text flow. A `routeIntent`
    // with the second argument that appeared BEFORE attachment composition would
    // mean the decision is being computed on a different text.
    const callSiteIndex = source.search(CALL_SITES);
    const routedIndex = source.indexOf("routeIntent(text, decisionText)");
    expect(callSiteIndex).toBeGreaterThanOrEqual(0);
    expect(routedIndex).toBeGreaterThan(callSiteIndex);
  });

  it("the single-argument fallback is the documented one, so an omitted argument stays visible", () => {
    const source = readAgentSource();
    // `routeIntent`'s own fallback is the reason this guard is needed: an
    // omitted second argument means "the turn text IS the typed text". Pin the
    // signature so that default cannot change silently under this test.
    const router = readFileSync(new URL("../../src/orchestration/intent-router.ts", import.meta.url), "utf8");
    expect(router).toMatch(/export const routeIntent = \(text: string, decisionText\?: string\)/);
    // And the decision modes really are read from `decision`, never `normalized`.
    expect(router).toContain("const decision = decisionText === undefined ? normalized");
    expect(source).toContain("const decisionText = unredactedText;");
  });
});

/**
 * A19 — the SAME structural argument, applied to AUTOEXECUTION instead of
 * DECISION routing.
 *
 * `decisionText` protects the confirm/cancel surface. `isAutoExecutionEligible`
 * had NO such field: its immunity was LEXICAL, resting on the provenance
 * marker occupying the head of the composed turn text. That immunity only
 * holds when an attachment actually produced an accepted extraction — when the
 * extraction is empty (capability off, which is the production default;
 * `unsupported`; provider down; STT/vision/PDF failure; `skipped_budget`; a
 * refused upload) nothing is composed, the turn text is byte-for-byte the typed
 * text, no marker opens the message, and the gate accepts a leading imperative.
 *
 * So the veto is pinned in the SIGNATURE, not only in the behaviour: the
 * eligibility function must carry an `attachments` input, and every call site
 * must pass the turn's real attachments. A future refactor that drops the
 * parameter — or a new call site that forgets it — fails here.
 */
describe("A19 invariant — autoexecution eligibility carries an attachment veto", () => {
  const readSource = (relative: string): string =>
    readFileSync(new URL(relative, import.meta.url), "utf8");

  it("`isAutoExecutionEligible` takes `attachments` and refuses on PRESENCE alone", () => {
    const safety = readSource("../../src/safety/auto-execution.ts");
    // The parameter exists in the signature (typed, optional-free) ...
    expect(safety).toMatch(/isAutoExecutionEligible = \(input: \{[^}]*attachments[^}]*\}\)/);
    // ... and the veto reads the LENGTH, so an empty-name/null item still vetoes.
    expect(safety).toContain("input.attachments.length === 0");
  });

  it("EVERY `isAutoExecutionEligible` call site passes the turn's attachments", () => {
    const orchestrator = readSource("../../src/orchestration/conversation-orchestrator.ts");
    const calls = orchestrator.match(/isAutoExecutionEligible\(\{/g) ?? [];
    // Both the draft path and the no-draft path are autoexecute entry points.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const passed = orchestrator.match(/isAutoExecutionEligible\(\{[^}]*attachments: input\.attachments/g) ?? [];
    // An omitted argument means "no attachment", i.e. the veto silently off.
    expect(passed).toHaveLength(calls.length);
  });

  it("the elevated client is gated on ATTACHMENT PRESENCE, not on extracted data", () => {
    const source = readAgentSource();
    // Gating on `attachmentData.length` (extracted data) left the fast path
    // reachable whenever extraction was empty — the exact hole. Presence is the
    // only honest gate.
    expect(source).toContain("incomingAttachments.length === 0");
    expect(source).not.toContain("attachmentData.length === 0");
  });
});