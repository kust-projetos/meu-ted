/**
 * Pi Finance SW — network-only navigation + offline shell fallback.
 *
 * Rules (design / Task 8):
 * - Never cache route HTML or `_rsc` responses
 * - Precache only offline-shell.html/js
 * - On navigation network failure → offline shell
 * - On activate → delete legacy `pi-finance-shell` (+ outdated caches)
 * - CLEAN_UPDATE (type or action) → skipWaiting
 */

import { installSerwist } from "@serwist/sw";
import { CacheFirst } from "serwist";
import { z } from "zod";

export const pwaControlSchema = z.object({
  type: z.string().optional(),
  action: z.string().optional(),
  enabled: z.boolean().optional(),
}).passthrough();

// Service worker global (Serwist build injects into worker scope)
interface SWGlobal {
  skipWaiting: () => void;
  registration: {
    showNotification: (
      title: string,
      options?: NotificationOptions,
    ) => Promise<void>;
  };
  clients: {
    claim: () => Promise<void>;
    matchAll: (options?: {
      type?: string;
      includeUncontrolled?: boolean;
    }) => Promise<
      Array<{
        focus?: () => Promise<void>;
        navigate?: (url: string) => Promise<unknown>;
        postMessage?: (message: unknown) => void;
      }>
    >;
    openWindow: (url: string) => Promise<unknown>;
  };
  addEventListener: (type: string, listener: (event: SWEvent) => void) => void;
  __SW_MANIFEST?: Array<{ url: string; revision: string | null }>;
}
interface SWEvent extends Event {
  request?: Request;
  respondWith?: (p: Promise<Response>) => void;
  waitUntil?: (p: Promise<unknown>) => void;
  data?: {
    type?: string;
    action?: string;
    eventType?: string;
    json?: () => unknown;
  } | null;
  notification?: { close: () => void; data?: { url?: unknown } };
}
declare const self: SWGlobal;

// Serwist injects the build manifest at compile time (kept referenced).
void self.__SW_MANIFEST;

const CACHE_PREFIX = "pi-finance";
const LEGACY_SHELL = "pi-finance-shell";
const STATIC_CACHE = "pi-finance-static";
const OFFLINE_HTML = "/offline-shell.html";
const OFFLINE_JS = "/offline-shell.js";

/**
 * Offline shell precache with real content revisions (P1-6).
 *
 * `revision: null` would tell Serwist the URL never changes, so shell fixes
 * would never propagate to already-installed SWs. Revisions are the sha256 of
 * each bundled file; src/sw-precache.test.ts fails when a file changes without
 * updating its revision here.
 */
export const SHELL_PRECACHE_ENTRIES: ReadonlyArray<{
  url: string;
  revision: string;
}> = [
  {
    url: OFFLINE_HTML,
    revision: "sha256-b0d5ce1d0d7debb625ffd6a73f098f7db600fc755dcfe79d7be91c2e1bd98614",
  },
  {
    url: OFFLINE_JS,
    // T07b: shell reads the V3 single-slot (ownerKey + TTL) with a legacy
    // V2 fallback, covering /compromissos and /hub/* — revision bumped to
    // the new content hash.
    revision: "sha256-30a5f589ad191dac08bab3b3297e740d6c2994d94013c5cdbd0e9f004ffe0b1a",
  },
];

installSerwist({
  skipWaiting: false,
  clientsClaim: true,
  navigationPreload: false,
  cleanupOutdatedCaches: true,
  // Only offline shell is precached — never route HTML.
  precacheEntries: [...SHELL_PRECACHE_ENTRIES],
  runtimeCaching: [
    // Hashed static assets only (never HTML / RSC).
    {
      matcher: ({ url, request }: { url: URL; request: Request }) => {
        if (request.mode === "navigate") return false;
        if (url.searchParams.has("_rsc")) return false;
        return /^\/_next\/static\/.+\.(js|css|woff2?|png|jpg|svg|ico|webp)$/i.test(
          url.pathname,
        );
      },
      handler: new CacheFirst({ cacheName: STATIC_CACHE }),
    },
  ],
});

/** True when this is a document navigation (or HTML accept). */
function isNavigationRequest(request: Request): boolean {
  if (request.mode === "navigate") return true;
  const accept = request.headers.get("accept") || "";
  return accept.includes("text/html");
}

function isRscRequest(url: URL): boolean {
  return url.searchParams.has("_rsc");
}

async function offlineShellResponse(): Promise<Response> {
  // Precache entries carry real sha256 revisions (P1-6), so Serwist stores
  // them under revisioned keys (`URL?__WB_REVISION__=<rev>`). A bare
  // caches.match misses them — ignoreSearch resolves the revisioned entry.
  const cached = await caches.match(OFFLINE_HTML, { ignoreSearch: true });
  if (cached) return cached;
  return new Response("Offline", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

// Activate: drop legacy shell cache + claim clients
self.addEventListener("activate", (event: SWEvent) => {
  event.waitUntil?.(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (n: string) =>
              n === LEGACY_SHELL ||
              n.startsWith(`${LEGACY_SHELL}-`) ||
              (n.startsWith(CACHE_PREFIX) &&
                n.includes("shell") &&
                !n.includes("static") &&
                !n.includes("precache")),
          )
          .map((n: string) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

const safeNotificationText = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, 160)
    : fallback;

const safeNotificationUrl = (value: unknown): string =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : "/";

function broadcastAdoptionEvent(eventType: string): Promise<void> {
  if (typeof self.clients.matchAll !== "function") return Promise.resolve();
  return self.clients
    .matchAll({ type: "window", includeUncontrolled: true })
    .then((windows) => {
      windows[0]?.postMessage?.({ type: "ADOPTION_EVENT", eventType });
    });
}
self.addEventListener("push", (event: SWEvent) => {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = event.data?.json?.();
    if (parsed && typeof parsed === "object")
      payload = parsed as Record<string, unknown>;
  } catch {
    // Malformed push payloads still receive a generic notification.
  }
  const title = safeNotificationText(payload.title, "Meu Ted");
  const body = safeNotificationText(
    payload.body,
    "Você tem uma nova atualização.",
  );
  const url = safeNotificationUrl(payload.url);
  event.waitUntil?.(
    self.registration
      .showNotification(title, {
        body,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        data: { url },
      })
      .then(() => broadcastAdoptionEvent("notification_delivered")),
  );
});

self.addEventListener("notificationclick", (event: SWEvent) => {
  const url = safeNotificationUrl(event.notification?.data?.url);
  event.notification?.close();
  event.waitUntil?.(
    (async () => {
      await broadcastAdoptionEvent("notification_opened");
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const existing = windows[0];
      if (existing?.focus) {
        await existing.focus();
        await existing.navigate?.(url);
        return;
      }
      const markedUrl = `${url}${url.includes("?") ? "&" : "?"}pwa_adoption=notification_opened`;
      await self.clients.openWindow(markedUrl);
    })(),
  );
});

// Messages from page coordinator
self.addEventListener("message", (event: SWEvent) => {
  const data = event.data || {};
  const kind = data.type || data.action;
  if (kind === "CLEAN_UPDATE" || kind === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (kind === "KILL_SWITCH") {
    caches.keys().then((names: string[]) => {
      names
        .filter((n: string) => n.startsWith(CACHE_PREFIX))
        .forEach((n: string) => caches.delete(n));
    });
  }
});

// Fetch: network-only navigations with offline-shell fallback; never cache HTML/RSC
self.addEventListener("fetch", (event: SWEvent) => {
  const request = event.request!;
  const url = new URL(request.url);

  // Kill-switch probe
  if (url.pathname === "/pwa-control" && request.method === "GET") {
    event.respondWith?.(
      fetch(request).then((res: Response) => {
        if (res.ok) {
          res
            .clone()
            .json()
            .then((body: { enabled?: boolean }) => {
              if (body?.enabled === false) {
                caches.keys().then((names: string[]) => {
                  names
                    .filter((n: string) => n.startsWith(CACHE_PREFIX))
                    .forEach((n: string) => caches.delete(n));
                });
              }
            })
            .catch(() => {});
        }
        return res;
      }),
    );
    return;
  }

  // Never intercept/cache RSC
  if (isRscRequest(url)) {
    return; // default network
  }

  // Navigation / HTML: network-only; offline shell only after failure
  if (request.method === "GET" && isNavigationRequest(request)) {
    event.respondWith?.(
      fetch(request)
        .then((res: Response) => {
          // Do not put HTML into any cache
          return res;
        })
        .catch(() => offlineShellResponse()),
    );
  }
});
