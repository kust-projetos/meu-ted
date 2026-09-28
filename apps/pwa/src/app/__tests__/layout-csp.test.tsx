import React, { type ReactElement } from "react";
import { describe, it, expect, vi } from "vitest";
import { buildCspValue } from "@/proxy-utils";

vi.mock("next/font/local", () => ({
  default: () => ({ variable: "--font-mock" }),
}));

// Controllable stand-in for the per-request headers the middleware sets
// (x-nonce). Read at component-call time, so each test sets its own value.
const nonceHolder: { value: string | null } = { value: null };

vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve({
      get: (name: string) => (name === "x-nonce" ? nonceHolder.value : null),
    }),
}));

type ThemeScriptProps = {
  children?: React.ReactNode;
  nonce?: string;
  dangerouslySetInnerHTML?: { __html: string };
};

function findThemeScript(tree: ReactElement): ReactElement<ThemeScriptProps> {
  const top = React.Children.toArray(
    (tree.props as ThemeScriptProps).children,
  ) as ReactElement<ThemeScriptProps>[];
  const head = top.find((el) => el.type === "head");
  expect(head).toBeDefined();
  const scripts = React.Children.toArray(
    (head!.props as ThemeScriptProps).children,
  ) as ReactElement<ThemeScriptProps>[];
  const script = scripts.find((el) => el.type === "script");
  expect(script).toBeDefined();
  return script!;
}

describe("RootLayout theme script × CSP (HIGH #3)", () => {
  // Importing the root layout is heavy (module cached across tests).
  it("stamps the theme bootstrap script with the middleware request nonce", async () => {
    nonceHolder.value = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
    const { default: RootLayout } = await import("@/app/layout");
    const script = findThemeScript(await RootLayout({ children: null }));

    expect(script.props.nonce).toBe(nonceHolder.value);
    expect(script.props.dangerouslySetInnerHTML?.__html).toContain("pi-theme");

    // Compatibility: the shipped policy authorizes exactly this nonce, and
    // the script-src directive grants no blanket unsafe-inline (unsafe-inline
    // lives only in style-src for Tailwind-generated styles).
    const csp = buildCspValue(nonceHolder.value!);
    expect(csp).toContain(`'nonce-${nonceHolder.value}'`);
    const scriptSrc = csp.split(";")[0]!;
    expect(scriptSrc).toContain("script-src");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  }, 60_000);

  it("omits the nonce attribute gracefully when the middleware provided none", async () => {
    nonceHolder.value = null;
    const { default: RootLayout } = await import("@/app/layout");
    const script = findThemeScript(await RootLayout({ children: null }));

    expect(script.props.nonce).toBeUndefined();
  }, 60_000);
});
