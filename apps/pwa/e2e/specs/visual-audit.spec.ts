import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { prepareSpec, authenticate } from "../support/harness";
import { assertNoUndeclaredFailures } from "../support/failure-guard";

test.describe("V2 visual audit", () => {
  test.skip(!process.env.VISUAL_AUDIT, "visual audit is opt-in");
  const out = path.resolve(__dirname, "../../../../docs/design/v2-audit/after");
  const entries: { theme: string; width: number; name: string; route: string; status: string; reason: string }[] = [];
  const hashes = new Map<string, string>();
  const runId = `visual-audit-${Date.now()}`;
  const routes = [
    ["/", "home"], ["/registros", "registros"], ["/compromissos", "compromissos"],
    ["/hub/patrimonio?aba=contas", "contas"], ["/hub/patrimonio?aba=cartoes", "cartoes"],
    ["/hub/relatorios", "relatorios"], ["/hub/planejamento", "planejamento"],
    ["/hub/patrimonio", "patrimonio"], ["/hub/configuracoes", "configuracoes"],
    ["/perfil", "perfil"], ["/ted", "ted"],
  ] as const;
  const routeByName = Object.fromEntries(routes.map(([route, name]) => [name, route]));
  async function setup(page: Page, theme: string) {
    const guard = await prepareSpec(page, `${runId}-${theme}-${entries.length}`);
    await page.addInitScript((value) => localStorage.setItem("pi-theme", value), theme);
    await page.goto("/");
    await authenticate(page);
    await page.evaluate((value) => localStorage.setItem("pi-theme", value), theme);
    return guard;
  }
  async function capture(page: Page, theme: string, width: number, height: number, name: string, route: string, fullPage = true) {
    const file = path.join(out, theme, String(width), `${name}.png`);
    try {
      await page.setViewportSize({ width, height });
      await page.evaluate((value) => localStorage.setItem("pi-theme", value), theme);
      if (`${new URL(page.url()).pathname}${new URL(page.url()).search}` !== route) await page.goto(route);
      if (name === "home") await expect(page.getByText(/Saldo total em contas/i)).toBeVisible({ timeout: 90_000 });
      await expect.poll(() => page.locator('[data-testid*="skeleton"], [aria-busy="true"]').count()).toBe(0).catch(() => undefined);
      if (name === "home") await page.getByText(/Saldo total em contas/i).waitFor({ state: "visible" });
      await page.waitForTimeout(400);
      if (name === "registros") {
        const iconCount = await page.locator('[data-testid="category-badge"] svg').count();
        console.log(`[visual-audit] category badge SVGs=${iconCount} theme=${theme} width=${width}`);
      }
      await mkdir(path.dirname(file), { recursive: true });
      const bytes = await page.screenshot({ path: file, fullPage, animations: "disabled" });
      hashes.set(`${theme}/${width}/${name}`, createHash("sha256").update(bytes).digest("hex"));
      let reason = "";
      if (name === "home") {
        const missing: string[] = [];
        for (const text of ["Contas", "Cartões", "Compromissos", "Para onde foi"]) {
          const texts = await page.getByText(text, { exact: true }).all();
          if (!(await Promise.all(texts.map((locator) => locator.isVisible().catch(() => false))).then((visible) => visible.some(Boolean)))) missing.push(text);
        }
        // Five section texts includes the balance title used as the shell signal.
        const balance = await page.getByText(/Saldo total em contas/i).isVisible().catch(() => false);
        if (!balance) missing.unshift("Saldo total em contas");
        const pass = missing.length === 0;
        reason = pass ? "Five section texts visible" : `Missing section text(s): ${missing.join(", ")}`;
        entries.push({ theme, width, name, route, status: pass ? "ok" : "failed", reason });
      } else entries.push({ theme, width, name, route, status: "ok", reason });
    } catch (error) {
      entries.push({ theme, width, name, route, status: "failed", reason: String(error).split("\n")[0] });
    }
  }
  async function captureHome(page: Page, theme: string, width: number, height: number) {
    await capture(page, theme, width, height, "home", "/", true);
    if (width <= 430) await capture(page, theme, width, height, "home-viewport", "/", false);
  }
  async function saveSheet(page: Page, theme: string, width: number, name: string, route: string) {
    const file = path.join(out, theme, String(width), `${name}.png`);
    await page.waitForTimeout(400);
    await mkdir(path.dirname(file), { recursive: true });
    const bytes = await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
    hashes.set(`${theme}/${width}/${name}`, createHash("sha256").update(bytes).digest("hex"));
    entries.push({ theme, width, name, route, status: "ok", reason: "" });
  }

  test("375 light", async ({ page }) => {
    test.setTimeout(900_000);
    await setup(page, "light");
    for (const [route, name] of routes) await capture(page, "light", 375, 812, name, route);
    await capture(page, "light", 375, 812, "home-viewport", "/", false);
  });
  test("375 dark", async ({ page }) => {
    test.setTimeout(900_000);
    await setup(page, "dark");
    for (const [route, name] of routes) await capture(page, "dark", 375, 812, name, route);
    await capture(page, "dark", 375, 812, "home-viewport", "/", false);
  });
  test("430 light+dark", async ({ page }) => {
    test.setTimeout(900_000);
    await setup(page, "light");
    for (const theme of ["light", "dark"]) for (const [route, name] of [["/", "home"], ["/registros", "registros"], ["/hub/patrimonio?aba=cartoes", "cartoes"], ["/compromissos", "compromissos"]]) {
      await capture(page, theme, 430, 932, name, route);
    }
  });
  test("large screens", async ({ page }) => {
    test.setTimeout(900_000);
    await setup(page, "light");
    for (const width of [768, 1440]) for (const [route, name] of [["/", "home"], ["/registros", "registros"], ["/hub/patrimonio?aba=cartoes", "cartoes"], ["/hub/relatorios", "relatorios"]]) {
      await capture(page, "light", width, 900, name, route);
    }
  });
  test("sheets and login", async ({ page, browser }) => {
    test.setTimeout(900_000);
    await setup(page, "light");
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.evaluate((value) => localStorage.setItem("pi-theme", value), theme);
      await page.goto("/");
      await expect(page.getByText(/Saldo total em contas/i)).toBeVisible({ timeout: 90_000 });
      await page.getByRole("button", { name: "Personalizar in\u00edcio" }).click();
      const customizer = page.getByRole("dialog", { name: "Personalizar in\u00edcio" });
      await expect(customizer).toBeVisible();
      await saveSheet(page, theme, 375, "personalizar-inicio", "/");
      await customizer.getByRole("button", { name: "Fechar" }).click();
      await expect(customizer).toHaveCount(0);
      for (const mode of ["Despesa", "Receita", "Transfer\u00eancia"]) {
        await page.locator('nav[data-nav="bottom"]').getByRole("button", { name: "Novo lançamento" }).click();
        await page.getByRole("button", { name: mode, exact: true }).click();
        const sheet = page.getByRole("dialog");
        await expect(sheet).toBeVisible();
        await saveSheet(page, theme, 375, `nova-${mode.toLowerCase()}`, "/");
        await sheet.getByRole("button", { name: "Fechar" }).click();
        await expect(sheet).toHaveCount(0);
      }
    }
    const loginContext = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 375, height: 812 } });
    try {
      const login = await loginContext.newPage();
      for (const theme of ["light", "dark"]) {
        await login.addInitScript((value) => localStorage.setItem("pi-theme", value), theme);
        await login.goto("/");
        await expect(login.getByLabel("E-mail")).toBeVisible();
        const file = path.join(out, theme, "375", "login.png");
        await login.waitForTimeout(400);
        await mkdir(path.dirname(file), { recursive: true });
        const bytes = await login.screenshot({ path: file, fullPage: true, animations: "disabled" });
        hashes.set(`${theme}/375/login`, createHash("sha256").update(bytes).digest("hex"));
        entries.push({ theme, width: 375, name: "login", route: "/", status: "ok", reason: "" });
        await login.evaluate((value) => localStorage.setItem("pi-theme", value), theme);
      }
    } finally { await loginContext.close(); }
  });

  test.afterAll(async () => {
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, "INDEX.md"), ["# Meu TED PWA - V2 visual audit", "", "Full-page screenshots; home-viewport is viewport-only. Home section checks are recorded after screenshot without throwing.", "", "| Theme | Width | Name | Route | Status | Reason |", "|---|---:|---|---|---|---|", ...entries.map((e) => `| ${e.theme} | ${e.width} | ${e.name} | \`${e.route}\` | ${e.status} | ${e.reason} |`), "", `Distinct screenshot SHA-256 values: ${new Set(hashes.values()).size}`, ""].join("\n"));
  });
});
