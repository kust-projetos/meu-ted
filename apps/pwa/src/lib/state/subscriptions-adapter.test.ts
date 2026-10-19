// Subscriptions adapter tests — characterizes lazy-load refresh semantics.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSubscriptionsAdapter } from "./subscriptions-adapter";
import * as endpoints from "@/lib/api/endpoints";
import type { Subscription } from "./types";
import * as snapshotStore from "./snapshot-store";
import { setOfflineSubjectId } from "@/lib/auth/offline-subject";
import { setActiveWorkspaceId, clearActiveWorkspaceId } from "@/lib/api/client";

const TOKEN = "test-token";
const SUBJECT_A = "11111111-2222-4333-8444-555555555555";
const SUBJECT_B = "66666666-7777-4888-8999-000000000000";
const SUBS: Subscription[] = [
  { id: "s1", name: "Netflix", amountCents: 5590, cycle: "monthly", day: 15, paymentMethod: "credit_card", status: "active" },
];

describe("subscriptions adapter — refresh", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    clearActiveWorkspaceId();
  });

  it("fetch success: returns data with source 'live'", async () => {
    vi.spyOn(endpoints, "fetchSubscriptions").mockResolvedValue(SUBS as never);
    vi.spyOn(snapshotStore, "saveSnapshotDomain").mockResolvedValue(undefined);
    const adapter = createSubscriptionsAdapter({ token: TOKEN, online: true });
    const result = await adapter.refresh();
    expect(result).not.toBeNull();
    expect(result!.data).toEqual(SUBS);
    expect(result!.source).toBe("live");
    expect(result!.syncedAt).toBeTruthy();
  });

  it("persists to snapshot on fetch success", async () => {
    const spy = vi.spyOn(snapshotStore, "saveSnapshotDomain").mockResolvedValue(undefined);
    vi.spyOn(endpoints, "fetchSubscriptions").mockResolvedValue(SUBS as never);
    const adapter = createSubscriptionsAdapter({ token: TOKEN, online: true });
    await adapter.refresh();
    expect(spy).toHaveBeenCalledWith(TOKEN, "subscriptions", SUBS, { expectedSubject: null });
  });

  it("returns null when offline", async () => {
    const spy = vi.spyOn(endpoints, "fetchSubscriptions");
    const adapter = createSubscriptionsAdapter({ token: TOKEN, online: false });
    expect(await adapter.refresh()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("fetch failure + snapshot: returns snapshot with source 'snapshot'", async () => {
    vi.spyOn(endpoints, "fetchSubscriptions").mockRejectedValue(new Error("down"));
    vi.spyOn(snapshotStore, "loadSnapshotDomain").mockResolvedValue({
      data: SUBS as never, syncedAt: "2026-07-13T00:00:00.000Z",
    });
    const adapter = createSubscriptionsAdapter({ token: TOKEN, online: true });
    const result = await adapter.refresh();
    expect(result!.data).toEqual(SUBS);
    expect(result!.source).toBe("snapshot");
  });

  it("fetch failure + no snapshot: returns empty with source 'unavailable'", async () => {
    vi.spyOn(endpoints, "fetchSubscriptions").mockRejectedValue(new Error("down"));
    vi.spyOn(snapshotStore, "loadSnapshotDomain").mockResolvedValue(null);
    const adapter = createSubscriptionsAdapter({ token: TOKEN, online: true });
    const result = await adapter.refresh();
    expect(result!.data).toEqual([]);
    expect(result!.source).toBe("unavailable");
  });

  it("swallows saveSnapshotDomain failure on fetch success", async () => {
    vi.spyOn(endpoints, "fetchSubscriptions").mockResolvedValue(SUBS as never);
    vi.spyOn(snapshotStore, "saveSnapshotDomain").mockRejectedValue(new Error("idb down"));
    const adapter = createSubscriptionsAdapter({ token: TOKEN, online: true });
    const result = await adapter.refresh();
    expect(result!.source).toBe("live");
    expect(result!.data).toEqual(SUBS);
  });

  it("FIX-214: passes the pre-fetch identity as expectedSubject to the writer", async () => {
    setActiveWorkspaceId(SUBJECT_A);
    const spy = vi.spyOn(snapshotStore, "saveSnapshotDomain").mockResolvedValue(undefined);
    vi.spyOn(endpoints, "fetchSubscriptions").mockResolvedValue(SUBS as never);
    const adapter = createSubscriptionsAdapter({ token: TOKEN, online: true });
    await adapter.refresh();
    expect(spy).toHaveBeenCalledWith(TOKEN, "subscriptions", SUBS, { expectedSubject: SUBJECT_A });
  });

  it("FIX-214: discards the snapshot write when subject/workspace switches mid-fetch (A→B)", async () => {
    setActiveWorkspaceId(SUBJECT_A);
    const spy = vi.spyOn(snapshotStore, "saveSnapshotDomain").mockResolvedValue(undefined);
    let resolveFetch!: (value: Subscription[]) => void;
    vi.spyOn(endpoints, "fetchSubscriptions").mockImplementation(
      () => new Promise<Subscription[]>((resolve) => { resolveFetch = resolve; }),
    );
    const adapter = createSubscriptionsAdapter({ token: TOKEN, online: true });
    const pending = adapter.refresh();
    // Workspace switch A→B lands while the fetch is in flight.
    setActiveWorkspaceId(SUBJECT_B);
    resolveFetch(SUBS);
    const result = await pending;
    // Live data still serves the UI; only the cross-owner persist is dropped.
    expect(result).not.toBeNull();
    expect(result!.data).toEqual(SUBS);
    expect(result!.source).toBe("live");
    expect(spy).not.toHaveBeenCalled();
  });

  it("FIX-214: discards the snapshot write when only the subject flips mid-fetch", async () => {
    setOfflineSubjectId(SUBJECT_A);
    const spy = vi.spyOn(snapshotStore, "saveSnapshotDomain").mockResolvedValue(undefined);
    let resolveFetch!: (value: Subscription[]) => void;
    vi.spyOn(endpoints, "fetchSubscriptions").mockImplementation(
      () => new Promise<Subscription[]>((resolve) => { resolveFetch = resolve; }),
    );
    const adapter = createSubscriptionsAdapter({ token: TOKEN, online: true });
    const pending = adapter.refresh();
    setOfflineSubjectId(SUBJECT_B);
    resolveFetch(SUBS);
    const result = await pending;
    expect(result!.source).toBe("live");
    expect(spy).not.toHaveBeenCalled();
  });
});
