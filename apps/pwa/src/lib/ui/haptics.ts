/**
 * Haptic Feedback cirúrgico (spec AGY §4.1).
 * BottomNav (8ms), olho P3 (12ms); exportado p/ reuso (ex.: PTR).
 * Fallback silencioso; reduced-motion/sem vibrate = noop.
 */
export function haptic(pattern: number | number[] = 10): void {
  try {
    if (
      typeof navigator === "undefined" ||
      typeof navigator.vibrate !== "function"
    )
      return;
    if (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    navigator.vibrate(pattern);
  } catch {
    /* best-effort */
  }
}
export function hapticTap(): void {
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    navigator.vibrate(10);
  }
}
