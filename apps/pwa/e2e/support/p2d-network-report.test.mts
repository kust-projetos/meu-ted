import assert from "node:assert/strict";
import { test } from "node:test";
import { createNetworkReport } from "./p2d-network-report.mts";

type FakeResponse = {
  url(): string;
  status(): number;
  request(): {
    method(): string;
    timing(): { responseEnd: number };
  };
  json(): Promise<unknown>;
};
type Listener = (response: FakeResponse) => void;
type FakePage = {
  on(event: "response", listener: Listener): void;
  off(event: "response", listener: Listener): void;
};

class MockPage implements FakePage {
  listeners = new Map<"response", Listener>();
  on(event: "response", listener: Listener) { this.listeners.set(event, listener); }
  off(event: "response", listener: Listener) {
    if (this.listeners.get(event) === listener) this.listeners.delete(event);
  }
  async emit(response: FakeResponse) { this.listeners.get("response")?.(response); }
}

function response(path: string, status: number, body: unknown) {
  return {
    url: () => `https://example.test${path}?secret=not-recorded`,
    status: () => status,
    request: () => ({ method: () => "POST", timing: () => ({ responseEnd: 12 }) }),
    json: async () => body,
  };
}

test("captures a successful response without a code", async () => {
  const page = new MockPage();
  const report = createNetworkReport(page);
  await page.emit(response("/rpc/pending-operations/active", 200, { id: "op", items: [] }));
  const result = await report.report();
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.status, 200);
  assert.equal(result.events[0]?.code, undefined);
  assert.equal(result.events[0]?.stage, "active");
  report.stop();
});

test("captures the gateway error code from an unsuccessful response", async () => {
  const page = new MockPage();
  const report = createNetworkReport(page);
  await page.emit(response("/rpc/pending-operations/propose", 502, { code: "pending.upstream_403_propose" }));
  const result = await report.report();
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.status, 502);
  assert.equal(result.events[0]?.code, "pending.upstream_403_propose");
  assert.equal(result.events[0]?.stage, "propose");
  assert.equal(result.events[0]?.route, "/rpc/pending-operations/propose");
  report.stop();
});

test("ignores routes outside the allowlist", async () => {
  const page = new MockPage();
  const report = createNetworkReport(page);
  await page.emit(response("/api/backend/auth/sign-up/email", 200, { code: "irrelevant" }));
  assert.deepEqual((await report.report()).events, []);
  report.stop();
});
