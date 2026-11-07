import assert from "node:assert/strict";
import test from "node:test";

import { isForbiddenName, parseStructured, validateFiles } from "./check-commit-diff.mjs";

const ioFor = (files) => ({
  readText: (file) => files[file] ?? "",
  statSize: (file) => Buffer.byteLength(files[file] ?? "", "utf8"),
});

test("accepts a clean diff", () => {
  const files = {
    "apps/api/src/example.ts": "export const value = 1;\n",
    "package.json": '{"name":"ok"}\n',
    "README.md": "# Ok\n",
  };
  assert.deepEqual(validateFiles(Object.keys(files), ioFor(files)), []);
});

test("rejects merge conflict markers", () => {
  const files = { "src/a.ts": "<<<<<<< HEAD\nconst a = 1;\n" };
  assert.match(validateFiles(["src/a.ts"], ioFor(files))[0], /conflict marker/);
});

test("rejects invalid structured files and accepts YAML/JSONC", () => {
  const files = {
    "broken.json": '{"a": }',
    "config.yaml": "a: 1\n",
    "notes.jsonc": '{\n  // comment\n  "a": 1,\n}\n',
  };
  assert.match(parseStructured("broken.json", files["broken.json"]), /invalid JSON/);
  assert.equal(parseStructured("config.yaml", files["config.yaml"]), null);
  assert.equal(parseStructured("notes.jsonc", files["notes.jsonc"]), null);
});

test("rejects secret-looking filenames but allows .env.example", () => {
  assert.equal(isForbiddenName(".env"), true);
  assert.equal(isForbiddenName("apps/api/.env.local"), true);
  assert.equal(isForbiddenName("certs/server.pem"), true);
  assert.equal(isForbiddenName("id_rsa"), true);
  assert.equal(isForbiddenName(".env.example"), false);
  assert.equal(isForbiddenName("docs/env.md"), false);
});

test("rejects files larger than 2 MB", () => {
  const big = "x".repeat(2 * 1024 * 1024 + 1);
  const errors = validateFiles(["asset.bin"], { readText: () => big, statSize: () => big.length });
  assert.match(errors[0], /exceeds the 2 MB commit limit/);
});
