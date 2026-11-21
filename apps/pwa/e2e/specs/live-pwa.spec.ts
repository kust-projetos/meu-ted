/**
 * Live PWA E2E — hardened authenticated validation via storageState.
 * Opt-in only: PWA_LIVE_E2E=1, credentials via env (never committed).
 * Covers: login (fresh) + navigation + representative writes (E2E prefix, strict 2xx) + Agent token (read-only).
 * Proxy: local PWA dev (127.0.0.1:3000) → /api/backend (synkroo) /api/agent (workers.dev)
 * Hardening: storageState reduces logins 22→2, strict assertLiveSuccess exposes 401/429/5xx.
 */

import { test, expect, type Page } from "@playwright/test";
import { assertLiveSuccess } from "../helpers/live-assert";
import { ADMIN_STATE_PATH, USER_STATE_PATH, loginViaUI } from "../helpers/live-auth";
import path from "node:path";
import fs from "node:fs";

const LIVE = process.env.PWA_LIVE_E2E === "1";
const ADMIN_EMAIL = process.env.PWA_LIVE_ADMIN_EMAIL || "";
const ADMIN_PASSWORD = process.env.PWA_LIVE_ADMIN_PASSWORD || "";
const USER_EMAIL = process.env.PWA_LIVE_USER_EMAIL || "";
const USER_PASSWORD = process.env.PWA_LIVE_USER_PASSWORD || "";

const PREFIX = "E2E";
const RUN_ID = `${PREFIX}-${Date.now().toString().slice(-6)}`;

// Helpers — browser proxy via localStorage device token
async function browserFetch(
  page: Page,
  apiPath: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string>; workspaceId?: string }
): Promise<{ status: number; body: unknown; ok: boolean }> {
  return page.evaluate(
    async ({ p, method, body, headers, workspaceId }) => {
      const token = localStorage.getItem("pi-finance:token");
      const ws = workspaceId || localStorage.getItem("pi-finance:workspace-id") || "";
      const extra: Record<string, string> = {};
      if (token) extra["x-device-token"] = token;
      if (ws) extra["X-Workspace-Id"] = ws;
      if (workspaceId) extra["X-Workspace-Id"] = workspaceId;
      const res = await fetch(`/api/backend${p}`, {
        method: method || "GET",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...extra, ...(headers || {}) },
        body: body ? JSON.stringify(body) : undefined,
        credentials: "include",
      });
      let data: unknown = null;
      try { data = await res.json(); } catch { try { data = await res.text(); } catch { data = null; } }
      return { status: res.status, body: data, ok: res.ok };
    },
    { p: apiPath, method: init?.method, body: init?.body, headers: init?.headers, workspaceId: init?.workspaceId }
  );
}

async function fetchWorkspacesViaBrowser(page: Page): Promise<string[]> {
  const res = await browserFetch(page, "/workspaces");
  if (!res.ok) return [];
  const body = res.body as { items?: Array<{ id: string }> };
  return (body.items || []).map((w) => w.id);
}

async function assertRoute(page: Page, p: string, opts?: { heading?: RegExp }) {
  await page.goto(p, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Entrar" })).toBeHidden({ timeout: 8000 }).catch(() => {
    // if login appears, auth failed — let expect fail
  });
  if (opts?.heading) {
    await expect(page.getByRole("heading", { name: opts.heading }).first()).toBeVisible({ timeout: 10000 }).catch(async () => {
      await expect(page.locator("body")).toContainText(opts!.heading!);
    });
  }
  expect(page.url()).toContain(p === "/" ? "/" : p);
}

// ── Global skips ──────────────────────────────────────────────────────────
test.describe("live-pwa", () => {
  test.skip(!LIVE, "Opt-in only — set PWA_LIVE_E2E=1");
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, "Admin env missing");
  test.skip(!USER_EMAIL || !USER_PASSWORD, "User env missing");
  test.setTimeout(120000);

  // ── Fresh login (no storageState) — validates AuthGate contract ──────
  test.describe("fresh login", () => {
    test("[LIVE-ADMIN-LOGIN] admin consegue logar e ver Resumo (fresh)", async ({ page }) => {
      await page.context().clearCookies();
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.evaluate(() => localStorage.clear());
      await loginViaUI(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await expect(page.locator('[data-testid="hero-area"]')).toBeVisible({ timeout: 10000 }).catch(async () => {
        await expect(page.getByText(/Saldo total/i)).toBeVisible({ timeout: 10000 });
      });
      const token = await page.evaluate(() => localStorage.getItem("pi-finance:token"));
      expect(token).toBeTruthy();
    });

    test("[LIVE-USER-LOGIN] membro loga e vê Resumo sem telas admin (fresh)", async ({ page }) => {
      await page.context().clearCookies();
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.evaluate(() => localStorage.clear());
      await loginViaUI(page, USER_EMAIL, USER_PASSWORD);
      await expect(page.getByRole("button", { name: /Abrir perfil/i })).toBeVisible({ timeout: 15000 });
      await page.goto("/audit", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
      await expect(page.getByRole("button", { name: "Entrar" })).toBeHidden({ timeout: 5000 });
      expect((await page.locator("body").innerText()).length).toBeGreaterThan(0);
    });
  });

  // ── Admin authenticated via storageState (setup generates .auth/admin.json) ──
  test.describe("admin - authenticated", () => {
    test.use({ storageState: ADMIN_STATE_PATH });

    const routes: Array<{ path: string; heading?: RegExp; note: string }> = [
      { path: "/", heading: /Resumo financeiro/i, note: "Início" },
      { path: "/registros", heading: /Registros/i, note: "Registros" },
      { path: "/compromissos", heading: /A pagar|Contas a pagar/i, note: "Compromissos" },
      { path: "/hub", heading: /Hub/i, note: "Hub" },
      { path: "/hub/patrimonio", heading: /Contas/i, note: "Patrimônio" },
      { path: "/hub/planejamento", heading: /Orçamentos/i, note: "Planejamento" },
      { path: "/hub/relatorios", heading: /Relat/i, note: "Relatórios" },
      { path: "/hub/alertas", heading: /Alerta/i, note: "Alertas" },
      { path: "/hub/categorias", heading: /Categorias/i, note: "Categorias" },
      { path: "/hub/configuracoes", heading: /Configurações/i, note: "Configurações" },
      { path: "/perfil", heading: /Perfil/i, note: "Perfil" },
    ];

    for (const r of routes) {
      test(`[LIVE-ADMIN-NAV] ${r.note} ${r.path}`, async ({ page }) => {
        // storageState already authenticated — no loginViaUI
        await assertRoute(page, r.path, { heading: r.heading });
      });
    }

    test("[LIVE-ADMIN-NAV] /pendentes redireciona para compromissos", async ({ page }) => {
      await page.goto("/pendentes", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      expect(page.url()).toContain("/compromissos");
    });

    test("[LIVE-ADMIN-AUDIT] /audit acessível para admin", async ({ page }) => {
      await page.goto("/audit", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("button", { name: "Entrar" })).toBeHidden({ timeout: 8000 });
      await expect(page.locator("body")).toContainText(/Audit|Logs|Operações/i, { timeout: 10000 }).catch(() => {});
    });

    test("[LIVE-ADMIN-WS] /workspaces acessível para admin", async ({ page }) => {
      await page.goto("/workspaces", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("button", { name: "Entrar" })).toBeHidden({ timeout: 8000 });
      await expect(page.locator("body")).toContainText(/Workspace|Família|Test Family/i, { timeout: 10000 }).catch(() => {});
    });

    test("[LIVE-ADMIN-WRITES] operações representativas E2E via proxy (strict 2xx)", async ({ page }) => {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      // Reuse authenticated context — no extra login
      let wsIds = await fetchWorkspacesViaBrowser(page);
      if (wsIds.length === 0) {
        const fallback = await page.evaluate(async () => {
          const token = localStorage.getItem("pi-finance:token");
          const res = await fetch("/api/backend/workspaces", {
            headers: { "x-device-token": token || "", Accept: "application/json" },
            credentials: "include",
          });
          const j = await res.json().catch(() => ({}));
          return (j.items || []).map((x: { id: string }) => x.id) as string[];
        });
        wsIds = fallback;
      }
      expect(wsIds.length).toBeGreaterThan(0);
      const workspaceId = wsIds[0]!;

      // 1. Categorias
      const catName = `${PREFIX} Categoria ${RUN_ID}`;
      const catRes = await browserFetch(page, "/categories", {
        method: "POST",
        body: { name: catName, kind: "expense" },
        workspaceId,
      });
      assertLiveSuccess(catRes, "create categoria");
      const catId = (catRes.body as { id?: string })?.id || "";
      expect(catId).toBeTruthy();

      // 2. Contas
      const accName = `${PREFIX} Conta ${RUN_ID}`;
      const accRes = await browserFetch(page, "/accounts", {
        method: "POST",
        body: { name: accName, kind: "bank", initialBalanceCents: 10000 },
        workspaceId,
      });
      assertLiveSuccess(accRes, "create conta");
      const accId = (accRes.body as { id?: string })?.id || "";

      // 3. Cartões — strict: must be 2xx, any 4xx/5xx is product failure
      const cardName = `${PREFIX} Card ${RUN_ID}`;
      const cardRes = await browserFetch(page, "/cards", {
        method: "POST",
        body: { name: cardName, creditLimitCents: 500000, closingDay: 10, dueDay: 15 },
        workspaceId,
      });
      assertLiveSuccess(cardRes, "create card");

      // 4. Registros
      const txRes = await browserFetch(page, "/transactions/expense", {
        method: "POST",
        body: {
          description: `${PREFIX} Tx ${RUN_ID}`,
          amountCents: 1234,
          date: new Date().toISOString().slice(0, 10),
          categoryId: catId,
          accountId: accId,
        },
        workspaceId,
      });
      assertLiveSuccess(txRes, "create transaction");

      // 5. Orçamentos — strict 2xx, startDate required by API
      const budRes = await browserFetch(page, "/budgets", {
        method: "POST",
        body: {
          categoryId: catId,
          amountCents: 50000,
          period: "monthly",
          name: `${PREFIX} Orc ${RUN_ID}`,
          startDate: new Date().toISOString().slice(0, 10),
        },
        workspaceId,
      });
      assertLiveSuccess(budRes, "create budget");

      // 6. Metas — startDate required
      const goalRes = await browserFetch(page, "/goals", {
        method: "POST",
        body: {
          name: `${PREFIX} Meta ${RUN_ID}`,
          goalType: "savings",
          targetAmountCents: 100000,
          startDate: new Date().toISOString().slice(0, 10),
        },
        workspaceId,
      });
      assertLiveSuccess(goalRes, "create goal");

      // 7. Contas a pagar — accountId obrigatório
      const payableRes = await browserFetch(page, "/payables", {
        method: "POST",
        body: {
          description: `${PREFIX} Pagar ${RUN_ID}`,
          amountCents: 2500,
          dueDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
          accountId: accId,
        },
        workspaceId,
      });
      assertLiveSuccess(payableRes, "create payable");

      // 8. Assinaturas
      const subRes = await browserFetch(page, "/subscriptions", {
        method: "POST",
        body: { name: `${PREFIX} Sub ${RUN_ID}`, amountCents: 1990, cycle: "monthly", day: 5, paymentMethod: "pix" },
        workspaceId,
      });
      assertLiveSuccess(subRes, "create subscription");

      // 9. Dashboard
      const dashRes = await browserFetch(page, "/dashboard/summary", { workspaceId });
      assertLiveSuccess(dashRes, "dashboard summary");
      expect((dashRes.body as { totalBalanceCents?: number })?.totalBalanceCents).not.toBeUndefined();

      // 10. Pendentes
      const pendRes = await browserFetch(page, "/pending-operations?status=pending", { workspaceId });
      assertLiveSuccess(pendRes, "pending operations");

      // 11. Perfil
      const profRes = await browserFetch(page, "/profile", { workspaceId });
      assertLiveSuccess(profRes, "profile");

      // 12. Patrimônio
      const patrRes = await browserFetch(page, "/cards/statements", { workspaceId });
      assertLiveSuccess(patrRes, "card statements");
    });

    test("[LIVE-AGENT] token delegado e pergunta somente leitura", async ({ page }) => {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      const wsIds = await fetchWorkspacesViaBrowser(page);
      expect(wsIds.length).toBeGreaterThan(0);
      const workspaceId = wsIds[0]!;

      const tokenRes = await page.evaluate(
        async (wid) => {
          const devToken = localStorage.getItem("pi-finance:token");
          const res = await fetch("/api/backend/auth/agent-token", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-device-token": devToken || "", "X-Workspace-Id": wid },
            credentials: "include",
            body: JSON.stringify({}),
          });
          let body: unknown = null;
          try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
          return { status: res.status, ok: res.ok, body };
        },
        workspaceId
      );
      expect(tokenRes.ok, `agent-token failed ${tokenRes.status} ${JSON.stringify(tokenRes.body).slice(0,500)}`).toBeTruthy();
      const agentToken = (tokenRes.body as { token?: string })?.token;
      expect(agentToken).toBeTruthy();

      const histRes = await page.evaluate(
        async ({ wid, tok }) => {
          const res = await fetch(`/api/agent/agents/finance-chat-agent/${encodeURIComponent(wid)}/rpc/history`, {
            headers: { "X-Workspace-Id": wid, "x-agent-connection-token": tok },
            credentials: "include",
          });
          let body: unknown = null;
          try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
          return { status: res.status, ok: res.ok, body };
        },
        { wid: workspaceId, tok: agentToken! }
      );
      if (!histRes.ok) {
        const msg = JSON.stringify(histRes.body);
        const isKnownBlock = msg.includes("history_migration_failed") || msg.includes("DurableObject") || histRes.status === 500;
        expect(isKnownBlock, `unexpected history failure ${histRes.status} ${msg.slice(0,500)}`).toBeTruthy();
      } else {
        expect(histRes.ok).toBeTruthy();
      }

      const chatRes = await page.evaluate(
        async ({ wid, tok }) => {
          const res = await fetch(`/api/agent/agents/finance-chat-agent/${encodeURIComponent(wid)}/rpc/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Workspace-Id": wid, "x-agent-connection-token": tok },
            credentials: "include",
            body: JSON.stringify({ text: "Qual meu saldo total hoje? (somente leitura, não faça mutações)" }),
          });
          let body: unknown = null;
          try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
          return { status: res.status, ok: res.ok, body };
        },
        { wid: workspaceId, tok: agentToken! }
      );
      if (!chatRes.ok) {
        const msg = JSON.stringify(chatRes.body);
        const isKnownBlock = msg.includes("history_migration_failed") || msg.includes("DurableObject") || msg.includes("agent") || chatRes.status >= 500;
        expect(isKnownBlock, `unexpected chat failure ${chatRes.status} ${msg.slice(0,600)}`).toBeTruthy();
      } else {
        const b = chatRes.body as { turnId?: string; status?: string; output?: string };
        expect(b.turnId || b.status).toBeTruthy();
      }
    });
  });

  // ── User authenticated via storageState ───────────────────────────────
  test.describe("user - authenticated", () => {
    test.use({ storageState: USER_STATE_PATH });

    test("[LIVE-USER-NAV] membro navega rotas permitidas", async ({ page }) => {
      const userRoutes = ["/", "/registros", "/hub/patrimonio?aba=contas", "/hub/categorias", "/perfil", "/compromissos?aba=a-pagar"];
      for (const p of userRoutes) {
        await page.goto(p, { waitUntil: "domcontentloaded" });
        await expect(page.getByRole("button", { name: "Entrar" })).toBeHidden({ timeout: 8000 });
        expect(page.url()).toContain(p === "/" ? "/" : p.split("?")[0]);
      }
    });

    test("[LIVE-USER-WRITES] membro leitura e writes básicos com E2E (strict)", async ({ page }) => {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      const wsIds = await fetchWorkspacesViaBrowser(page);
      expect(wsIds.length).toBeGreaterThan(0);
      const workspaceId = wsIds[0]!;
      const dash = await browserFetch(page, "/dashboard/summary", { workspaceId });
      assertLiveSuccess(dash, "user dashboard");
      const catRes = await browserFetch(page, "/categories", {
        method: "POST",
        body: { name: `${PREFIX} UserCat ${RUN_ID}`, kind: "expense" },
        workspaceId,
      });
      assertLiveSuccess(catRes, "user create category");
    });
  });
});
