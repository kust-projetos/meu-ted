import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAudit } from "./security-audit-gate.mjs";

const adv = (id, severity) => ({ github_advisory_id: id, severity, module_name: "m", patched_versions: ">=1" });

test("blocks a high advisory that is not allowlisted", () => {
  const r = evaluateAudit({ a: adv("GHSA-1", "high") }, [], "2026-11-15");
  assert.equal(r.ok, false);
  assert.equal(r.blocking.length, 1);
});
test("ignores low and moderate", () => {
  assert.equal(evaluateAudit({ a: adv("GHSA-1", "moderate"), b: adv("GHSA-2", "low") }, [], "2026-11-15").ok, true);
});
test("allowlisted advisory passes until its expiry date", () => {
  const list = [{ id: "GHSA-1", expiresOn: "2026-12-31" }];
  assert.equal(evaluateAudit({ a: adv("GHSA-1", "high") }, list, "2026-12-31").ok, true);
  const after = evaluateAudit({ a: adv("GHSA-1", "high") }, list, "2027-01-01");
  assert.equal(after.ok, false);
  assert.equal(after.expired.length, 1);
});
test("critical is blocking too", () => {
  assert.equal(evaluateAudit({ a: adv("GHSA-9", "critical") }, [], "2026-11-15").ok, false);
});
