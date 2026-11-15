import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { institutionSvg } from "@/components/brand/institution-svgs";
import { INSTITUTIONS } from "./catalog";

const publicDir = resolve(process.cwd(), "public/brands");
const manifest = JSON.parse(
  readFileSync(resolve(publicDir, "MANIFEST.json"), "utf8"),
) as Array<{ slug: string; category: string; license: string; sourceUrl: string }>;

describe("institution catalog asset integrity", () => {
  it("resolves every catalog logo in code, public assets, and the manifest", () => {
    for (const institution of INSTITUTIONS) {
      if (!institution.logoSrc) continue;
      const slug = institution.logoSrc.split("/").at(-1)!.replace(/\.svg$/, "");
      expect(institutionSvg).toHaveProperty(institution.logoSrc);
      expect(existsSync(resolve(publicDir, "institutions", `${slug}.svg`))).toBe(true);
      expect(manifest.some((entry) => entry.slug === slug && entry.category === "institutions")).toBe(true);
    }
  });

  it("has an existing asset and complete license/source metadata for each institution manifest row", () => {
    for (const entry of manifest.filter((row) => row.category === "institutions")) {
      expect(existsSync(resolve(publicDir, "institutions", `${entry.slug}.svg`))).toBe(true);
      expect(entry.license).toBeTruthy();
      expect(entry.sourceUrl).toBeTruthy();
    }
  });

  it("has unique ids and complete required fields with valid categories", () => {
    const ids = INSTITUTIONS.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    const categories = new Set(["bank", "fintech", "cooperative", "wallet", "gateway", "acquirer", "broker", "global-account"]);
    for (const institution of INSTITUTIONS) {
      expect(institution.id).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
      expect(institution.name).toBeTruthy();
      expect(institution.shortName).toBeTruthy();
      expect(institution.aliases.length).toBeGreaterThan(0);
      expect(institution.country).toBeTruthy();
      expect(institution.colors.primary).toMatch(/^#[0-9a-f]{6}$/i);
      expect(categories.has(institution.category)).toBe(true);
    }
  });
});
