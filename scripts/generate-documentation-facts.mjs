#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function generateRuntimeFacts() {
  const pwaPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "pwa", "package.json"), "utf8"));
  const apiPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "api", "package.json"), "utf8"));
  const agentPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "agent", "package.json"), "utf8"));

  // FIX-FINAL-3 (V4, ADR-016): agent bindings are derived from the current
  // apps/agent/wrangler.jsonc instead of a hardcoded legacy list, so a
  // regenerated runtime-facts.json can never reintroduce the removed V1
  // agent binding as active. The historical v1 DO migration tag stays in
  // wrangler.jsonc per Cloudflare rules but is NOT a binding.
  const wrangler = JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "agent", "wrangler.jsonc"), "utf8"));
  const agentBindings = (wrangler.durable_objects?.bindings ?? []).map((b) => `${b.name} (${b.class_name})`);

  const sqlDir = path.join(ROOT, "apps", "api", "src", "read-models", "sql");
  const migrations = fs.existsSync(sqlDir)
    ? fs.readdirSync(sqlDir).filter((f) => f.startsWith("V") && f.endsWith(".sql")).sort()
    : [];

  const inventorySource = fs.readFileSync(path.join(ROOT, "apps", "api", "src", "routes", "route-inventory.ts"), "utf8");
  const routeMatches = [...inventorySource.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
  const uniqueRoutes = Array.from(new Set(routeMatches));

  return {
    version: "1.2.0",
    lastVerified: new Date().toISOString().slice(0, 10),
    activeWorkspaces: ["apps/api", "apps/pwa", "apps/agent"],
    apps: {
      api: {
        name: apiPkg.name || "@pi-financeiro/api",
        framework: "Fastify",
        runtime: "Node.js (Contabo VPS)",
      },
      pwa: {
        name: pwaPkg.name || "@pi-financeiro/pwa",
        framework: "Next.js / React (Static Export / OpenNext)",
        runtime: "Cloudflare Pages",
      },
      agent: {
        name: agentPkg.name || "@pi-financeiro/agent",
        framework: "Cloudflare Workers / Agents SDK (FinanceChatAgent extends AIChatAgent)",
        runtime: "Cloudflare Workers / Durable Objects (v2 FinanceChatAgent)",
        bindings: agentBindings,
        llmConfig: "V034 global, providers opencode-zen/go, openai-api, openai-codex-subscription experimental_blocked",
      },
    },
    counts: {
      apiRoutes: uniqueRoutes.length,
      databaseMigrations: migrations.length,
      latestMigration: migrations[migrations.length - 1] || "V030__bridge_phone_identity.sql",
      capabilitiesTotal: 72,
      capabilitiesInApiMode: 51,
    },
    architecture: {
      sourceOfTruth: "Fastify PostgreSQL API (apps/api)",
      primaryClient: "PWA (apps/pwa)",
      assistantEngine: "Cloudflare Agent Worker (apps/agent)",
      canonicalPwaPath: "apps/pwa",
      deprecatedOrigin: "../pi-finance-web",
    },
    production: {
      vpsProvider: "Contabo VPS",
      edgeProvider: "Cloudflare",
      database: "PostgreSQL 16+",
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const facts = generateRuntimeFacts();
  const outPath = path.join(ROOT, "docs", "architecture", "runtime-facts.json");
  fs.writeFileSync(outPath, JSON.stringify(facts, null, 2) + "\n", "utf8");
  console.log(`Generated runtime facts at ${outPath}`);
}
