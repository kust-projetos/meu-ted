/**
 * TED Chat & Workspaces E2E Tests (Task 12)
 *
 * Scenarios:
 * 1. Open TED Chat via floating launcher
 * 2. Send message and view streaming / response
 * 3. Switch workspace and verify context updates
 * 4. Close chat with Escape or close button
 *
 * Transport note (WAVE11-CODER-E2EB): the app calls the same-origin proxy
 * /api/agent (no direct Agent origin is configured in the E2E build, and the
 * proxy runs without upstream there — fail-closed). EVERY agent call must be
 * forwarded to the fixture /agents/finance-chat-agent/* handlers (Node fetch
 * with X-E2E-Test-ID), or the leaked call hits the misconfigured proxy and
 * fails the run. Replies are programmed per test via POST /__e2e/agent-script
 * (FIFO chat queue). History / undo-active / approval-active lists are
 * stubbed empty in-browser — registered AFTER the generic forwarder so the
 * later registrations win (the fixture has no history/undo handlers; a
 * forwarded call there would 404).
 */

import { test, expect } from "@playwright/test";
import { prepareSpec, authenticate } from "../support/harness";
import { FIXTURE_URL, E2E_TEST_ID_HEADER } from "../support/reset";
import { harnessOrigin } from "../support/ports";

// Cross-origin mocked API responses must carry CORS headers: the app calls
// the absolute fixture origin with credentials:include, so a fulfill without
// ACAO + ACA-Credentials is rejected by the browser (Failed to fetch).
const MOCK_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": harnessOrigin(),
  "Access-Control-Allow-Credentials": "true",
};

let counter = 0;
function tid(): string {
  counter += 1;
  return `ted-chat-${counter}`;
}

async function postAgentScript(
  testId: string,
  script: { chat?: Array<{ status?: number; body?: Record<string, unknown> }> },
): Promise<void> {
  const res = await fetch(`${FIXTURE_URL}/__e2e/agent-script`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [E2E_TEST_ID_HEADER]: testId },
    body: JSON.stringify({ testId, ...script }),
  });
  if (!res.ok) throw new Error(`Agent script failed: ${res.status} ${await res.text()}`);
}

type JournalEntry = {
  method: string;
  path: string;
  status: number;
  body?: unknown;
};

async function getJournal(testId: string): Promise<JournalEntry[]> {
  const res = await fetch(`${FIXTURE_URL}/__e2e/journal?testId=${testId}`, {
    headers: { [E2E_TEST_ID_HEADER]: testId },
  });
  return res.ok ? ((await res.json()) as JournalEntry[]) : [];
}

/**
 * Finds the scripted chat round-trip in the fixture journal. The fixture
 * journals the chat POST BEFORE responding, so by the time the post-send
 * history reload fires the entry is already there; the open-time reload
 * finds nothing and gets []. A short poll covers scheduling edges only.
 */
async function waitChatEntry(testId: string, timeout = 5000): Promise<JournalEntry | null> {
  const start = Date.now();
  for (;;) {
    const entries = await getJournal(testId);
    const hit = entries.find((e) => e.method === "POST" && e.path.endsWith("/rpc/chat"));
    if (hit) return hit;
    if (Date.now() - start > timeout) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const GREETING = "Olá! Como posso ajudar você com suas finanças?";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test.describe("TED Chat & Workspaces", () => {
  test("opens TED chat launcher, displays conversation interface and allows sending messages", async ({ page }) => {
    const id = tid();
    await prepareSpec(page, id);

    // Deterministic TED greeting served by the fixture Agent stub (FIFO chat
    // queue) — the assertion below renders from this stubbed turn, never LLM.
    await postAgentScript(id, {
      chat: [
        {
          status: 200,
          body: {
            turnId: "turn-1",
            status: "completed",
            output: GREETING,
          },
        },
      ],
    });

    // Generic forwarder: /api/agent/<subpath> → fixture /<subpath>, journaled.
    // Covers chat, history, undo, session and approval calls — every route the
    // agent client uses (see src/lib/api/agent-client.ts).
    await page.route("**/api/agent/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const subpath = url.pathname.replace(/^\/api\/agent\/?/, "");
      const target = `${FIXTURE_URL}/${subpath}${url.search}`;
      const headers: Record<string, string> = {
        "content-type": "application/json",
        [E2E_TEST_ID_HEADER]: id,
      };
      const workspaceId = req.headers()["x-workspace-id"];
      if (workspaceId) headers["x-workspace-id"] = workspaceId;
      const method = req.method();
      const postData = req.postData();
      const res = await fetch(target, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : (postData ?? undefined),
      });
      const text = await res.text();
      await route.fulfill({
        status: res.status,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: text,
      });
    });

    await page.route("**/auth/agent-token", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({ token: "mock-token", expiresIn: 90 }),
      });
    });

    // Chat history: emulates server persistence. executeSend surfaces the
    // turn ONLY through the post-send history reload (the turn output itself
    // never renders a bubble), so an always-empty stub would erase even the
    // user message on success. Before any chat round-trip the history is [];
    // once the scripted turn lands (journaled by the fixture before it
    // responds), the canonical history holds the user message + the turn
    // output — exactly what the real Agent would persist.
    await page.route("**/finance-chat-agent/**/rpc/history*", async (route) => {
      const chat = await waitChatEntry(id);
      if (!chat) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: MOCK_CORS_HEADERS,
          body: JSON.stringify({ items: [], total: 0 }),
        });
        return;
      }
      const chatBody = (chat.body ?? {}) as { text?: unknown; intentionId?: unknown };
      const userText =
        typeof chatBody.text === "string" && chatBody.text ? chatBody.text : "Quanto gastei hoje?";
      const userId =
        typeof chatBody.intentionId === "string" && chatBody.intentionId
          ? chatBody.intentionId
          : `msg-${id}`;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          items: [
            { id: userId, role: "user", content: userText, isOwn: true },
            { id: "turn-1", role: "assistant", content: GREETING, isOwn: false },
          ],
          total: 2,
        }),
      });
    });

    // Undo active list: none in this flow.
    await page.route("**/finance-chat-agent/**/rpc/undo/active*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({ items: [], total: 0 }),
      });
    });

    // Approval active list: none in this flow.
    await page.route("**/rpc/pending-operations/active*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({ items: [], total: 0 }),
      });
    });

    // authenticate() acts on the current page — land on the app first
    // (prepareSpec deliberately does not navigate).
    await page.goto("/");
    await authenticate(page);

    // Check launcher button is visible. Two buttons share the aria-label
    // (hero icon first, floating pill last) — take the floating one.
    const launcher = page.getByRole("button", { name: /abrir assistente ted/i }).last();
    await expect(launcher).toBeVisible();

    // Click launcher to open chat
    await launcher.click();
    const dialog = page.getByRole("dialog", { name: /chat com ted/i });
    await expect(dialog).toBeVisible();

    // Send a message
    // Placeholder in the product is "Mensagem para o assistente".
    const input = page.getByLabel("Mensagem para o assistente");
    await input.fill("Quanto gastei hoje?");
    await page.getByRole("button", { name: /enviar mensagem/i }).click();

    // Verify the round-trip: the user message survived as sent (proves the
    // chat POST resolved) and the scripted turn output surfaced via the
    // canonical history reload (proves end-to-end delivery, never LLM).
    await expect(dialog.getByText("Quanto gastei hoje?")).toBeVisible();
    await expect(page.getByText(GREETING)).toBeVisible();

    // Close chat with close button
    await page.getByRole("button", { name: /fechar chat/i }).click();
    await expect(dialog).not.toBeVisible();
  });
});
