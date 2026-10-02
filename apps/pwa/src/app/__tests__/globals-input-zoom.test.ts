import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A5 zoom follow-up (user report 2026-10-02): iOS Safari auto-zooms ANY
 * focused form control whose computed font-size is < 16px. Per-component
 * fixes (AuthGate, NewTransactionSheet/Input) left several surfaces below
 * the threshold (chat textarea, convite, workspace manager, payables,
 * records, filters...), so the contract moved to ONE global rule in
 * globals.css for coarse-pointer (touch) devices.
 *
 * Zoom stays unblocked (WCAG 1.4.4, viewport has no maximum-scale): we
 * raise the control font on touch devices instead of disabling zoom.
 */
const cssPath = resolve(__dirname, "../globals.css");
const css = readFileSync(cssPath, "utf8");

describe("globals.css — no iOS auto-zoom on form controls", () => {
  it("forces >= 16px font-size on input/textarea/select for coarse pointers", () => {
    const rule = /@media\s*\(pointer:\s*coarse\)\s*\{[^}]*\}/.exec(css);
    expect(rule).not.toBeNull();
    const body = rule?.[0] ?? "";
    for (const control of ["input", "textarea", "select"]) {
      expect(body).toContain(control);
    }
    expect(body).toMatch(/font-size:\s*16px\s*!important/);
  });
});
