// P2D live-prep — behavioral contract (node:test).
//
// Prep-only, sem chave real: usa .env falsos em tmp isolado com valor dummy.
// NUNCA acessa o `.env` real (raiz ou `../pi-financeiro/.env`).
//
// Contrato (pós-review: Playwright é o dono dos serviços):
// - API/PWA/stack vivem no ciclo de vida `webServer` do Playwright
//   (`e2e/playwright.config.ts`, projeto `p2d-synthetic`); nenhum código
//   novo os inicia ou supervisiona (guarda estático abaixo).
// - O launcher (`p2d-live-prep.mjs`) é inerte no import; o único opt-in que
//   inicia teste é invocá-lo como CLI (delega ao Playwright com
//   `P2D_LIVE_PREP=1` + `-g p2d-live-prep`).
// - O único boot de runtime vive no worker Playwright (processo isolado):
//   env allowlisted aplicado antes do import do SDK e restaurado em
//   `finally` em sucesso/falha; sem processo filho, sem supervisor.
// - Fonte: primeiro `<repo root>/.env`, depois APENAS o checkout sibling
//   `../pi-financeiro/.env` (sem busca genérica), sempre `parseEnv`,
//   fail-closed, sem expor valor/path sensível.
// - Env mínimo por allowlist: sem `process.env` espalhado (sem NODE_OPTIONS,
//   proxies, provider keys, DATABASE_URL); segredo só no env do runtime
//   live (worker Playwright dedicado, restaurado depois).
// - Receipt estrito por allowlist de chaves, `listenerExposed:false`
//   obrigatório (prep-only por construção: sem listener live, sem prompt).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE_SUPPORT = path.dirname(fileURLToPath(import.meta.url));
const PREP_FILE = path.join(HERE_SUPPORT, "p2d-live-prep.mjs");
const SPEC_FILE = path.join(HERE_SUPPORT, "..", "p2d", "p2d-live-prep.spec.ts");
const CONFIG_FILE = path.join(HERE_SUPPORT, "..", "playwright.config.ts");

import {
  LIVE_CREDENTIAL_ALIAS,
  LIVE_CREDENTIAL_TARGET,
  NEXT_ENV_BLOCKED_NAMES,
  assertIsolatedHome,
  assertNoBlockingNextEnvFiles,
  assertNoFinancialWrites,
  buildLiveRuntimeEnv,
  buildPlaywrightEnv,
  defaultSiblingEnvFile,
  expectApiHealthBody,
  expectGatewayNotFound,
  findBlockingNextEnvFiles,
  isCliEntry,
  isLoopbackOrigin,
  loadLiveCredential,
  loadLiveModelSelector,
  pickSpawnBase,
  resolveConfiguredLiveModel,
  resolveLiveEnvCandidates,
  sanitizePrepError,
  validateLivePrepReceipt,
  withLiveBootBoundary,
  withScrubbedEnv,
  LIVE_BOOT_FAILURE_MESSAGE,
} from "./p2d-live-credential.mjs";

const DUMMY = "test-dummy-not-a-secret";
const DUMMY2 = "test-dummy-sibling-secret";

function makeRoot(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p2d-live-cred-test-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, "utf8");
  }
  return dir;
}

describe("p2d-live-credential contract (Playwright owns services)", () => {
  it("usa alias OPENCODE_GO -> OPENCODE_GO_API_KEY (nomes do contrato)", () => {
    assert.equal(LIVE_CREDENTIAL_ALIAS, "OPENCODE_GO");
    assert.equal(LIVE_CREDENTIAL_TARGET, "OPENCODE_GO_API_KEY");
  });

  it("candidatos: exatamente [raiz/.env, ../pi-financeiro/.env], sem busca genérica", () => {
    const root = path.join(os.tmpdir(), "p2d-candidates-probe");
    const cands = resolveLiveEnvCandidates({ rootDir: root });
    assert.equal(cands.length, 2);
    assert.equal(cands[0], path.join(root, ".env"));
    assert.equal(cands[1], path.resolve(root, "../pi-financeiro/.env"));
    assert.equal(defaultSiblingEnvFile(root), cands[1]);
  });

  it("raiz vence o sibling quando ambos têm o alias", () => {
    const siblingDir = makeRoot({ ".env": `OPENCODE_GO=${DUMMY2}\n` });
    const rootDir = makeRoot({ ".env": `OPENCODE_GO=${DUMMY}\n` });
    const cred = loadLiveCredential({ rootDir, siblingEnvFile: path.join(siblingDir, ".env") });
    assert.equal(cred.value, DUMMY);
  });

  it("sibling como fallback: raiz ausente ou sem alias", () => {
    const siblingDir = makeRoot({ ".env": `OPENCODE_GO=${DUMMY2}\n` });
    const siblingFile = path.join(siblingDir, ".env");
    const noRoot = path.join(os.tmpdir(), "p2d-live-no-such-root-890123");
    assert.equal(loadLiveCredential({ rootDir: noRoot, siblingEnvFile: siblingFile }).value, DUMMY2);
    const rootNoAlias = makeRoot({ ".env": "OUTRA_CHAVE=abc\n" });
    assert.equal(loadLiveCredential({ rootDir: rootNoAlias, siblingEnvFile: siblingFile }).value, DUMMY2);
  });

  it("fail-closed sem alias em nenhum local: sem valor, sem path absoluto", () => {
    const siblingDir = makeRoot({ ".env": "OUTRA=1\n" });
    const rootDir = makeRoot({ ".env": "OUTRA=2\n" });
    assert.throws(
      () => loadLiveCredential({ rootDir, siblingEnvFile: path.join(siblingDir, ".env") }),
      /OPENCODE_GO/,
    );
    try {
      loadLiveCredential({ rootDir, siblingEnvFile: path.join(siblingDir, ".env") });
      assert.fail("deveria falhar");
    } catch (e) {
      const msg = String((e && e.message) || e);
      assert.ok(!msg.includes(DUMMY));
      assert.ok(!msg.includes(DUMMY2));
      assert.ok(!msg.includes(rootDir));
      assert.ok(!msg.includes(siblingDir));
    }
  });

  it("pickSpawnBase: allowlist mínima, case-insensitive para PATH", () => {
    const dirty = {
      PATH: "/usr/bin",
      NODE_OPTIONS: "--inspect",
      HTTP_PROXY: "http://proxy:8080",
      OPENAI_API_KEY: "sk-test",
      OPENCODE_GO_API_KEY: "should-never-propagate",
      OPENCODE_GO: "should-never-propagate-alias",
      DATABASE_URL: "postgres://localhost/x",
      SOME_UNRELATED_SECRET: "unrelated-test-secret",
    };
    const out = pickSpawnBase({ ...dirty, Path: "C:\\win", SystemRoot: "C:\\Windows", TEMP: "t", HOME: "/h" });
    assert.equal(out.PATH, "/usr/bin");
    assert.equal(out.SystemRoot, "C:\\Windows");
    for (const k of [
      "NODE_OPTIONS", "HTTP_PROXY", "OPENCODE_GO_API_KEY", "OPENCODE_GO",
      "DATABASE_URL", "SOME_UNRELATED_SECRET", "OPENAI_API_KEY",
    ]) {
      assert.ok(!(k in out), `${k} deve ser descartado`);
    }
    assert.ok(!Object.values(out).includes("should-never-propagate"));
  });

  it("runtime live: segredo só no target, TED_* explícitos, sem proxies/secrets", () => {
    const dirty = {
      PATH: "/usr/bin",
      NODE_OPTIONS: "--inspect",
      HTTP_PROXY: "http://proxy:8080",
      OPENAI_API_KEY: "sk-test",
      OPENCODE_GO_API_KEY: "should-never-propagate",
      OPENCODE_GO: "should-never-propagate-alias",
      DATABASE_URL: "postgres://localhost/x",
      SOME_UNRELATED_SECRET: "unrelated-test-secret",
    };
    const isoHome = path.join(os.tmpdir(), "p2d-iso-home-probe");
    const runtimeEnv = buildLiveRuntimeEnv({
      baseEnv: dirty,
      credentialValue: DUMMY,
      tedHome: isoHome,
      tedIdentity: "live-prep",
      apiBaseUrl: "http://127.0.0.1:4110",
    });
    assert.equal(runtimeEnv.OPENCODE_GO_API_KEY, DUMMY);
    assert.ok(!("OPENCODE_GO" in runtimeEnv));
    assert.equal(runtimeEnv.TED_RUNTIME_PROFILE, "live");
    assert.equal(runtimeEnv.TED_RUNTIME_HOME, isoHome);
    assert.equal(runtimeEnv.TED_API_BASE_URL, "http://127.0.0.1:4110");
    for (const k of ["NODE_OPTIONS", "HTTP_PROXY", "DATABASE_URL", "SOME_UNRELATED_SECRET", "OPENAI_API_KEY"]) {
      assert.ok(!(k in runtimeEnv), `${k} não pode vazar ao runtime`);
    }
    assert.throws(() => buildLiveRuntimeEnv({ baseEnv: {}, credentialValue: "" }), /credential/i);
    assert.throws(
      () => buildLiveRuntimeEnv({ baseEnv: {}, credentialValue: DUMMY, apiBaseUrl: "https://api.synkroo.com.br" }),
      /loopback/i,
    );
  });

  it("playwright launcher: env suja perde secrets/NODE_OPTIONS, mantém base + flags P2D", () => {
    const dirty = {
      PATH: "/usr/bin",
      SystemRoot: "C:\\Windows",
      TEMP: "t",
      NODE_OPTIONS: "--inspect",
      HTTP_PROXY: "http://proxy:8080",
      HTTPS_PROXY: "http://proxy:8080",
      OPENAI_API_KEY: "sk-test",
      OPENCODE_GO_API_KEY: "should-never-propagate",
      OPENCODE_GO: "should-never-propagate-alias",
      GH_TOKEN: "gh-test",
      DATABASE_URL: "postgres://localhost/x",
      SOME_UNRELATED_SECRET: "unrelated-test-secret",
      P2D_BROWSER: "0",
      P2D_LIVE_PREP: "0",
    };
    const out = buildPlaywrightEnv({ ...dirty, P2D_API_PORT: "4110", P2D_NEXT_PORT: "nope" });
    assert.equal(out.PATH, "/usr/bin");
    assert.equal(out.SystemRoot, "C:\\Windows");
    assert.equal(out.TEMP, "t");
    for (const k of [
      "NODE_OPTIONS", "HTTP_PROXY", "HTTPS_PROXY", "OPENAI_API_KEY",
      "OPENCODE_GO_API_KEY", "OPENCODE_GO", "GH_TOKEN",
      "DATABASE_URL", "SOME_UNRELATED_SECRET",
    ]) {
      assert.ok(!(k in out), `${k} não pode vazar ao Playwright/webServers`);
    }
    assert.ok(!Object.values(out).includes("should-never-propagate"));
    // Somente flags P2D necessárias, forçadas pelo launcher.
    assert.equal(out.P2D_BROWSER, "1");
    assert.equal(out.P2D_LIVE_PREP, "1");
    assert.equal(out.P2D_API_PORT, "4110");
    assert.ok(!("P2D_NEXT_PORT" in out), "porta inválida é omitida (config aplica o default)");
  });

  it("isLoopbackOrigin: aceita só origem nua loopback http(s)", () => {
    assert.equal(isLoopbackOrigin("http://127.0.0.1:4110"), true);
    assert.equal(isLoopbackOrigin("http://localhost:4110"), true);
    assert.equal(isLoopbackOrigin("http://[::1]:4110"), true);
    assert.equal(isLoopbackOrigin("https://127.0.0.1:4110"), true);
    assert.equal(isLoopbackOrigin("https://api.synkroo.com.br"), false);
    assert.equal(isLoopbackOrigin("http://127.0.0.1:4110/com-path"), false);
    assert.equal(isLoopbackOrigin("http://user:pass@127.0.0.1:4110"), false);
    assert.equal(isLoopbackOrigin(""), false);
  });

  it("expectApiHealthBody: GET /health sintética com shape esperado", () => {
    assert.doesNotThrow(() =>
      expectApiHealthBody({ status: "ok", gitSha: "dev", buildId: "dev", builtAt: "dev" }),
    );
    assert.throws(() => expectApiHealthBody({ status: "fail" }), /health/i);
    assert.throws(() => expectApiHealthBody({ status: "ok" }), /health/i);
    assert.throws(() => expectApiHealthBody(null), /health/i);
  });

  it("expectGatewayNotFound: 404 Fastify esperado prova resposta sem prompt", () => {
    assert.doesNotThrow(() =>
      expectGatewayNotFound({ status: 404, body: { code: "gateway.not_found", message: "unknown route" } }),
    );
    assert.throws(() => expectGatewayNotFound({ status: 200, body: {} }), /404|not_found/i);
    assert.throws(() => expectGatewayNotFound({ status: 404, body: { code: "other" } }), /not_found/i);
  });

  it("validateLivePrepReceipt: receipt estrito, sem listener live", () => {
    const good = {
      ok: true,
      phase: "live-prep-ready",
      profile: "live",
      model: "opencode-go/deepseek-v4.1-flash",
      credentialPresent: true,
      apiLoopback: true,
      listenerExposed: false,
    };
    assert.doesNotThrow(() => validateLivePrepReceipt(good, { expectedModel: "opencode-go/deepseek-v4.1-flash" }));
    assert.throws(() => validateLivePrepReceipt({ ...good, listenerExposed: true }, {}), /listen/i);
    assert.throws(() => validateLivePrepReceipt({ ...good, gatewayBase: "http://127.0.0.1:3222" }, {}), /unexpected key/i);
    assert.throws(() => validateLivePrepReceipt({ ...good, promptCalls: 0 }, {}), /unexpected key/i);
    assert.throws(() => validateLivePrepReceipt({ ...good, profile: "test" }, {}), /profile/i);
    assert.throws(() => validateLivePrepReceipt({ ...good, model: "outro/modelo" }, { expectedModel: good.model }), /model/i);
    assert.throws(() => validateLivePrepReceipt({ ...good, credentialPresent: false }, {}), /credential/i);
    assert.throws(() => validateLivePrepReceipt({ ...good, apiLoopback: false }, {}), /loopback/i);
  });

  it("sanitizePrepError: redacta valor mesmo fragmentado, limita tamanho", () => {
    const err = new Error(`falhou em ${DUMMY.slice(0, 10)} + ${DUMMY.slice(10)} no meio`);
    const msg = sanitizePrepError(err, DUMMY);
    assert.ok(!msg.includes(DUMMY));
    assert.ok(!msg.includes(DUMMY.slice(0, 10) + DUMMY.slice(10)));
    assert.ok(msg.length > 0 && msg.length <= 300);
    assert.equal(sanitizePrepError(new Error("x"), undefined), "x");
  });

  it("limite do boot: erro com credencial vira erro novo sanitizado, sem cause/stack original", () => {
    const leaked = new Error(`sdk falhou com key=${DUMMY} no contexto`);
    leaked.code = "sdk_boot_failed";
    leaked.cause = new Error(`causa interna ${DUMMY}`);
    const thrown = new Error(sanitizePrepError(leaked, DUMMY));
    assert.equal(thrown.cause, undefined);
    assert.ok(!String(thrown.message).includes(DUMMY));
    assert.ok(!String(thrown.stack).includes(DUMMY));
    const sentinelLike = new Error("listener disabled in prep-only");
    sentinelLike.code = "live_prep_no_listen";
    assert.equal(sentinelLike.code, "live_prep_no_listen");
  });

  it("fronteira real: literal/codificada/fragmentada viram texto fixo, sem segredo, env restaurado", async () => {
    assert.equal(LIVE_BOOT_FAILURE_MESSAGE, "p2d-live-prep: live runtime boot failed (details redacted)");
    const variants = [
      DUMMY,
      encodeURIComponent(DUMMY),
      Buffer.from(DUMMY, "utf8").toString("base64"),
      DUMMY.slice(4, 18),
    ];
    for (const secret of variants) {
      const target = { KEEP: "1", DROP: "x" };
      let caught = null;
      try {
        await withLiveBootBoundary({ PLANTED: secret }, async () => {
          const boom = new Error(`falhou com ${secret} no meio`);
          boom.cause = new Error(`interna ${DUMMY}`);
          assert.ok(String(boom.message).includes(secret), "sanity: o erro original continha o segredo");
          throw boom;
        }, target);
        assert.fail("deveria falhar");
      } catch (e) {
        caught = e;
      }
      assert.ok(caught instanceof Error);
      assert.equal(caught.message, LIVE_BOOT_FAILURE_MESSAGE);
      assert.equal(caught.cause, undefined);
      assert.ok(!String(caught.message).includes(DUMMY));
      assert.ok(!String(caught.stack).includes(DUMMY));
      assert.ok(!String(caught.stack).includes(encodeURIComponent(DUMMY)));
      assert.ok(!String(caught.stack).includes(Buffer.from(DUMMY, "utf8").toString("base64")));
      assert.deepEqual(target, { KEEP: "1", DROP: "x" });
    }
  });

  it("fronteira real: throw não-Error com segredo vira texto fixo", async () => {
    const target = {};
    let caught = null;
    try {
      await withLiveBootBoundary({}, async () => {
        // eslint-disable-next-line no-throw-literal
        throw `string crua ${DUMMY}`;
      }, target);
      assert.fail("deveria falhar");
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Error);
    assert.equal(caught.message, LIVE_BOOT_FAILURE_MESSAGE);
    assert.equal(caught.cause, undefined);
    assert.ok(!String(caught.stack).includes(DUMMY));
    assert.deepEqual(target, {});
  });

  it("fronteira real: falha no swap do env vira texto fixo, sem segredo", async () => {
    const evil = {};
    Object.defineProperty(evil, "BOOM", {
      get() {
        throw new Error(`boom-apply ${DUMMY}`);
      },
      enumerable: true,
    });
    const target = { KEEP: "1" };
    let caught = null;
    try {
      await withLiveBootBoundary(evil, async () => "ok", target);
      assert.fail("deveria falhar");
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Error);
    assert.equal(caught.message, LIVE_BOOT_FAILURE_MESSAGE);
    assert.ok(!String(caught.stack).includes(DUMMY));
    assert.deepEqual(target, { KEEP: "1" });
  });

  it("fronteira real: falha no restore vira texto fixo, sem segredo", async () => {
    const backing = { KEEP: "1" };
    let deletes = 0;
    const target = new Proxy(backing, {
      deleteProperty(t, p) {
        deletes += 1;
        if (deletes > 1) throw new Error(`restore-boom ${DUMMY}`);
        return Reflect.deleteProperty(t, p);
      },
    });
    let caught = null;
    try {
      await withLiveBootBoundary({ FRESH: "x" }, async () => "ok", target);
      assert.fail("deveria falhar");
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Error);
    assert.equal(caught.message, LIVE_BOOT_FAILURE_MESSAGE);
    assert.ok(!String(caught.stack).includes(DUMMY));
  });

  it("fronteira real: sucesso devolve o valor e restaura o env", async () => {
    const target = { KEEP: "1", DROP: "x" };
    const seen = await withLiveBootBoundary({ PATH: "/bin", ONLY_NEW: "n" }, async (env) => {
      assert.deepEqual({ ...env }, { PATH: "/bin", ONLY_NEW: "n" });
      return "ok-value";
    }, target);
    assert.equal(seen, "ok-value");
    assert.deepEqual(target, { KEEP: "1", DROP: "x" });
  });

  it("outer boundary é a fronteira dedicada; sem raw throw (estático)", () => {
    const src = fs.readFileSync(SPEC_FILE, "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[^\S\r\n]*\/\/[^\r\n]*/gm, "");
    const start = code.indexOf("async function runLiveBootOnce");
    const end = code.indexOf("\nasync function getJson");
    assert.ok(start !== -1 && end > start, "função de boot encontrada");
    const fn = code.slice(start, end);
    // O boot INTEIRO passa pela fronteira dedicada (swap, validações,
    // model, import, live boot, restore) — nenhum withScrubbedEnv direto.
    assert.ok(fn.includes("await withLiveBootBoundary(runtimeEnv, async () => {"), "boot passa pela fronteira dedicada");
    assert.ok(!fn.includes("withScrubbedEnv("), "sem withScrubbedEnv direto (via fronteira)");
    // Sem outer try/catch próprio: a fronteira dedicada trata tudo.
    assert.ok(!fn.includes("} catch {"), "sem catch local: só a fronteira trata erro");
    // Saída única em texto fixo mora na fronteira, não na spec.
    assert.ok(fn.includes("throw new Error(LIVE_BOOT_FAILURE_MESSAGE)"), "saída única em texto fixo");
    assert.ok(fn.includes("live_prep_no_listen"), "spec deve preservar o sentinel como sucesso de wiring");
    assert.ok(!fn.includes("sanitizeBootError("), "sem sanitização parcial (mensagem fixa cobre tudo)");
    assert.ok(!fn.includes("sanitizePrepError("), "sem sanitização parcial (mensagem fixa cobre tudo)");
    // Funil único: nenhum erro capturado é relançado cru.
    for (const raw of ["throw e;", "throw err;", "throw error;", "throw inner;", "throw ex;", "throw boundary;", "throw failure;", "throw bootFailure;", "throw primaryError;"]) {
      assert.ok(!fn.includes(raw), `sem relançamento cru (${raw})`);
    }
  });

  it("preflight Next env: bloqueia arquivos que o Next carregaria (nomes apenas)", () => {
    assert.deepEqual(
      [...NEXT_ENV_BLOCKED_NAMES].sort(),
      [".env", ".env.development", ".env.development.local", ".env.local"].sort(),
    );
    const dir = makeRoot({ ".env.example": "OPENCODE_GO=x\n" });
    assert.deepEqual(findBlockingNextEnvFiles(dir), []);
    assert.doesNotThrow(() => assertNoBlockingNextEnvFiles(dir));
    const withLocal = makeRoot({
      ".env.example": "OPENCODE_GO=x\n",
      ".env.local": Buffer.from([0x00, 0x01, 0x02, 0xff]).toString("binary"),
    });
    assert.deepEqual(findBlockingNextEnvFiles(withLocal), [".env.local"]);
    assert.throws(() => assertNoBlockingNextEnvFiles(withLocal), /\.env\.local/);
    try {
      assertNoBlockingNextEnvFiles(withLocal);
      assert.fail("deveria falhar");
    } catch (e) {
      const msg = String((e && e.message) || e);
      assert.ok(!msg.includes(withLocal));
      assert.ok(msg.includes(".env.local"));
    }
  });

  it("findBlockingNextEnvFiles: ignora só ENOENT; EACCES falha fechado sem path/conteúdo", () => {
    const dir = makeRoot({ ".env.local": "x\n" });
    const enoent = () => {
      throw Object.assign(new Error("no such file"), { code: "ENOENT" });
    };
    assert.deepEqual(findBlockingNextEnvFiles(dir, { statSync: enoent }), []);
    const eacces = () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    };
    assert.throws(() => findBlockingNextEnvFiles(dir, { statSync: eacces }), /unable to inspect/i);
    try {
      findBlockingNextEnvFiles(dir, { statSync: eacces });
      assert.fail("deveria falhar");
    } catch (e) {
      const msg = String((e && e.message) || e);
      assert.ok(!msg.includes(dir), "sem path absoluto");
      assert.ok(!msg.includes("permission denied"), "sem detalhe de IO");
      assert.ok(!msg.includes(".env"), "sem nomes de arquivo no erro de inspeção");
    }
    assert.throws(() => assertNoBlockingNextEnvFiles(dir, { statSync: eacces }), /unable to inspect/i);
  });

  it("assertNoFinancialWrites: 0 observado no journal (inicial e re-leitura)", () => {
    assert.equal(assertNoFinancialWrites({ requests: [], financialWrites: [] }), 0);
    assert.throws(() => assertNoFinancialWrites({ financialWrites: [{ method: "POST" }] }), /financial writes/i);
    assert.throws(() => assertNoFinancialWrites(null), /financial writes|journal/i);
  });

  it("resolveConfiguredLiveModel: gerador do bootstrap == live-model.json, sem SDK", async () => {
    const model = await resolveConfiguredLiveModel();
    assert.match(model, /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
    const raw = fs.readFileSync(
      path.join(HERE_SUPPORT, "..", "..", "..", "ted-runtime", "src", "live-model.json"),
      "utf8",
    );
    assert.equal(model, JSON.parse(raw).model);
  });

  it("isCliEntry: só o script invocado é CLI (import nunca dispara o runner)", () => {
    assert.equal(isCliEntry({ argv1: undefined, moduleUrl: "file:///x/p2d-live-prep.mjs" }), false);
    assert.equal(
      isCliEntry({ argv1: "D:/projetos/pi-ted-opencode-product/apps/pwa/e2e/support/p2d-live-prep.mjs", moduleUrl: "file:///other/mod.mjs" }),
      false,
    );
    assert.equal(isCliEntry({ argv1: PREP_FILE, moduleUrl: pathToFileURL(PREP_FILE).href }), true);
  });
});

describe("p2d-live-prep guarda estático: Playwright é o dono dos serviços (RED→GREEN)", () => {
  it("prep delega ao Playwright e não supervisiona processos", () => {
    const src = fs.readFileSync(PREP_FILE, "utf8");
    // Delegação ao ciclo de vida existente (único opt-in que inicia teste).
    assert.ok(src.includes("P2D_LIVE_PREP"), "prep deve selecionar a spec live-prep via P2D_LIVE_PREP");
    assert.ok(src.includes("@playwright/test"), "prep deve delegar ao Playwright existente");
    // Sem supervisão própria: nenhuma árvore, espera, probe ou spawn de
    // serviço no CÓDIGO (comentários explicativos são ignorados).
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[^\S\r\n]*\/\/[^\r\n]*/gm, "");
    for (const banned of [
      "terminateTree",
      "shutdownAll",
      "closeStackProbe",
      "trackExit",
      "taskkill",
      "spawn(",
      "child_process",
      "watchPlaywrightChild",
      "playwrightExitCode",
      "p2d-browser-stack",
      "p2d-live-prep-child",
      "buildPwaEnv",
      "buildSyntheticStackEnv",
    ]) {
      assert.ok(!code.includes(banned), `prep não deve conter ${banned} (Playwright é o dono)`);
    }
    // Delegação in-process: resolve o CLI CJS e o carrega no mesmo processo.
    // O launcher só seleciona o opt-in via flags; preflight e scrub são
    // autoridade da config (sem duplicação aqui).
    assert.ok(code.includes("@playwright/test/cli"), "prep deve carregar o CLI Playwright existente");
    assert.ok(code.includes("process.env.P2D_LIVE_PREP"), "prep deve selecionar o opt-in via flag");
    // O loader Playwright é helper privado: import nunca deve oferecer API
    // que inicie Playwright (só main(), via CLI, o chama após setar flags).
    assert.ok(code.includes("function loadPlaywrightCli()"), "loader existe como helper privado");
    assert.ok(!code.includes("export function loadPlaywrightCli"), "loader não pode ser exportado");
    assert.ok(!code.includes("export { loadPlaywrightCli"), "loader não pode ser re-exportado");
    for (const moved of ["assertNoBlockingNextEnvFiles", "buildPlaywrightEnv", "scrubProcessEnv"]) {
      assert.ok(!code.includes(moved), `prep não deve duplicar ${moved} (autoridade é a config)`);
    }
  });

  it("spec não cria processo: boot no próprio worker, sem spawn/child", () => {
    const src = fs.readFileSync(SPEC_FILE, "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[^\S\r\n]*\/\/[^\r\n]*/gm, "");
    for (const banned of ["spawn(", "child_process", "closeLivePrepChild", "provenNoopCleanup", "CHILD_ENTRY"]) {
      assert.ok(!code.includes(banned), `spec não deve conter ${banned} (boot in-worker)`);
    }
    assert.ok(code.includes("withLiveBootBoundary"), "spec deve isolar o env via withLiveBootBoundary");
    assert.ok(code.includes("startTedRuntime"), "spec deve bootar startTedRuntime no worker");
    assert.ok(code.includes("live_prep_no_listen"), "spec deve exigir o sentinel prep-only");
  });

  it("preflight Next e scrub vivem na config (autoridade), não no launcher", () => {
    const src = fs.readFileSync(CONFIG_FILE, "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[^\S\r\n]*\/\/[^\r\n]*/gm, "");
    // Chamadas no top-level da config: executam no import, antes da
    // construção dos webServers (que também é top-level, abaixo).
    for (const required of ["assertNoBlockingNextEnvFiles(", "buildPlaywrightEnv(process.env)"]) {
      assert.ok(code.includes(required), `config deve aplicar ${required.trim()} no caminho LIVE_PREP`);
    }
    const preflightAt = code.indexOf("assertNoBlockingNextEnvFiles(");
    const scrubAt = code.indexOf("buildPlaywrightEnv(process.env)");
    const webServersAt = code.indexOf("webServer:");
    assert.ok(preflightAt !== -1 && scrubAt !== -1 && webServersAt !== -1, "config deve ter preflight+scrub+webServers");
    assert.ok(Math.max(preflightAt, scrubAt) < webServersAt, "preflight+scrub ocorrem ANTES dos webServers");
    // Seleção forçada: só a spec live-prep roda no opt-in, em qualquer entrypoint.
    assert.match(code, /testMatch: LIVE_PREP \? "\*\*\/p2d\/p2d-live-prep\.spec\.ts" : "\*\*\/p2d\/\*\.spec\.ts"/);
    // Projetos: só p2d-synthetic no opt-in (direct CLI não seleciona os demais).
    assert.match(code, /\.\.\.\(!LIVE_PREP\s*\?\s*\[/);
  });
});

describe("p2d-live-prep import inerte + CLI explícito", () => {
  it("parsePrepArgs em processo isolado: --help é inerte, vazio delega, resto falha fechado", () => {
    // O launcher nunca é importado no processo node:test; o parsing é
    // exercitado num subprocesso com argv inválido (rejeitado antes de
    // preflight/spawn/Playwright) + spawn interceptado antes do import. Se
    // o guard regredir para main incondicional, o main falha fechado aqui
    // (exit 1 + stderr), sem nunca iniciar serviços.
    const probe = [
      `import { syncBuiltinESMExports } from 'node:module';`,
      `import child_process from 'node:child_process';`,
      `child_process.spawn = (...args) => { throw new Error('spawn-blocked'); };`,
      `syncBuiltinESMExports();`,
      `process.argv = [process.execPath, 'probe-parse-args', '--invalid-flag-xyz'];`,
      `const m = await import(${JSON.stringify(pathToFileURL(PREP_FILE).href)});`,
      `console.log(JSON.stringify([m.parsePrepArgs([]), m.parsePrepArgs(['--help']), m.parsePrepArgs(['--nope']), typeof m.loadPlaywrightCli]));`,
    ].join("\n");
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(res.status, 0);
    assert.equal(String(res.stderr), "");
    const lines = String(res.stdout).trim().split("\n");
    assert.equal(lines.length, 1);
    const [run, help, bad, loaderExport] = JSON.parse(lines[0]);
    assert.deepEqual(run, { mode: "run" });
    assert.deepEqual(help, { mode: "help" });
    assert.equal(bad.mode, "error");
    assert.match(String(bad.message), /unknown args/i);
    assert.equal(loaderExport, "undefined", "import não deve expor loader Playwright");
  });

  it("import inerte: importar o launcher não inicia serviço nem cria child", () => {
    // Seguro contra regressão de guard: argv inválido (rejeitado pelo
    // parser antes de preflight/spawn/credencial) + spawn interceptado
    // antes do import. Módulo inerte => exit 0, sentinela exata, stderr
    // vazio; main executado => exit 1 com mensagem em stderr (falha aqui).
    const probe = [
      `import { syncBuiltinESMExports } from 'node:module';`,
      `import child_process from 'node:child_process';`,
      `child_process.spawn = (...args) => { throw new Error('spawn-blocked'); };`,
      `syncBuiltinESMExports();`,
      `process.argv = [process.execPath, 'probe-inert-import', '--invalid-flag-xyz'];`,
      `await import(${JSON.stringify(pathToFileURL(PREP_FILE).href)});`,
      `console.log('IMPORT-INERT-OK');`,
    ].join("\n");
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(res.status, 0);
    assert.equal(String(res.stdout).trim(), "IMPORT-INERT-OK");
    assert.equal(String(res.stderr), "");
  });

  it("CLI --help é inerte: usage, exit 0, sem markers de serviço", () => {
    const res = spawnSync(process.execPath, [PREP_FILE, "--help"], {
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(res.status, 0);
    assert.match(String(res.stdout), /Usage:/);
    assert.match(String(res.stdout), /P2D_LIVE_PREP/);
    assert.ok(!String(res.stdout).includes("stage="), "help não deve imprimir markers de estágio");
    assert.equal(String(res.stderr), "");
  });
});

describe("p2d-live-prep env isolado: withScrubbedEnv aplica e restaura", () => {
  it("aplica o env exato e restaura o original (sucesso)", async () => {
    const target = { KEEP: "1", DROP: "x", PATH: "/bin" };
    const applied = { PATH: "/bin", ONLY_NEW: "n" };
    const seen = await withScrubbedEnv(
      applied,
      async (t) => {
        assert.deepEqual({ ...t }, applied);
        return "ok-value";
      },
      target,
    );
    assert.equal(seen, "ok-value");
    assert.deepEqual(target, { KEEP: "1", DROP: "x", PATH: "/bin" });
  });

  it("restaura mesmo com erro e propaga o original (falha)", async () => {
    const target = { KEEP: "1", LEAK: "orig" };
    const boom = new Error("boom-callback");
    try {
      await withScrubbedEnv({ LEAK: "mapped", FRESH: "f" }, async () => {
        throw boom;
      }, target);
      assert.fail("deveria falhar");
    } catch (e) {
      assert.equal(e, boom);
    }
    assert.deepEqual(target, { KEEP: "1", LEAK: "orig" });
  });

  it("rejeita args inválidos sem tocar o target", async () => {
    const target = { A: "1" };
    await assert.rejects(withScrubbedEnv(null, async () => {}, target), /envVars/i);
    await assert.rejects(withScrubbedEnv({ A: "2" }, null, target), /fn/i);
    assert.deepEqual(target, { A: "1" });
  });

  it("falha no meio da aplicação do env: restaura o snapshot e propaga o erro", async () => {
    const evil = {};
    Object.defineProperty(evil, "BOOM", {
      get() {
        throw new Error("boom-apply");
      },
      enumerable: true,
    });
    const target = { KEEP: "1", DROP: "x" };
    await assert.rejects(withScrubbedEnv(evil, async () => {}, target), /boom-apply/);
    assert.deepEqual(target, { KEEP: "1", DROP: "x" });
  });

  it("erro na restauração não expõe credential e não mascara com valor", async () => {
    const secret = `k-${DUMMY}-k`;
    const backing = { KEEP: "1", LEAK: secret };
    let deletes = 0;
    const target = new Proxy(backing, {
      deleteProperty(t, p) {
        deletes += 1;
        // Primeiras remoções (swap) passam; a restauração no finally falha.
        if (deletes > 2) throw new Error("restore-boom");
        return Reflect.deleteProperty(t, p);
      },
    });
    let caught = null;
    try {
      await withScrubbedEnv({ FRESH: "1" }, async () => "ok", target);
      assert.fail("deveria falhar");
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Error);
    assert.equal(caught.message, "restore-boom");
    assert.ok(!String(caught.message).includes(DUMMY), "sem segredo na mensagem");
    assert.ok(!String(caught.stack).includes(DUMMY), "sem segredo no stack");
    assert.equal(caught.cause, undefined);
  });
});

describe("p2d-live-prep modelo isolado: live-model.json + home isolada", () => {
  it("loadLiveModelSelector: lê e valida o template do repo", () => {
    const model = loadLiveModelSelector();
    assert.match(model, /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
  });

  it("loadLiveModelSelector: falha fechado em ausente/ilegível", () => {
    const missing = path.join(os.tmpdir(), "p2d-live-no-such-model-xyz.json");
    assert.throws(() => loadLiveModelSelector({ liveModelFile: missing }), /unreadable|fail-closed/i);
    const bad = makeRoot({ "live-model.json": "not json {" });
    assert.throws(() => loadLiveModelSelector({ liveModelFile: path.join(bad, "live-model.json") }), /valid JSON|fail-closed/i);
    const wrong = makeRoot({ "live-model.json": JSON.stringify({ model: "sem-barra" }) });
    assert.throws(() => loadLiveModelSelector({ liveModelFile: path.join(wrong, "live-model.json") }), /provider\/model|fail-closed/i);
  });

  it("assertIsolatedHome: aceita tmp isolado, recusa home compartilhada", () => {
    const iso = fs.mkdtempSync(path.join(os.tmpdir(), "p2d-iso-home-"));
    assert.equal(assertIsolatedHome(iso), path.resolve(iso));
    assert.throws(() => assertIsolatedHome(os.homedir()), /shared user home|fail-closed/i);
    assert.throws(() => assertIsolatedHome("relativo/xyz"), /absolute|fail-closed/i);
    assert.throws(() => assertIsolatedHome(path.join(os.homedir(), ".opencode")), /config|fail-closed|shared/i);
  });
});

describe("playwright config opt-in: P2D_LIVE_PREP usa só webServers P2D", () => {
  const TSX_CLI = path.join(HERE_SUPPORT, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");

  function configSnapshot(extraEnv) {
    // Importa a config TS via tsx local (só leitura do objeto, sem iniciar
    // webServers); o import TS puro falha em `../support/ports` sem extensão.
    // Com LIVE_PREP=1, o próprio import executa preflight + scrub do env —
    // sem isso, entrada direta rodaria servidores com env cru.
    const probe = [
      `(async () => {`,
      `  const m = await import(${JSON.stringify(pathToFileURL(CONFIG_FILE).href)});`,
      `  const cfg = m.default?.default ?? m.default;`,
      `  const ws = cfg.webServer ?? [];`,
      `  const projs = cfg.projects ?? [];`,
      `  const proj = projs.find((p) => p.name === "p2d-synthetic");`,
      `  console.log(JSON.stringify({`,
      `    commands: ws.map((w) => w.command),`,
      `    projects: projs.map((p) => p.name),`,
      `    testMatch: proj ? proj.testMatch : null,`,
      `    env: { livePrep: process.env.P2D_LIVE_PREP ?? null, browser: process.env.P2D_BROWSER ?? null,`,
      `      secret: process.env.P2D_PROBE_SECRET ?? null, nodeOpts: process.env.NODE_OPTIONS ?? null },`,
      `  }));`,
      `})().catch((e) => { console.error(String((e && e.message) || e)); process.exitCode = 1; });`,
    ].join("\n");
    const env = { ...process.env, ...extraEnv };
    if (!("P2D_LIVE_PREP" in extraEnv)) delete env.P2D_LIVE_PREP;
    const res = spawnSync(process.execPath, [TSX_CLI, "-e", probe], {
      encoding: "utf8",
      timeout: 60000,
      env,
    });
    assert.equal(res.status, 0, String(res.stderr).slice(0, 500));
    return JSON.parse(String(res.stdout).trim());
  }

  it("P2D_BROWSER=1 sem opt-in: topologia completa preservada (3 históricos + 2 P2D), env cru intocado", () => {
    const snap = configSnapshot({ P2D_BROWSER: "1", P2D_PROBE_SECRET: "test-dummy-probe-secret" });
    assert.equal(snap.commands.length, 5);
    assert.match(snap.commands[0], /fixture-api/);
    assert.match(snap.commands[3], /p2d-browser-stack/);
    assert.match(snap.commands[4], /next dev/);
    assert.equal(snap.testMatch, "**/p2d/*.spec.ts");
    assert.deepEqual(snap.projects, ["functional-mobile", "functional-desktop", "pwa-runtime", "push-runtime", "production-smoke", "p2d-synthetic"]);
    // Sem opt-in: sem preflight/scrub — default intacto, segredo passa.
    assert.equal(snap.env.secret, "test-dummy-probe-secret");
  });

  it("P2D_LIVE_PREP=1: só stack + Next dev P2D, projeto e spec únicos, env higienizado", () => {
    const snap = configSnapshot({ P2D_BROWSER: "1", P2D_LIVE_PREP: "1", P2D_PROBE_SECRET: "test-dummy-probe-secret", NODE_OPTIONS: "--inspect" });
    assert.equal(snap.commands.length, 2);
    assert.match(snap.commands[0], /p2d-browser-stack/);
    assert.match(snap.commands[1], /next dev/);
    for (const c of snap.commands) {
      assert.ok(!c.includes("fixture-api"), "sem fixture no opt-in live-prep");
      assert.ok(!c.includes("sw-harness"), "sem harness no opt-in live-prep");
      assert.ok(!c.includes("standalone-server"), "sem standalone no opt-in live-prep");
    }
    // Projeto único: direct CLI não seleciona functional/pwa-runtime/push.
    assert.deepEqual(snap.projects, ["p2d-synthetic"]);
    // Seleção forçada: só a spec live-prep, em qualquer entrypoint.
    assert.equal(snap.testMatch, "**/p2d/p2d-live-prep.spec.ts");
    // Scrub antes dos webServers: segredo e NODE_OPTIONS sumiram, só flags P2D ficam.
    assert.equal(snap.env.secret, null);
    assert.equal(snap.env.nodeOpts, null);
    assert.equal(snap.env.livePrep, "1");
    assert.equal(snap.env.browser, "1");
  });

  it("P2D_LIVE_PREP=1 com portas malformadas contendo segredo: defaults, sem echo", () => {
    const secret = `x-${"test-dummy-not-a-secret"}-y`;
    const snap = configSnapshot({
      P2D_BROWSER: "1",
      P2D_LIVE_PREP: "1",
      P2D_PROBE_SECRET: secret,
      P2D_API_PORT: `nope-${secret}`,
      E2E_FIXTURE_PORT: `nope-${secret}`,
    });
    // Scrub primeiro: portas malformadas descartadas, defaults aplicados.
    assert.equal(snap.commands.length, 2);
    assert.match(snap.commands[0], /p2d-browser-stack/);
    assert.ok(!JSON.stringify(snap.commands).includes(secret), "sem echo do valor malformado");
    assert.deepEqual(snap.projects, ["p2d-synthetic"]);
    assert.equal(snap.testMatch, "**/p2d/p2d-live-prep.spec.ts");
    assert.equal(snap.env.secret, null);
  });
});

describe("p2d-live-prep regressão de guarda: argv inválido falha antes de serviços", () => {
  it("sem guard, main incondicional ainda falha fechado antes do spawn", () => {
    const probe = [
      `import { syncBuiltinESMExports } from 'node:module';`,
      `import child_process from 'node:child_process';`,
      `let spawns = 0;`,
      `child_process.spawn = (...args) => { spawns += 1; throw new Error('spawn-blocked'); };`,
      `syncBuiltinESMExports();`,
      `process.argv = [process.execPath, 'probe-guard-regression', '--invalid-flag-xyz'];`,
      `await import(${JSON.stringify(pathToFileURL(PREP_FILE).href)});`,
      `console.log(JSON.stringify({ spawns }));`,
    ].join("\n");
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      encoding: "utf8",
      timeout: 30000,
    });
    // Parser rejeita argv inválido antes de preflight/spawn/credencial:
    // com guard intacto o import é inerte; sem guard, main falha fechado.
    // Em ambos os casos nenhum spawn ocorre e nada de serviço é impresso.
    const stdout = String(res.stdout);
    const stderr = String(res.stderr);
    assert.ok(!stdout.includes("stage="), "nenhuma saída de inicialização");
    assert.ok(!stderr.includes("stage="), "nenhum erro de inicialização");
    const lastLine = stdout.trim().split("\n").pop();
    assert.deepEqual(JSON.parse(lastLine), { spawns: 0 });
  });
});
