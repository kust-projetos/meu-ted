// P2 PWA real-history proof — PWA proxy/client sobre a MESMA conversa
// OpenCode persistida e reaberta pelo SDK real, sem inferência/provider.
//
// Cadeia exercitada (exata):
//   PWA client `fetchAgentHistory` ─▶ PWA proxy real (`GET` em `route.ts`,
//   ramo B com `TED_OPENCODE_GATEWAY_ORIGIN` loopback) ─▶ gateway loopback
//   real (serve child, `createGatewayServer` real) ─▶ SDK real
//   (`oc.message.list`, paginação 2.2.4) sobre o SQLite persistido.
// Rota real direta (`GET` handler) também é exercida; o client é a camada
// extra, com fallback declarado.
//
// Fases: (1) seed child persiste 120 mensagens sintéticas via
// `oc.experimental.session.import` oficial + metadados; (2) UM NOVO serve
// child reabre a mesma base em processo separado e mantém o gateway vivo;
// o teste dirige tudo por HTTP real contra esse gateway.
//
// Seams (somente teste, sem edição de aplicação):
// - `session.prompt` guardado no child (conta e lança antes de delegar);
//   `promptCalls` deve permanecer 0 — sem inferência, sem provider.
// - `transportFactory` conta chamadas financeiras (`transportCalls` = 0).
// - `resolveIdentity` sintética já presente no probe (cookie/device
//   controlados) — NÃO é Better-Auth real, declarado sem fingir.
// - flag de falha `failRead` server-side do probe (`fail`/`recover` via
//   stdin) — único fault; nenhum fault no cliente.
// - `fetchAgentConnectionToken`/`getActiveDeviceToken` mockados (mint não é
//   Better-Auth real); `getCloudflareContext` rejeitado (env via stub).
//
// Limites (declarados, não ocultos): transcript sintético sanitizado (nunca
// saída de modelo, nunca dado financeiro); sem Playwright live E2E; sem
// inferência paga; sem SQLite antigo; temp roots NUNCA apagados.
//
// Serial proposital: UM `it` executa seed → serve → healthy → reload →
// fault → recovery em sequência; worker único (`--pool=forks
// --maxWorkers=1`).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(),
}));

// Synthetic seam mirror (test-only): mesmos valores fixos do probe
// (`p2-real-history-probe.mjs` — ACTOR/DEVICE/WS/SESSION_COOKIE). O device
// aqui é o "registrado" lido pelo client após o mint mockado.
const deviceState = vi.hoisted(() => ({ current: "test-device-p2-history-01" as string | null }));

vi.mock("@/lib/api/agent-auth", () => ({
  fetchAgentConnectionToken: vi.fn(async () => "conn-p2-test-only"),
  clearAgentConnectionTokenCache: vi.fn(),
  getActiveDeviceToken: vi.fn(() => deviceState.current),
  trackAgentConnection: vi.fn((external?: AbortSignal | null) => {
    const controller = new AbortController();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", () => controller.abort(), { once: true });
    }
    return { signal: controller.signal, release: () => undefined };
  }),
}));

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { GET } from "./route";
import { fetchAgentHistory } from "@/lib/api/agent-client";
import { clearTedRuntimeViews, getTedRuntimeView } from "@/lib/api/ted-runtime-view";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.resolve(HERE, "../../../../../../ted-runtime/tests/helpers/p2-real-history-probe.mjs");

// Espelho test-only do transcript sintético do probe (nomenclatura
// `userId`/`assistantId` + textos `userText`/`assistantText`): NÃO é
// contrato de aplicação, só o fixture que o seed importou.
const TURN_COUNT = 60;
const pad2 = (i: number): string => String(i).padStart(2, "0");
const expectedIds: string[] = Array.from({ length: TURN_COUNT }, (_, i) => [
  `msg_p2_user_${pad2(i)}`,
  `msg_p2_assistant_${pad2(i)}`,
]).flat();
const expectedContents: string[] = Array.from({ length: TURN_COUNT }, (_, i) => [
  i === 0 ? "qual foi meu gasto em junho?" : `pergunta sintetica ${i}`,
  i === 0
    ? "gasto de R$ 117,50 em junho (2 transacoes) — sintese sintetica de teste, sem LLM"
    : `resposta sintetica ${i}`,
]).flat();

// Mensagem fixa sanitizada do boundary de histórico (espelho test-only de
// `HISTORY_UNAVAILABLE_MESSAGE` em `apps/ted-runtime/src/prompt.mjs`).
const HISTORY_UNAVAILABLE_FIXED =
  "history temporarily unavailable — please retry; completed turns stand";

const CHILD_TIMEOUT_MS = 180000;

// The OpenCode SDK 2.2.4 uses explicit resource management (`await using`),
// which Node 22 cannot parse: the probe then fails at import with
// sdk-unavailable. Probe children therefore run under TED_PROBE_NODE (CI sets a
// pinned Node 24); without it they use the current Node.
function probeNode(): string {
  return process.env.TED_PROBE_NODE || process.execPath;
}

function approvedTmpRoot(prefix: string): string {
  const base =
    process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local", "Temp", "opencode")
      : os.tmpdir();
  try {
    fs.mkdirSync(base, { recursive: true });
    return fs.mkdtempSync(path.join(base, `${prefix}-`));
  } catch {
    return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  }
}

type JsonRecord = Record<string, unknown>;

function lastJsonLine(stdout: string): JsonRecord | null {
  try {
    const last = stdout.trim().split("\n").filter(Boolean).pop();
    return last ? (JSON.parse(last) as JsonRecord) : null;
  } catch {
    return null;
  }
}

function runProbeOnce(args: string[], timeoutMs = CHILD_TIMEOUT_MS): Promise<{ code: unknown; stdout: string; stderr: string; json: JsonRecord | null }> {
  return new Promise((resolve) => {
    const child = spawn(probeNode(), [PROBE, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* noop */ }
    }, timeoutMs);
    if (timer.unref) timer.unref();
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String((e && e.message) || e), json: null });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: signal ? `signal:${signal}` : code, stdout, stderr, json: lastJsonLine(stdout) });
    });
  });
}

class ServeProc {
  child: ChildProcess;
  stdout = "";
  stderr = "";
  lines: string[] = [];
  ready: JsonRecord = {};
  exited = false;
  exitCode: unknown = null;

  constructor(child: ChildProcess) {
    this.child = child;
    child.stdout?.on("data", (d) => {
      const s = String(d);
      this.stdout += s;
      for (const line of s.split("\n")) {
        if (line.trim()) this.lines.push(line);
      }
    });
    child.stderr?.on("data", (d) => { this.stderr += String(d); });
    child.on("close", (code, signal) => {
      this.exited = true;
      this.exitCode = signal ? `signal:${signal}` : code;
    });
  }

  static async start(args: string[], timeoutMs = CHILD_TIMEOUT_MS): Promise<ServeProc> {
    const child = spawn(probeNode(), [PROBE, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const proc = new ServeProc(child);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ready = proc.lines.map((l) => {
        try { return JSON.parse(l) as JsonRecord; } catch { return null; }
      }).find((j) => j && j["phase"] === "serve-ready");
      if (ready) {
        proc.ready = ready;
        return proc;
      }
      if (proc.exited) {
        throw new Error(`serve encerrou antes do ready (exit=${proc.exitCode}): ${proc.stderr.slice(-800)}`);
      }
      if (Date.now() > deadline) {
        try { child.kill("SIGKILL"); } catch { /* noop */ }
        throw new Error(`serve sem ready em ${timeoutMs}ms: ${proc.stderr.slice(-800)}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private async waitForLine(predicate: (j: JsonRecord) => boolean, from: number, timeoutMs: number): Promise<JsonRecord> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let i = from; i < this.lines.length; i++) {
        try {
          const j = JSON.parse(this.lines[i]) as JsonRecord;
          if (predicate(j)) return j;
        } catch { /* linha não-JSON: ignora */ }
      }
      if (this.exited) throw new Error(`serve encerrou durante comando (exit=${this.exitCode}): ${this.stderr.slice(-800)}`);
      if (Date.now() > deadline) throw new Error(`serve sem resposta em ${timeoutMs}ms (comando sem ack)`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async cmd(line: "fail" | "recover" | "stats" | "close", timeoutMs = 30000): Promise<JsonRecord> {
    const from = this.lines.length;
    const phase = line === "stats" ? "serve-stats" : line === "close" ? "serve-closed" : "serve-ctl";
    const pending = this.waitForLine((j) => j["phase"] === phase, from, timeoutMs);
    this.child.stdin?.write(`${line}\n`);
    return pending;
  }
}

beforeEach(() => {
  vi.mocked(getCloudflareContext).mockRejectedValue(new Error("no ctx"));
  deviceState.current = "test-device-p2-history-01";
  clearTedRuntimeViews();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearTedRuntimeViews();
});

describe("P2 PWA real-history: proxy/client sobre a conversa reaberta pelo SDK real", () => {
  it("healthy → reload → 503 sanitizado → recovery, com zero prompt e zero transporte", async () => {
    const root = approvedTmpRoot("ted-pwa-p2hist");

    // 1. Seed child: transcript sintético via import oficial + metadados.
    const seedRun = await runProbeOnce(["seed", root]);
    // Surface the probe's own sanitized verdict (step/detail) when seeding fails.
    expect(seedRun.code, `seed probe failed: ${JSON.stringify(seedRun.json ?? seedRun.stderr.slice(-400))}`).toBe(0);
    expect(seedRun.json?.["ok"]).toBe(true);
    const seeded = seedRun.json as JsonRecord & {
      sessionId: string; conversationId: string; userMessageId: string;
      assistantMessageId: string; lastMessageId: string; userText: string;
      assistantText: string; messageCount: number; promptCalls: number;
    };
    expect(seeded.phase).toBe("seed");
    expect(seeded.messageCount).toBe(120);
    expect(seeded.promptCalls).toBe(0);

    // 2. NOVO serve child: mesma base/session/conversation, gateway vivo.
    const serve = await ServeProc.start([
      "serve", root,
      String(seeded.sessionId), String(seeded.conversationId),
      String(seeded.userMessageId), String(seeded.assistantMessageId),
    ]);
    const base = String(serve.ready["base"]);
    const sessionCookie = String(serve.ready["sessionCookie"] ?? "p2-seam-session=valid");
    const deviceToken = String(serve.ready["deviceToken"] ?? "test-device-p2-history-01");
    const workspace = String(serve.ready["workspace"] ?? "H_P2HIST");
    expect(base.startsWith("http://127.0.0.1:")).toBe(true);
    expect(serve.ready["sessionId"]).toBe(seeded.sessionId);
    expect(serve.ready["conversationId"]).toBe(seeded.conversationId);

    const closeServe = async (): Promise<JsonRecord | null> => {
      try {
        return await serve.cmd("close", 30000);
      } catch {
        try { serve.child.kill("SIGKILL"); } catch { /* noop */ }
        return null;
      }
    };

    try {
      // Flag de runtime só via stub (restaurada no afterEach); gateway é
      // loopback permitido pelo `resolveTedGatewayOrigin`.
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("ALLOW_LOCAL_ORIGIN", "1");
      vi.stubEnv("TED_OPENCODE_RUNTIME_ENABLED", "1");
    vi.stubEnv("TED_OPENCODE_WORKSPACES", "ws-1");
      vi.stubEnv("TED_OPENCODE_GATEWAY_ORIGIN", base);

      const pinCookie = `ted-runtime-conversation=opencode.${seeded.conversationId}`;
      const historyPath = ["agents", "finance-chat-agent", workspace, "rpc", "history"];
      const historyUrl = `http://localhost:3000/api/agent/agents/finance-chat-agent/${encodeURIComponent(workspace)}/rpc/history`;
      const directHeaders = (): Record<string, string> => ({
        cookie: `${sessionCookie}; ${pinCookie}`,
        "x-device-token": deviceToken,
        "x-workspace-id": workspace,
      });
      const getViaRoute = async (): Promise<Response> =>
        GET(
          new Request(historyUrl, { method: "GET", headers: directHeaders() }),
          { params: Promise.resolve({ path: historyPath }) },
        );
      const withClientFetch = async <T>(run: () => Promise<T>): Promise<T> => {
        const realFetch = globalThis.fetch.bind(globalThis);
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
          const s = String(url);
          if (s.startsWith("/api/agent/")) {
            const noQuery = s.split("?")[0];
            const segments = noQuery.replace(/^\/api\/agent\//, "").split("/").map(decodeURIComponent);
            const incoming = new Headers((init?.headers as HeadersInit | undefined) ?? {});
            const prevCookie = incoming.get("cookie") ?? "";
            if (!prevCookie.includes("ted-runtime-conversation")) {
              incoming.set("cookie", prevCookie ? `${prevCookie}; ${pinCookie}` : `${sessionCookie}; ${pinCookie}`);
            }
            const req = new Request(`http://localhost:3000${s}`, {
              method: (init as RequestInit | undefined)?.method ?? "GET",
              headers: incoming,
            });
            return GET(req, { params: Promise.resolve({ path: segments }) });
          }
          return realFetch(url, init);
        });
        try {
          return await run();
        } finally {
          fetchSpy.mockRestore();
        }
      };

      // 3. Rota PWA real → gateway loopback real → SDK `message.list` real.
      const healthyRes = await getViaRoute();
      expect(healthyRes.status).toBe(200);
      expect(healthyRes.headers.get("x-ted-runtime")).toBe("opencode");
      const healthyText = await healthyRes.text();
      expect(healthyText.includes(String(seeded.sessionId))).toBe(false);
      const healthy = JSON.parse(healthyText) as { items: Array<{ id: string; role: string; content: string; createdAt: string; isOwn: boolean }> };
      expect(healthy.items.length).toBe(120);
      expect(healthy.items.map((i) => i.id)).toEqual(expectedIds);
      expect(healthy.items.map((i) => i.content)).toEqual(expectedContents);
      expect(healthy.items[0].content).toBe(seeded.userText);
      expect(healthy.items[1].content).toBe(seeded.assistantText);
      expect(new Set(healthy.items.map((i) => i.id)).size).toBe(120);
      for (let i = 1; i < healthy.items.length; i++) {
        expect(Date.parse(healthy.items[i].createdAt)).toBeGreaterThan(Date.parse(healthy.items[i - 1].createdAt));
      }
      for (let i = 0; i < healthy.items.length; i += 2) {
        expect(healthy.items[i].role).toBe("user");
        expect(healthy.items[i].isOwn).toBe(true);
        expect(healthy.items[i + 1].role).toBe("assistant");
        expect(healthy.items[i + 1].isOwn).toBe(false);
      }

      // 4. Mesmo client PWA `fetchAgentHistory` sobre a mesma cadeia: o
      // `fetch` relativo `/api/agent/...` é desviado ao `GET` real acima
      // (headers do client preservados + cookie sintético do seam); o resto
      // vai ao `fetch` original (gateway loopback). Só o mint é mockado —
      // sem fingir Better-Auth real.
      await withClientFetch(async () => {
        const viaClient = await fetchAgentHistory(workspace);
        expect(viaClient.length).toBe(120);
        expect(viaClient.map((i) => i.id)).toEqual(expectedIds);
        expect(viaClient[0].content).toBe(seeded.userText);
        expect(viaClient[1].content).toBe(seeded.assistantText);
        expect(getTedRuntimeView(workspace)).toBe("opencode");
      });

      // 5. Reload/mount: segundo GET devolve o MESMO transcript, sem prompt.
      const repeatRes = await getViaRoute();
      expect(repeatRes.status).toBe(200);
      const repeatText = await repeatRes.text();
      expect(repeatText).toBe(healthyText);

      let stats = await serve.cmd("stats");
      expect(stats["promptCalls"]).toBe(0);
      expect(stats["transportCalls"]).toBe(0);
      expect(Number(stats["messageLists"])).toBeGreaterThan(0);

      // 6. Falha injetada server-side APÓS um saudável: PWA vê 503
      // `history.unavailable` com a mensagem fixa sanitizada.
      const failed = await serve.cmd("fail");
      expect(failed["failRead"]).toBe(true);
      const brokenRes = await getViaRoute();
      expect(brokenRes.status).toBe(503);
      expect(brokenRes.headers.get("x-ted-runtime")).toBe("opencode");
      const broken = (await brokenRes.json()) as { code?: string; message?: string };
      const brokenRaw = JSON.stringify(broken);
      expect(broken.code).toBe("history.unavailable");
      expect(broken.message).toBe(HISTORY_UNAVAILABLE_FIXED);
      expect(brokenRaw.includes("connection reset")).toBe(false);
       expect(brokenRaw.includes("prompt.failed")).toBe(false);
       expect(brokenRaw.includes(String(seeded.sessionId))).toBe(false);
       const clientError = await withClientFetch(async () =>
         fetchAgentHistory(workspace).then(
           () => null,
           (error: unknown) => error as Error & { status?: number; code?: string },
         ),
       );
       expect(clientError?.status).toBe(503);
       expect(clientError?.code).toBe("history.unavailable");
       expect(clientError?.message).toBe(HISTORY_UNAVAILABLE_FIXED);

      // 7. Restaura e um novo GET histórico recupera os MESMOS IDs — sem
      // chat/prompt entre o fault e o recovery.
      const healed = await serve.cmd("recover");
      expect(healed["failRead"]).toBe(false);
      const recoveredRes = await getViaRoute();
      expect(recoveredRes.status).toBe(200);
       const recoveredText = await recoveredRes.text();
       expect(recoveredText).toBe(healthyText);
       const recoveredClient = await withClientFetch(() => fetchAgentHistory(workspace));
       expect(recoveredClient.map((item) => item.id)).toEqual(expectedIds);

      stats = await serve.cmd("stats");
      expect(stats["promptCalls"]).toBe(0);
      expect(stats["transportCalls"]).toBe(0);
      expect(Number(stats["messageLists"])).toBeGreaterThan(0);

      const closed = await closeServe();
      expect(closed?.["promptCalls"]).toBe(0);
      expect(closed?.["transportCalls"]).toBe(0);
    } catch (e) {
      await closeServe();
      throw e;
    }
  }, 300000);
});
