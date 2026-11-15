"use client";

import { useCallback, useEffect, useState } from "react";
import { getInstitution } from "./catalog";
import { isKnownCardProduct, getCardProduct, type CardProduct } from "./card-products";

export interface AccountAppearance {
  institutionId?: string;
  cardProductId?: string;
  manualInstitutionName?: string;
  customCardName?: string;
}

import type { Account } from "@/lib/state/types";
import { resolveInstitution } from "./catalog";

export function resolveAccountPresentation(
  account: Account,
  savedAppearance?: AccountAppearance,
) {
  const institutionId = account.institutionId ?? savedAppearance?.institutionId;
  const institution = (institutionId ? getInstitution(institutionId) : undefined)
    ?? resolveInstitution({ name: account.name, color: account.color });
  const productId = account.cardProductId ?? savedAppearance?.cardProductId;
  const product: CardProduct | undefined = productId ? getCardProduct(productId) : undefined;
  return { institution, product };
}

export type AppearanceMap = Record<string, AccountAppearance>;

const storageKey = (workspaceId: string) => `meu-ted:account-appearance:v1:${workspaceId}`;

function getStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function readAppearance(workspaceId: string): AppearanceMap {
  try {
    const raw = getStorage()?.getItem(storageKey(workspaceId));
    if (!raw) return {};

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const result: AppearanceMap = {};
    for (const [accountId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const appearance = value as AccountAppearance;
      const safe: AccountAppearance = {};

      if (typeof appearance.institutionId === "string" && getInstitution(appearance.institutionId)) {
        safe.institutionId = appearance.institutionId;
      }
      if (typeof appearance.cardProductId === "string" && isKnownCardProduct(appearance.cardProductId)) {
        safe.cardProductId = appearance.cardProductId;
      }
      if (typeof appearance.manualInstitutionName === "string") {
        safe.manualInstitutionName = appearance.manualInstitutionName.slice(0, 100);
      }
      if (typeof appearance.customCardName === "string") {
        safe.customCardName = appearance.customCardName.slice(0, 100);
      }

      if (Object.keys(safe).length > 0) result[accountId] = safe;
    }
    return result;
  } catch {
    return {};
  }
}

function writeMap(workspaceId: string, map: AppearanceMap): void {
  try {
    getStorage()?.setItem(storageKey(workspaceId), JSON.stringify(map));
  } catch {
    // Local storage is optional and may be unavailable.
  }
}

export function writeAccountAppearance(
  workspaceId: string,
  accountId: string,
  patch: AccountAppearance,
): void {
  const map = readAppearance(workspaceId);
  const next = { ...map[accountId], ...patch };

  for (const field of Object.keys(next) as (keyof AccountAppearance)[]) {
    if (next[field] === undefined || next[field] === "") delete next[field];
  }
  if (Object.keys(next).length === 0) delete map[accountId];
  else map[accountId] = next;
  writeMap(workspaceId, map);
}

export function removeAccountAppearance(workspaceId: string, accountId: string): void {
  const map = readAppearance(workspaceId);
  delete map[accountId];
  writeMap(workspaceId, map);
}

export function clearWorkspaceAppearance(workspaceId: string): void {
  try {
    getStorage()?.removeItem(storageKey(workspaceId));
  } catch {
    // Ignore unavailable storage.
  }
}

export function useAccountAppearance(workspaceId: string): {
  map: AppearanceMap;
  set: (accountId: string, patch: AccountAppearance) => void;
  remove: (accountId: string) => void;
} {
  const [state, setState] = useState(() => ({
    workspaceId,
    map: readAppearance(workspaceId),
  }));
  const map = state.workspaceId === workspaceId ? state.map : readAppearance(workspaceId);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === storageKey(workspaceId) || event.key === null) {
        setState({ workspaceId, map: readAppearance(workspaceId) });
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [workspaceId]);

  const set = useCallback((accountId: string, patch: AccountAppearance) => {
    writeAccountAppearance(workspaceId, accountId, patch);
    setState({ workspaceId, map: readAppearance(workspaceId) });
  }, [workspaceId]);
  const remove = useCallback((accountId: string) => {
    removeAccountAppearance(workspaceId, accountId);
    setState({ workspaceId, map: readAppearance(workspaceId) });
  }, [workspaceId]);

  return { map, set, remove };
}
