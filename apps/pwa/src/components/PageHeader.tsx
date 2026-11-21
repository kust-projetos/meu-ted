"use client";

import { useEffect, useState, type ReactNode } from "react";
import { AppFloatingMenu } from "./AppFloatingMenu";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  /** Compact bar title; defaults to title. */
  compactTitle?: string;
}

const SCROLL_THRESHOLD_PX = 20;

/**
 * Morphing header (item premium 1).
 *
 * Rest (scroll<=20): transparent row — WorkspaceSwitcher chip left,
 * action + avatar right — with the Large Title in flow.
 * Scrolled: fixed compact bar (56px + safe-area, z-30, saturated
 * dark-translucent, tonal 1px border, no diffuse shadows) with the compact
 * title cross-fading in (opacity + translateY 4px, 200ms easing).
 * Decorative motion honors prefers-reduced-motion via .transition-morph.
 */
export function PageHeader({ title, subtitle, action, compactTitle }: PageHeaderProps) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > SCROLL_THRESHOLD_PX);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <>
      {/* Compact bar: mounted past the threshold, cross-fades in */}
      {scrolled && (
        <div
          className="morph-bar transition-morph fixed inset-x-0 top-0 z-30 mx-auto w-full max-w-[var(--shell-max-w)] opacity-100"
        >
          <div
            className="relative flex items-center justify-center px-14"
            style={{ height: "calc(56px + env(safe-area-inset-top))", paddingTop: "env(safe-area-inset-top)" }}
          >
            <span className="transition-morph translate-y-0 truncate text-[15px] font-extrabold tracking-tight text-text-primary opacity-100">
              {compactTitle ?? title}
            </span>
            <div className="absolute right-4 flex items-center">
              <AppFloatingMenu compact />
            </div>
          </div>
        </div>
      )}

      {/* Rest state: transparent row + Large Title in flow */}
      <div className="relative z-30 px-5 pb-2 pt-[calc(var(--page-pt)+env(safe-area-inset-top))] sm:px-8 lg:px-12">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-none lg:hidden">
            <WorkspaceSwitcher compact align="left" />
          </div>
          <div className="hidden min-w-0 flex-none lg:block" aria-hidden="true" />
          <div className="flex flex-none items-center gap-1.5">
            {action}
            <AppFloatingMenu compact />
          </div>
        </div>
        <div
          className={`transition-morph min-w-0 flex-1 ${
            scrolled ? "translate-y-1 opacity-0" : "translate-y-0 opacity-100"
          }`}
        >
          <h1 className="mt-3 text-[26px] font-extrabold leading-tight tracking-tight text-text-primary">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-0.5 text-xs font-semibold text-text-muted">
              {subtitle}
            </p>
          )}
        </div>
      </div>
    </>
  );
}

export default PageHeader;
