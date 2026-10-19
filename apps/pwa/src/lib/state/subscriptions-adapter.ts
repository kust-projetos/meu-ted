// Subscriptions adapter — extracted lazy-load refresh logic.
// Subscription failure is nonessential: falls back to v2 snapshot or empty
// array, never crashes the app.

import type { Subscription } from "./types";
import * as endpoints from "@/lib/api/endpoints";
import { getActiveWorkspaceId } from "@/lib/api/client";
import { getOfflineSubjectId } from "@/lib/auth/offline-subject";
import { saveSnapshotDomain, loadSnapshotDomain } from "./snapshot-store";

export interface SubscriptionsAdapterOptions {
  /**
   * Snapshot key (token-derived). `undefined` on cookie-only boots: live
   * reads still run via the cookie session, but v2 snapshot
   * persist/fallback is skipped (identity-keyed offline V3 lands in
   * Phase 3). Never a secret at rest beyond the existing fingerprint.
   */
  token: string | undefined;
  online: boolean;
}

export interface RefreshResult {
  data: Subscription[];
  source: "live" | "snapshot" | "unavailable";
  syncedAt: string | null;
}

export interface SubscriptionsAdapter {
  /** Lazy-load subscriptions.
   * Returns null when offline (no fetch attempted).
   * On success: data from API, source "live".
   * On failure: fallback to snapshot (if available, source "snapshot") or
   * empty array (source "unavailable"). Never throws. */
  refresh(): Promise<RefreshResult | null>;
}

export function createSubscriptionsAdapter(options: SubscriptionsAdapterOptions): SubscriptionsAdapter {
  const { token, online } = options;

  async function refresh(): Promise<RefreshResult | null> {
    if (!online) return null;

    // FIX-214: capture the identity BEFORE the fetch. A subject/workspace
    // switch landing in the fetch gap must not persist A's payload under B.
    const entrySubject = getOfflineSubjectId();
    const entryWorkspace = getActiveWorkspaceId() ?? null;

    try {
      const data = await endpoints.fetchSubscriptions();
      // Best-effort: persist to v2 snapshot (failure must not break UI).
      // Skipped cookie-only (no owner-checkable key until V3).
      if (token !== undefined) {
        // Post-fetch revalidation: identity moved mid-fetch → drop the
        // persist (live data still serves the UI below). Otherwise forward
        // the pre-fetch subject so the writer revalidates it inside its own
        // serialized lock (defense in depth against a switch in the next gap).
        if (
          getOfflineSubjectId() !== entrySubject ||
          (getActiveWorkspaceId() ?? null) !== entryWorkspace
        ) {
          // Identity moved — no write.
        } else {
          await saveSnapshotDomain(token, "subscriptions", data, {
            expectedSubject: entrySubject,
          }).catch(() => {});
        }
      }
      return {
        data,
        source: "live",
        syncedAt: new Date().toISOString(),
      };
    } catch {
      // Nonessential failure: fallback to snapshot (only when keyed)
      const snap = token !== undefined ? await loadSnapshotDomain(token, "subscriptions") : null;
      if (snap) {
        return {
          data: snap.data as Subscription[],
          source: "snapshot",
          syncedAt: snap.syncedAt,
        };
      }
      return {
        data: [],
        source: "unavailable",
        syncedAt: null,
      };
    }
  }

  return { refresh };
}
