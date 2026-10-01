import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  applyCspRewrite,
  authenticate,
  resetFixture,
} from "../support/harness";
import { harnessOrigin } from "../support/ports";

const FIXED_CLOCK = "2026-07-17T12:00:00.000Z";
const IOS_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
// Page origin of the SW harness (opt-in E2E_HARNESS_PORT, default :3000).
const HARNESS_ORIGIN = harnessOrigin();

async function deploySw(
  context: BrowserContext,
  version: "legacy" | "current",
): Promise<void> {
  const response = await context.request.post(
    `${HARNESS_ORIGIN}/__e2e/sw/deploy`,
    { data: { version } },
  );
  expect(response.ok()).toBeTruthy();
}
async function registerAndHome(
  page: Page,
  testId: string,
  initialPath = "/",
): Promise<void> {
  await applyCspRewrite(page);
  await resetFixture(testId);
  await page.clock.setFixedTime(FIXED_CLOCK);
  await page.context().setExtraHTTPHeaders({ "x-e2e-test-id": testId });
  // Deep-link-first (WAVE5-FE-SWFIX): land DIRECTLY on the route under test
  // and authenticate there, keeping a single document for the whole test.
  // A second full navigation (page.goto) after the SW takes control is NOT
  // equivalent: SW-served navigations (worker fetch AND navigation preload)
  // are issued from the SW target and never reach page-target request
  // interception (proven: the 2nd navigation never hit page.route and the
  // served document kept the server-original `connect-src 'self'`), so the
  // harness CSP rewrite that admits the fixture origin cannot apply and the
  // session probe is CSP-blocked (cookie persisted, journal empty, UI falls
  // to login). The SW itself is network-only for navigations and never
  // caches HTML/API (src/sw.ts) — there is no product caching bug to fix.
  // This mirrors the DIRECT-* navigation specs (deep-link, then register).
  await page.goto(initialPath, { waitUntil: "domcontentloaded" });
  await authenticate(page, { timeout: 20000 });
}

async function waitForServiceWorker(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return registration?.active?.scriptURL ?? "";
        }),
      { timeout: 30000 },
    )
    .toMatch(/\/sw\.js$/);
}

async function openPushCard(
  page: Page,
): Promise<ReturnType<Page["getByRole"]>> {
  // No navigation here: the test deep-links onto /perfil BEFORE authenticating
  // (see registerAndHome), so the push entry point is already on screen. A
  // second page.goto under SW control would serve a document whose CSP was
  // never rewritten for the fixture (see above) and drop the session.
  await expect(page).toHaveURL(/\/perfil$/);
  await page.getByRole("button", { name: "Notificações" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

type PushResponse = { path: string; status: number; body?: unknown };
function capturePushResponses(page: Page): PushResponse[] {
  const responses: PushResponse[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (
      url.pathname !== "/push/vapid-public-key" &&
      url.pathname !== "/push/subscriptions"
    )
      return;
    let body: unknown;
    try {
      body = response.request().postDataJSON();
    } catch {
      body = undefined;
    }
    responses.push({
      path: url.pathname,
      status: response.status(),
      ...(body !== undefined ? { body } : {}),
    });
  });
  return responses;
}

async function expectPushPersistence(responses: PushResponse[]): Promise<void> {
  await expect
    .poll(() => responses, { timeout: 10000 })
    .toContainEqual(
      expect.objectContaining({
        path: "/push/vapid-public-key",
        status: 200,
      }),
    );
  const persisted = responses.find(
    (entry) => entry.path === "/push/subscriptions" && entry.status === 201,
  );
  expect(persisted).toBeDefined();
  expect(persisted?.body).toEqual(
    expect.objectContaining({
      endpoint: expect.stringMatching(/^https:\/\//),
      keys: expect.objectContaining({
        p256dh: expect.any(String),
        auth: expect.any(String),
      }),
    }),
  );
}

async function installPushSubscriptionShim(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const fakeSubscription = {
      endpoint: "https://push.example.test/e2e-subscription",
      getKey: (name: string) =>
        name === "p256dh"
          ? new Uint8Array([1, 2, 3]).buffer
          : new Uint8Array([4, 5, 6]).buffer,
    };
    const fakePushManager = {
      getSubscription: async () => null,
      subscribe: async () => {
        const current = window as Window & { pushSubscribeCalls?: number };
        current.pushSubscribeCalls = (current.pushSubscribeCalls ?? 0) + 1;
        return fakeSubscription;
      },
    };
    const serviceWorker = navigator.serviceWorker;
    const patch = (
      registration: ServiceWorkerRegistration,
    ): ServiceWorkerRegistration => {
      Object.defineProperty(registration, "pushManager", {
        configurable: true,
        value: fakePushManager,
      });
      return registration;
    };
    const originalRegister = serviceWorker.register.bind(serviceWorker);
    Object.defineProperty(serviceWorker, "register", {
      configurable: true,
      value: async (...args: Parameters<typeof serviceWorker.register>) =>
        patch(await originalRegister(...args)),
    });
    const originalGetRegistration =
      serviceWorker.getRegistration.bind(serviceWorker);
    Object.defineProperty(serviceWorker, "getRegistration", {
      configurable: true,
      value: async (
        ...args: Parameters<typeof serviceWorker.getRegistration>
      ) => {
        const registration = await originalGetRegistration(...args);
        return registration ? patch(registration) : registration;
      },
    });
  });
}

async function installStandaloneDisplayMode(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const originalMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query: string) =>
      query === "(display-mode: standalone)"
        ? {
            matches: true,
            media: query,
            onchange: null,
            addListener() {},
            removeListener() {},
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent: () => false,
          }
        : originalMatchMedia(query);
    Object.defineProperty(navigator, "standalone", {
      configurable: true,
      value: true,
    });
  });
}

async function installPermissionProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = Notification.requestPermission.bind(Notification);
    Object.defineProperty(Notification, "requestPermission", {
      configurable: true,
      value: async () => {
        (
          window as unknown as {
            pushPermissionProbe?: { called: boolean; userActivated: boolean };
          }
        ).pushPermissionProbe = {
          called: true,
          userActivated: navigator.userActivation.isActive,
        };
        return original();
      },
    });
  });
}

async function installGrantedPermission(page: Page): Promise<void> {
  // SPEC-CONTROLLED PERMISSION (WAVE5-FE-SWFIX): context.grantPermissions is
  // a verified no-op in this Chromium — Notification.permission reads
  // "denied" after both origin-scoped and global grants (probe evidence),
  // which would force getPushState into "denied" before the flow under test
  // even starts. The permission STORE is not under test here (PUSH-03 covers
  // the gesture-gated requestPermission path); pinning "granted" keeps every
  // downstream assertion real: vapid-key fetch, shimmed PushManager
  // subscribe, POST /push/subscriptions persistence, and the active UI.
  // Same addInitScript pattern as PUSH-03's "default" pin.
  await page.addInitScript(() => {
    try {
      Object.defineProperty(Notification, "permission", {
        configurable: true,
        get: () => "granted",
      });
    } catch {
      /* non-configurable in this engine — assertion below will surface it */
    }
  });
}

test("[PUSH-01] real PWA registers /sw.js and completes the push UI flow", async ({
  page,
  context,
}) => {
  await deploySw(context, "current");
  // Desktop setup pins "granted" (see installGrantedPermission): the CDP
  // grant is a no-op in this Chromium, and iOS prompt evidence is external.
  await installGrantedPermission(page);
  await installPushSubscriptionShim(page);
  await registerAndHome(page, "push-runtime", "/perfil");
  await waitForServiceWorker(page);

  const registration = await page.evaluate(async () => {
    const value = await navigator.serviceWorker.getRegistration();
    return {
      scriptURL: value?.active?.scriptURL ?? "",
      hasPushManager: Boolean(value && "pushManager" in value),
    };
  });
  expect(registration.scriptURL).toMatch(/\/sw\.js$/);
  expect(registration.hasPushManager).toBe(true);

  const pushResponses = capturePushResponses(page);
  const dialog = await openPushCard(page);
  const activate = dialog.getByRole("button", { name: "Ativar notificações" });
  await expect(activate).toBeVisible();
  await activate.click();
  await expect
    .poll(() => page.evaluate(() => Notification.permission), {
      timeout: 20000,
    })
    .toBe("granted");
  await expect(
    dialog.getByText("Notificações ativas", { exact: true }),
  ).toBeVisible();
  await expectPushPersistence(pushResponses);
  await expect(
    page.evaluate(
      () =>
        (window as Window & { pushSubscribeCalls?: number }).pushSubscribeCalls,
    ),
  ).resolves.toBe(1);
});

test("[PUSH-02] controlled iOS standalone uses the real UI and permission API", async ({
  browser,
}) => {
  const context = await browser.newContext({
    userAgent: IOS_USER_AGENT,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  // Standalone UI path; native iOS prompt is verified on the installed device.
  // Permission pinned "granted" (see installGrantedPermission): the CDP
  // grant is a no-op in this Chromium.
  const page = await context.newPage();
  await installGrantedPermission(page);
  await installStandaloneDisplayMode(page);
  await installPushSubscriptionShim(page);
  await deploySw(context, "current");
  await registerAndHome(page, "push-ios-standalone", "/perfil");
  await waitForServiceWorker(page);
  const pushResponses = capturePushResponses(page);
  const dialog = await openPushCard(page);
  await expect(
    dialog.getByRole("button", { name: "Ativar notificações" }),
  ).toBeVisible();
  await expect(dialog.getByText("Adicionar à Tela de Início")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Ativar notificações" }).click();
  await expect
    .poll(() => page.evaluate(() => Notification.permission), {
      timeout: 20000,
    })
    .toBe("granted");
  await expect(
    dialog.getByText("Notificações ativas", { exact: true }),
  ).toBeVisible();
  await expectPushPersistence(pushResponses);
  await expect(
    page.evaluate(
      () =>
        (window as Window & { pushSubscribeCalls?: number }).pushSubscribeCalls,
    ),
  ).resolves.toBe(1);
  await context.close();
});

test("[PUSH-03] standalone activation invokes the permission API from a user gesture", async ({
  browser,
}) => {
  const context = await browser.newContext({
    userAgent: IOS_USER_AGENT,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  // SPEC-CONTROLLED PERMISSION: Chromium headless reports
  // Notification.permission as "denied" even in a fresh context, so the spec
  // pins it to "default" explicitly — the behaviour under test is that the
  // permission API is invoked from a user gesture, not the ambient default.
  await context.clearPermissions();
  const page = await context.newPage();
  await page.addInitScript(() => {
    try {
      Object.defineProperty(Notification, "permission", {
        configurable: true,
        get: () => "default",
      });
    } catch {
      /* non-configurable in this engine — assertion below will surface it */
    }
  });
  await installStandaloneDisplayMode(page);
  await installPermissionProbe(page);
  await deploySw(context, "current");
  await registerAndHome(page, "push-ios-permission-prompt", "/perfil");
  await waitForServiceWorker(page);

  await expect(page.evaluate(() => Notification.permission)).resolves.toBe(
    "default",
  );
  const dialog = await openPushCard(page);
  const activate = dialog.getByRole("button", { name: "Ativar notificações" });
  await expect(activate).toBeVisible();
  await activate.click();

  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as Window & {
                pushPermissionProbe?: {
                  called: boolean;
                  userActivated: boolean;
                };
              }
            ).pushPermissionProbe,
        ),
      { timeout: 20000 },
    )
    .toEqual({
      called: true,
      userActivated: true,
    });
  await expect(dialog.getByRole("alert")).toBeVisible();
  await context.close();
});

test("[PUSH-04] iOS outside standalone shows installation onboarding before permission", async ({
  browser,
}) => {
  const context = await browser.newContext({
    userAgent: IOS_USER_AGENT,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await deploySw(context, "current");
  await registerAndHome(page, "push-ios-browser", "/perfil");
  const dialog = await openPushCard(page);

  await expect(dialog.getByText("Adicionar à Tela de Início")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Ativar notificações" }),
  ).toHaveCount(0);
  // Product title since the "Meu Ted" rebrand (src/app/layout.tsx metadata).
  await expect(page).toHaveTitle(/Meu Ted/i);
  await context.close();
});

