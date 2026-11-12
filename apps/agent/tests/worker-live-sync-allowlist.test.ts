import { describe, expect, it } from "vitest";
import { isAllowedAgentRpcPath } from "../src/worker.js";

const allowedPaths = [
  "/rpc/chat",
  "/rpc/history",
  "/rpc/session/new",
  "/rpc/memory/prefs",
  "/rpc/pending-operations/active",
  "/rpc/pending-operations/propose",
  "/rpc/undo/active",
  "/rpc/undo/decision",
  "/rpc/attachments",
  "/rpc/attachments/observability",
  "/rpc/undo/00000000-0000-4000-8000-000000000001/verify-target",
  "/rpc/pending-operations/00000000-0000-4000-8000-000000000002/decision",
  "/rpc/workspace/00000000-0000-4000-8000-000000000003/attest-empty",
];

const deniedPaths = [
  "/ws",
  "/stream",
  "/sync",
  "/sse",
  "/events",
  "/get-messages",
  "/websocket",
  "/realtime",
  "/live-sync",
  "/rpc/ws",
  "/rpc/stream",
  "/rpc/sync",
  "/rpc/events",
  "/rpc/live",
  "/rpc/chat/stream",
  "/rpc/attachments/stream",
  "/rpc/unknown",
  "/rpc/undo//verify-target",
  "/rpc/undo/a/b/verify-target",
  "/rpc/chat/",
  "/rpc/undo/x/verify-target/extra",
];

describe("agent RPC path allowlist", () => {
  it("allows only the exact REST paths and parameterized forms", () => {
    for (const path of allowedPaths) {
      expect(isAllowedAgentRpcPath(path), path).toBe(true);
      expect(path.startsWith("/rpc/"), path).toBe(true);
    }
  });

  it("denies live and unknown transport paths", () => {
    for (const path of deniedPaths) {
      expect(isAllowedAgentRpcPath(path), path).toBe(false);
    }
  });
});
