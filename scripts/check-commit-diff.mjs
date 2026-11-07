#!/usr/bin/env node
/**
 * Lightweight commit gate: validates the staged diff itself.
 *
 * This intentionally does NOT run documentation, governance, capability or
 * architecture gates. Those are area-specific (`pnpm check:area`) and run in
 * CI only when the affected area changes.
 *
 * Checks:
 * - no merge conflict markers in staged text files;
 * - changed JSON/JSONC/YAML files parse;
 * - no secret-looking filenames (.env, *.pem, *.key, id_rsa, ...);
 * - no staged file larger than 2 MB.
 *
 * Usage: node scripts/check-commit-diff.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BYTES = 2 * 1024 * 1024;
const CONFLICT_MARKER = /^(?:<{7}|={7}|>{7})(?:\s|$)/m;
const STRUCTURED = /\.(json|jsonc|ya?ml)$/i;
const FORBIDDEN_NAMES = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(?!example$)[^/]+$/,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
];

export function isForbiddenName(file) {
  return FORBIDDEN_NAMES.some((pattern) => pattern.test(file));
}

export function parseStructured(file, content) {
  if (!STRUCTURED.test(file)) return null;

  if (/\.(json|jsonc)$/i.test(file)) {
    try {
      JSON.parse(content);
      return null;
    } catch {
      // JSONC: strip comments and trailing commas, then retry strict JSON.
    }
    try {
      const stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1")
        .replace(/,\s*([}\]])/g, "$1");
      JSON.parse(stripped);
      return null;
    } catch (error) {
      const detail = String(error?.message ?? error).split("\n")[0];
      return `${file}: invalid JSON (${detail})`;
    }
  }

  try {
    parseYaml(content);
    return null;
  } catch (error) {
    const detail = String(error?.message ?? error).split("\n")[0];
    return `${file}: invalid YAML (${detail})`;
  }
}

export function validateFiles(files, io) {
  const errors = [];
  for (const file of files) {
    if (isForbiddenName(file)) {
      errors.push(`${file}: secret-looking filename must not be committed`);
      continue;
    }

    const size = io.statSize(file);
    if (size > MAX_BYTES) {
      errors.push(`${file}: ${(size / 1024 / 1024).toFixed(1)} MB exceeds the 2 MB commit limit`);
      continue;
    }

    const content = io.readText(file);
    if (!content.includes("\0") && CONFLICT_MARKER.test(content)) {
      errors.push(`${file}: merge conflict marker found`);
    }

    const structuredError = parseStructured(file, content);
    if (structuredError) errors.push(structuredError);
  }
  return errors;
}

function stagedFiles(cwd) {
  const output = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
    { cwd, encoding: "utf8" },
  );
  return output.split(/\r?\n/).filter(Boolean);
}

function main() {
  const files = stagedFiles(ROOT);
  if (files.length === 0) {
    console.log("commit:check — no staged files");
    return;
  }

  const errors = validateFiles(files, {
    readText: (file) => fs.readFileSync(path.join(ROOT, file), "utf8"),
    statSize: (file) => fs.statSync(path.join(ROOT, file)).size,
  });

  if (errors.length > 0) {
    console.error(`commit:check — ${errors.length} problem(s) in the staged diff:`);
    for (const error of errors) console.error(` - ${error}`);
    process.exit(1);
  }

  console.log(`commit:check — ${files.length} staged file(s) OK`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
