import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CANONICAL_DOCS = [
  "docs/PRODUCT.md",
  "docs/ARCHITECTURE-CURRENT.md",
  "docs/ARCHITECTURE-TARGET.md",
  "docs/ROADMAP.md",
];

test("canonical documentation contract", async (t) => {
  for (const docRelPath of CANONICAL_DOCS) {
    await t.test(`validates canonical document: ${docRelPath}`, () => {
      const fullPath = path.join(ROOT, docRelPath);
      assert.ok(fs.existsSync(fullPath), `${docRelPath} must exist`);

      const content = fs.readFileSync(fullPath, "utf8");
      assert.ok(content.length > 200, `${docRelPath} must not be empty`);
      assert.match(content, /Last verified/i, `${docRelPath} must declare verification date`);
      assert.match(content, /runtime-facts\.json/i, `${docRelPath} must link to runtime facts`);
      assert.doesNotMatch(content, /\[INSERT\s+|TODO:|FIXME:|<placeholder>/i, `${docRelPath} must not contain placeholders`);
    });
  }
});

// ─── T4.4 (SPEC §15 I5): semantic documentation contract ───
// Guards the active architecture: apps/api is the single financial
// authority, FinanceChatAgent is the active agent runtime, the WhatsApp
// bridge and the Pi financial tools are removed, PostgreSQL is the
// production persistence. Legacy instruction corpora live only under
// docs/archive/legacy-pi/ with an ARCHIVED header.

const ARCH_CANONICAL_DOCS = [
  "README.md",
  "AGENTS.md",
  "docs/PRODUCT.md",
  "docs/ARCHITECTURE-CURRENT.md",
  "docs/ROADMAP.md",
];

// Phrases that present a removed runtime as if it were still active.
// (Agent Pi as owner of persistence/UI, whatsapp-bridge as the live
// transport, Pi RPC invocation as the current path, the legacy workspace
// route as a current route — route literal assembled below at runtime so
// this contract test itself carries no forbidden static reference,
// same pattern as xlt-06.)
const ACTIVE_LEGACY_PHRASES = [
  /Agent Pi.{0,80}(cérebro do sistema|dono da|autoridade)/i,
  /dono da interpretação, persistência/i,
  /whatsapp-bridge.{0,120}(só transporta|não interpreta|devolve a sua resposta)/i,
  /pi --mode rpc/i,
  new RegExp(["/agents", "workspace", ""].join("/")),
];

// Words that frame a mention of a removed runtime as historical.
const REMOVAL_CONTEXT = /remov|antigo|legad|legacy|arquiv|não são componentes ativos|do not use|deprecat/i;

function readRepoDoc(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

function findActiveAgentsMdFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git", ".next", "dist", "coverage", ".wrangler", ".open-next"].includes(entry.name)) {
        continue;
      }
      findActiveAgentsMdFiles(fullPath, out);
    } else if (entry.isFile() && entry.name === "AGENTS.md") {
      const rel = path.relative(ROOT, fullPath).replace(/\\/g, "/");
      if (!rel.startsWith("docs/archive/")) {
        out.push(rel);
      }
    }
  }
  return out;
}

test("I5(a): canonical docs affirm the API as the single financial authority", () => {
  const corpus = ARCH_CANONICAL_DOCS.map(readRepoDoc).join("\n");
  assert.match(
    corpus,
    /API[^.\n]{0,120}(única autoridade|única fonte|fonte de verdade)/i,
    "canonical docs must affirm the API as the single financial authority",
  );
});

test("I5(b-e): canonical docs never present removed runtimes as active", async (t) => {
  for (const docRelPath of ARCH_CANONICAL_DOCS) {
    await t.test(`no active-runtime contradiction in: ${docRelPath}`, () => {
      const content = readRepoDoc(docRelPath);
      for (const pattern of ACTIVE_LEGACY_PHRASES) {
        assert.doesNotMatch(content, pattern, `${docRelPath} presents a removed runtime as active (${pattern})`);
      }
      const mentionsLegacy = /whatsapp-bridge|financial-tools|\.pi\/extensions/i.test(content);
      if (mentionsLegacy) {
        assert.match(
          content,
          REMOVAL_CONTEXT,
          `${docRelPath} mentions a removed runtime without historical/removal context`,
        );
      }
    });
  }
});

test("I5(I1-I3): no active nested AGENTS.md contradicts the architecture", () => {
  assert.ok(
    !fs.existsSync(path.join(ROOT, ".pi", "AGENTS.md")),
    ".pi/AGENTS.md must be archived under docs/archive/legacy-pi/ — an active nested AGENTS.md contradicts the architecture",
  );
  const active = findActiveAgentsMdFiles(ROOT);
  assert.ok(active.length > 0, "expected at least the root AGENTS.md");
  for (const relPath of active) {
    const content = readRepoDoc(relPath);
    for (const pattern of ACTIVE_LEGACY_PHRASES) {
      assert.doesNotMatch(content, pattern, `${relPath} contradicts the architecture (${pattern})`);
    }
  }
});

test("I5(I4): package metadata and env example describe PostgreSQL as production", async (t) => {
  await t.test("apps/api package.json description", () => {
    const pkg = JSON.parse(readRepoDoc("apps/api/package.json"));
    assert.ok(typeof pkg.description === "string" && pkg.description.length > 0, "apps/api must keep a description");
    assert.doesNotMatch(
      pkg.description,
      /demo|persistence later|in-memory read models/i,
      "apps/api description keeps demo-backed wording",
    );
    assert.match(pkg.description, /PostgreSQL/i, "apps/api description must name PostgreSQL as the store");
  });

  await t.test("apps/api .env.example wording", () => {
    const envExample = readRepoDoc("apps/api/.env.example");
    assert.doesNotMatch(envExample, /in-memory store used if not set/i, ".env.example keeps the legacy in-memory wording");
    assert.match(envExample, /DATABASE_URL/, ".env.example must document DATABASE_URL");
    assert.match(envExample, /produção|production/i, ".env.example must state that Postgres is the production runtime");
  });

  await t.test("no app package.json keeps demo-backed wording", () => {
    const appsDir = path.join(ROOT, "apps");
    for (const app of fs.readdirSync(appsDir)) {
      const pkgPath = path.join(appsDir, app, "package.json");
      if (!fs.existsSync(pkgPath)) {
        continue;
      }
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (typeof pkg.description === "string") {
        assert.doesNotMatch(
          pkg.description,
          /demo-backed|persistence later/i,
          `apps/${app}/package.json description keeps demo-backed wording`,
        );
      }
    }
  });
});

// ─── FIX-FINAL-3 (runtime topology consistency) ───
// The A0 runtime is retired; runtime-facts and current architecture must
// describe ted-runtime as the sole conversational runtime.

function listArchiveMdFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listArchiveMdFiles(fullPath, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(path.relative(ROOT, fullPath).replace(/\\/g, "/"));
    }
  }
  return out;
}

test("FIX-FINAL-3(a): runtime-facts.json declares ted-runtime as the sole runtime", () => {
  const facts = JSON.parse(readRepoDoc("docs/architecture/runtime-facts.json"));
  assert.deepEqual(facts.activeWorkspaces, ["apps/api", "apps/pwa", "apps/ted-runtime"]);
  assert.equal(facts.apps?.tedRuntime?.name, "pi-finance-ted-runtime");
  assert.match(facts.architecture?.assistantEngine ?? "", /apps\/ted-runtime.*sole conversational runtime/i);
  assert.equal(Object.hasOwn(facts.apps ?? {}, "agent"), false, "retired runtime must not be listed as active");
});

test("FIX-FINAL-3(b): every archived legacy-pi doc carries the ARCHIVED header", () => {
  // settings.json is exempt: JSON admits no comment header, its archive
  // marker is the docs/archive/legacy-pi/README.md inventory entry.
  const mdFiles = listArchiveMdFiles(path.join(ROOT, "docs", "archive", "legacy-pi"));
  assert.ok(mdFiles.length > 0, "expected archived legacy-pi docs");
  for (const relPath of mdFiles) {
    assert.match(readRepoDoc(relPath), /ARCHIVED/, `${relPath} is missing the ARCHIVED header`);
  }
});

test("FIX-FINAL-3(c): ARCHITECTURE-CURRENT documents current runtime topology", () => {
  const content = readRepoDoc("docs/ARCHITECTURE-CURRENT.md");
  assert.match(content, /apps\/ted-runtime.*único runtime conversacional/i);
  assert.match(content, /apps\/agent.*descontinuado em 2026-11-17/i);
  assert.doesNotMatch(content, /removid[oa] na V4/i, "A0 retirement was not a V4 removal");
});
