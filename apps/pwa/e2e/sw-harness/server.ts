/**
 * SW harness — native Node HTTP reverse proxy (no http-proxy dep).
 *
 * Listens on 127.0.0.1:3000, proxies to Next on 127.0.0.1:3001,
 * except /sw.js and /__e2e/sw/deploy which it owns.
 *
 * Usage:
 *   pnpm exec tsx e2e/sw-harness/server.ts --target=3001 --port=3000
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

// tsx/CJS-friendly dirname
const harnessDir = path.resolve(__dirname);

function argNum(name: string, fallback: number): number {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!raw) return fallback;
  const n = Number(raw.split("=")[1]);
  return Number.isFinite(n) ? n : fallback;
}

const TARGET_PORT = argNum("target", 3001);
const HARNESS_PORT = argNum("port", 3000);
const FIXTURE_PORT = argNum("fixture", 4010);
const TARGET_HOST = "127.0.0.1";
const FIXTURE_URL = `http://${TARGET_HOST}:${FIXTURE_PORT}`;

const LEGACY_PATH = path.join(harnessDir, "legacy-sw.js");
// Built/current SW lives in public/ after next build (serwist writes here)
const CURRENT_PATH = path.join(harnessDir, "..", "..", "public", "sw.js");

let currentSwVersion: "legacy" | "current" = "legacy";

function readSw(version: "legacy" | "current"): string {
  const p = version === "legacy" ? LEGACY_PATH : CURRENT_PATH;
  if (!fs.existsSync(p)) {
    // Fallback minimal current if build missing
    if (version === "current") {
      return `
self.addEventListener('install', () => {});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n === 'pi-finance-shell' || n.startsWith('pi-finance-shell')).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});
self.addEventListener('message', (e) => {
  const d = e.data || {};
  const k = d.type || d.action;
  if (k === 'CLEAN_UPDATE' || k === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.searchParams.has('_rsc')) return;
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    e.respondWith(fetch(req).catch(() => caches.match('/offline-shell.html').then(r => r || new Response('Offline', { status: 503 }))));
  }
});
`;
    }
    throw new Error(`Missing SW file: ${p}`);
  }
  return fs.readFileSync(p, "utf8");
}

/**
 * Mirror of rewriteCspForFixture in e2e/support/harness.ts (kept local so
 * this server stays dependency-free of @playwright/test).
 *
 * SW-served navigations are issued from the SW target and never reach
 * page-target request interception, so the page.route CSP rewrite cannot
 * apply to them. The harness proxy applies the same accommodation here, or
 * every document under SW control keeps the server-original
 * `connect-src 'self'` and the fixture API is CSP-blocked (login never
 * completes: journal full of 200s, shell never renders).
 */
function rewriteCspForFixture(csp: string): string {
  return csp
    .replace(/connect-src\s+([^;]+)/, `connect-src ${FIXTURE_URL} $1`)
    .replace(
      /script-src\s+[^;]+/,
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
    );
}

function proxyRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const headers = { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` };
  const opts: http.RequestOptions = {
    hostname: TARGET_HOST,
    port: TARGET_PORT,
    path: req.url,
    method: req.method,
    headers,
  };

  const upstream = http.request(opts, (upRes) => {
    const headers = { ...upRes.headers };
    const csp = headers["content-security-policy"];
    if (typeof csp === "string" && csp.includes("connect-src")) {
      headers["content-security-policy"] = rewriteCspForFixture(csp);
    }
    res.writeHead(upRes.statusCode ?? 502, headers);
    upRes.pipe(res);
  });

  upstream.on("error", (err) => {
    console.error("[sw-harness] proxy error:", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
    }
    res.end("Bad Gateway");
  });

  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;

  // CORS for deploy from page
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (pathname === "/__e2e/sw/deploy" && req.method === "POST") {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
          version?: string;
        };
        currentSwVersion = body.version === "current" ? "current" : "legacy";
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ ok: true, version: currentSwVersion }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  if (pathname === "/sw.js") {
    try {
      const body = readSw(currentSwVersion);
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Service-Worker-Allowed": "/",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(body);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(e));
    }
    return;
  }

  proxyRequest(req, res);
});

server.listen(HARNESS_PORT, "127.0.0.1", () => {
  console.log(
    `SW harness http://127.0.0.1:${HARNESS_PORT} → Next http://127.0.0.1:${TARGET_PORT} (sw=${currentSwVersion})`,
  );
});
