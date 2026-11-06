/**
 * Classifies live-real E2E requests using the reason codes produced by the
 * original guard in `p2d-fetch-guard.mjs` (the single source of truth).
 *
 * There is deliberately NO second classifier here: every category is derived
 * from the guard's `{ action, reason }` result. When only a reason code is
 * available, `classifyGuardReason` maps it. When neither reason nor a guard
 * result can be obtained, the blockage is "unidentified" — never assumed
 * auxiliary.
 */
import { classifyLiveRealRequest as classifyGuardRequest } from "./p2d-fetch-guard.mjs";

export type LiveRealRequestCategory = "functional" | "auxiliary" | "unidentified";

export interface LiveRealRequest {
  url?: string;
  method?: string;
  status?: number;
  blocked?: boolean;
  /** Reason code produced by p2d-fetch-guard.mjs. Takes precedence. */
  reason?: string;
  /** Exact synthetic API origin (http://127.0.0.1:<port>) for the guard. */
  apiOrigin?: string;
}

/**
 * Map a guard reason code to a category.
 * - "destination" (host not on the allowlist: analytics/telemetry/CSP) → auxiliary.
 * - any other deny reason (transport/config/infra) → functional.
 * - missing/empty/unknown → unidentified (never assumed auxiliary).
 */
export function classifyGuardReason(reason: string | null | undefined): LiveRealRequestCategory {
  if (typeof reason !== "string" || reason.trim() === "") return "unidentified";
  if (reason === "destination") return "auxiliary";
  return "functional";
}

/**
 * Classify a request using the guard's reason codes (single classifier).
 * Precedence: explicit `reason` → guard classify from url → unidentified.
 */
export function classifyLiveRealRequest(req: LiveRealRequest): LiveRealRequestCategory {
  if (req.reason) return classifyGuardReason(req.reason);

  if (req.url) {
    try {
      const result = classifyGuardRequest(
        req.url,
        req.method ? { method: req.method } : undefined,
        req.apiOrigin ? { apiOrigin: req.apiOrigin } : undefined,
      );
      if (result) {
        if (result.action === "deny") return classifyGuardReason(result.reason);
        // allowed catalog/inference/api request → functional surface
        return "functional";
      }
    } catch {
      // fall through to unidentified
    }
  }
  return "unidentified";
}

export function isFunctionalBlockage(req: LiveRealRequest): boolean {
  return req.blocked === true && classifyLiveRealRequest(req) === "functional";
}

export interface LiveRealEgressResult {
  functionalBlocked: number;
  auxiliaryBlocked: number;
  unidentifiedBlocked: number;
  passed: boolean;
}

export function validateLiveRealEgress(
  requests: LiveRealRequest[],
): LiveRealEgressResult {
  let functionalBlocked = 0;
  let auxiliaryBlocked = 0;
  let unidentifiedBlocked = 0;
  for (const req of requests) {
    if (req.blocked !== true) continue;
    const category = classifyLiveRealRequest(req);
    if (category === "functional") functionalBlocked += 1;
    else if (category === "auxiliary") auxiliaryBlocked += 1;
    else unidentifiedBlocked += 1;
  }
  return {
    functionalBlocked,
    auxiliaryBlocked,
    unidentifiedBlocked,
    passed: functionalBlocked === 0 && unidentifiedBlocked === 0,
  };
}
