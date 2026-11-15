const CATEGORY_COLORS = [
  "#0E8C5A", "#C8483B", "#B8791F", "#3E6FB0",
  "#2FA56F", "#820AD1", "#EC7000", "#0F6B45",
];

/**
 * Deterministic color from a category name (stable hash).
 * No dependency on DB-driven icon names.
 */
export function getCategoryColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return CATEGORY_COLORS[Math.abs(hash) % CATEGORY_COLORS.length];
}

/**
 * Elegant category badge: colored pill with optional icon or initial.
 * Supports deterministic color, custom color override, and icon rendering
 * for the modern selector experience.
 */
export function CategoryBadge({
  name,
  size = 18,
  icon,
  color,
  withBorder = false,
}: {
  name: string;
  size?: number;
  icon?: string | null;
  color?: string | null;
  withBorder?: boolean;
}) {
  const baseColor = color ?? getCategoryColor(name);
  const initial = (name.trim().slice(0, 1) || "•").toUpperCase();
  const fontSize = Math.max(Math.round(size * 0.5), 8);

  const hasKnownIcon = Boolean(icon && hasCategoryIcon(icon));

  return (
    <span
      data-testid="category-badge"
      className={`category-badge flex flex-none items-center justify-center rounded-full font-bold text-white shadow-sm ${withBorder ? "ring-2 ring-white" : ""}`}
      style={{
        width: size,
        height: size,
        fontSize,
        background: baseColor,
      }}
      aria-hidden="true"
      data-icon={icon ?? undefined}
    >
      {hasKnownIcon ? (
        <>
          <CategoryIcon name={icon!} size={Math.round(size * 0.55)} className="text-white" />
          <span className="sr-only">{initial}</span>
        </>
      ) : initial}
    </span>
  );
}
import { CategoryIcon, hasCategoryIcon } from "./category-icon";
