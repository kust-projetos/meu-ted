/**
 * XLT-00 (fumaça da categoria XLT, SPEC V4 §18 / INV-10).
 *
 * Camadas reais atravessadas (2):
 *   (a) configuração de segurança de produção — buildProductionEmissionHeaders()
 *       de src/proxy-utils.ts, a MESMA função que src/middleware.ts chama para
 *       carimbar cada resposta (importada aqui por referência, sem
 *       reimplementação paralela);
 *   (b) header efetivamente emitido no fio — um servidor HTTP real aplica a
 *       emissão e o teste assera o HTTP observado (navegação real do browser
 *       + fetch global), não a constante em memória.
 *
 * POR QUE NÃO EXECUTAR middleware() DIRETAMENTE: src/middleware.ts importa
 * next/server (NextRequest/NextResponse) e roda no runtime experimental-edge
 * via OpenNext/Cloudflare. Fora do runtime Next, NextResponse.next() não tem
 * contrato de execução isolada (requer o pipeline de request/response do
 * Next), então invocar o handler num processo node puro do Playwright
 * exerceria um stub, não o middleware. O invariante que o XLT-00 protege é
 * config→emissão (o que o browser recebe é o que a config produz, por
 * resposta, com nonce fresco); esse invariante vive integralmente na função
 * pura de emissão, que é a mesma referência usada pelo middleware. A
 * plumagem Next-específica (NextResponse.next, request headers) é coberta
 * pelos units de proxy/headers.
 *
 * Diferença para os units (proxy.test.ts / headers.test.ts): eles travam o
 * VALOR da config ou do artefato de build isoladamente. Este XLT prova o
 * CROSSING config→emissão por resposta, sem cópia estática no meio.
 *
 * Estado pós-T1.1: Permissions-Policy é condicional por capability
 * (buildPermissionsPolicy). O teste assera o crossing (emitido === config
 * vigente), não o valor literal — a relação capability↔header nos dois
 * sentidos é coberta pelos units de T1.1.
 */

import { test, expect } from "@playwright/test";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  buildCspValue,
  buildProductionEmissionHeaders,
  buildPermissionsPolicy,
  generateNonce,
} from "../../src/proxy-utils";

// Artefato do build Cloudflare/OpenNext (ausente sem build — check opcional).
const HEADERS_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  ".open-next",
  "assets",
  "_headers",
);

/**
 * Emissão via a MESMA função que src/middleware.ts usa, sobre um servidor
 * HTTP real: CSP por resposta com nonce fresco (modo produção: sem
 * unsafe-eval, sem localhost) + headers estáticos, com Permissions-Policy
 * construída da política fixa.
 */
function emitProductionHeaders(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const emission = buildProductionEmissionHeaders({
    nonce: generateNonce(),
    isDevelopment: false,
    micEnabled: false,
  });
  for (const [key, value] of Object.entries(emission)) {
    res.setHeader(key, value);
  }
  res.end("ok");
}

/** Valor de Permissions-Policy esperado para a política fixa. */
function expectedPermissionsPolicy(): string {
  return buildPermissionsPolicy(false);
}

let server: http.Server;
let baseURL: string;

test.beforeAll(async () => {
  server = http.createServer(emitProductionHeaders);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseURL = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

test("[XLT-00] emitted Permissions-Policy equals the production config", async ({
  page,
}) => {
  const response = await page.goto(baseURL);
  expect(response).not.toBeNull();
  const headers = response!.headers();

  // Crossing (a)→(b): o fio carrega exatamente o valor da config vigente
  // (capability → policy construída, V4 T1.1).
  expect(headers["permissions-policy"]).toBe(expectedPermissionsPolicy());
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
});

test("[XLT-00] emitted CSP binds a fresh per-response nonce (builder executes)", async () => {
  // fetch global (undici): HTTP real no fio, sem ambiguidade de API.
  const first = await fetch(baseURL);
  const second = await fetch(baseURL);
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);

  const nonceA = first.headers.get("x-nonce");
  const nonceB = second.headers.get("x-nonce");
  const cspA = first.headers.get("content-security-policy");
  const cspB = second.headers.get("content-security-policy");
  expect(nonceA).toMatch(/^[0-9a-f]{32}$/);
  expect(nonceB).toMatch(/^[0-9a-f]{32}$/);
  // Não é cópia estática: cada resposta executa o builder com nonce novo.
  expect(nonceB).not.toBe(nonceA);
  expect(cspA).toContain(`'nonce-${nonceA}'`);
  expect(cspB).toContain(`'nonce-${nonceB}'`);
  // Emissão de produção: sem escape hatch de desenvolvimento.
  for (const csp of [cspA, cspB]) {
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("127.0.0.1");
  }
});

test("[XLT-00] emitted CSP equals the production same-origin config (T2.7 G1/G2)", async () => {
  const res = await fetch(baseURL);
  expect(res.ok).toBe(true);
  const nonce = res.headers.get("x-nonce")!;
  const csp = res.headers.get("content-security-policy")!;
  // Essence preserved (emitted === config): the wire carries byte-for-byte
  // what the shared builder produces for the response nonce in production.
  expect(csp).toBe(buildCspValue(nonce, false));
  // Production contract: same-origin only, hardened directives, report target.
  expect(csp).toContain("connect-src 'self'");
  expect(csp).not.toContain("api.synkroo.com.br");
  expect(csp).not.toContain("workers.dev");
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("form-action 'self'");
  expect(csp).toContain("report-uri /api/csp-report");
});

test("[XLT-00] built _headers artifact does not shadow runtime security headers", async () => {
  test.skip(
    !fs.existsSync(HEADERS_PATH),
    "no Cloudflare build artifact present; runtime emission is authoritative",
  );
  const text = fs.readFileSync(HEADERS_PATH, "utf-8");
  const shadowing = text
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter(
      (line) =>
        line.startsWith("permissions-policy:") ||
        line.startsWith("content-security-policy:"),
    );
  // Headers dinâmicos pertencem ao middleware; o artefato estático não pode
  // publicar regra concorrente que os sobreponha no fio.
  expect(shadowing).toEqual([]);
});
