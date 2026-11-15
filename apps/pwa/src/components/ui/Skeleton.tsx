/**
 * Layout-aware loading skeleton.
 *
 * Usage:
 *   <Skeleton />                       // generic block
 *   <Skeleton variant="text" width="60%" />
 *   <Skeleton variant="circle" width={40} height={40} />
 *   <Skeleton variant="card" height={80} />
 *
 * Renders with role="status" + aria-label="Carregando" so screen readers
 * announce the loading state without depending on visible text.
 */

import type { CSSProperties } from "react";

type Variant = "block" | "text" | "circle" | "card";

interface SkeletonProps {
  variant?: Variant;
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: CSSProperties;
}

function toSize(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" ? `${value}px` : value;
}

export default function Skeleton({
  variant = "block",
  width,
  height,
  className = "",
  style,
}: SkeletonProps) {
  const computed: CSSProperties = {};

  if (variant === "text") {
    computed.height = toSize(height) ?? "12px";
    computed.borderRadius = "6px";
    if (width !== undefined) computed.width = toSize(width);
  } else if (variant === "circle") {
    computed.width = toSize(width) ?? "32px";
    computed.height = toSize(height) ?? computed.width;
    computed.borderRadius = "9999px";
  } else if (variant === "card") {
    computed.borderRadius = "12px";
    if (width !== undefined) computed.width = toSize(width);
    if (height !== undefined) computed.height = toSize(height);
    else computed.height = "80px";
  } else {
    computed.borderRadius = "8px";
    if (width !== undefined) computed.width = toSize(width);
    if (height !== undefined) computed.height = toSize(height);
  }

  return (
    <div
      role="status"
      aria-label="Carregando"
      data-testid="skeleton"
      className={`motion-safe:animate-pulse bg-fill-medium ${className}`}
      style={{ ...computed, ...style }}
    />
  );
}
