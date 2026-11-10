/**
 * P2D rollback slice — the kill switch must send an `opencode.*`-pinned
 * conversation back to A0 and expire the stale pin.
 *
 * Real browser + real Next dev PWA + real same-origin `/api/agent` proxy, with
 * `TED_OPENCODE_RUNTIME_KILL_SWITCH=1` on the Next process, the loopback
 * gateway running (so a wrong route would be observable) and the real Agent
 * Worker (A0) running. A pre-seeded `opencode.<uuid>` pin represents a
 * conversation created before the rollback.
 *
 * Scope: routing/pin lifecycle only. No model, no prompt, no financial write.
 */
import { test, expect } from "@playwright/test";
import { resolveP2dPorts } from "../support/ports";

const ports = resolveP2dPorts(process.env);
const CTL = `http://127.0.0.1:${ports.ctlPort}`;
const NEXT_BASE = `http://127.0.0.1:${ports.nextPort}`;
const STALE_CONVERSATION = "11111111-1111-4111-8111-111111111111";

async function ctl<T>(pathname: string): Promise<T> {
  const res = await fetch(`${CTL}${pathname}`);
  if (!res.ok) throw new Error(`ctl GET ${pathname} -> ${res.status}`);
  return res.json() as Promise<T>;
}

test("kill switch: opencode.* pin rolls back to A0 and the pin is expired", async ({ page, context }) => {
  test.setTimeout(600_000);
  expect(await ctl<{ ok: boolean; agentRunning: boolean; probeRunning: boolean }>("/health")).toMatchObject({
    ok: true,
    agentRunning: true,
    probeRunning: true,
  });
  const baseline = await ctl<{ promptCalls: number }>("/p2d/stats");
  expect(baseline.promptCalls).toBe(0);

  await context.addCookies([
    { name: "ted-runtime-conversation", value: `opencode.${STALE_CONVERSATION}`, url: NEXT_BASE },
  ]);

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#email")).toBeVisible({ timeout: 120_000 });
  const email = `ted-rollback-${Date.now()}@example.test`;
  const signup = await page.evaluate(async (userEmail) => {
    const res = await fetch("/api/backend/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: userEmail, password: "test-password-123", name: "TED Rollback" }),
    });
    return res.status;
  }, email);
  expect(signup).toBe(200);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill("test-password-123");
  await page.getByRole("button", { name: "Entrar" }).click();

  const launcher = page.getByRole("button", { name: /abrir assistente ted/i }).last();
  await expect(launcher).toBeVisible({ timeout: 120_000 });
  expect((await context.cookies(NEXT_BASE)).some((cookie) => cookie.name === "ted-runtime-conversation")).toBe(true);
  // The first P2 request carries the pre-seeded pin; its response proves where
  // the proxy routed and whether the stale pin was cleared. Header matchers
  // cannot rely on Playwright exposing the Cookie header, so the pin's effect
  // is asserted through the routing header + Set-Cookie below.
  const pinnedResponse = page.waitForResponse(
    (response) => /\/api\/agent\/agents\/finance-chat-agent\/[^/]+\/rpc\/(session\/new|history|chat)$/.test(new URL(response.url()).pathname),
    { timeout: 180_000 },
  );
  await launcher.click();
  const response = await pinnedResponse;
  expect(response.headers()["x-ted-runtime"]).toBe("agent");
  const headers = await response.allHeaders();
  const setCookies = headers["set-cookie"] ?? "";
  expect(setCookies).toContain("ted-runtime-conversation=;");
  expect(setCookies).not.toContain(`opencode.${STALE_CONVERSATION}`);

  // The gateway is up but must never be prompted: the rollback went to A0.
  const after = await ctl<{ promptCalls: number; stubTurns: number }>("/p2d/stats");
  expect(after.promptCalls).toBe(0);
  expect(after.stubTurns).toBe(0);
});
