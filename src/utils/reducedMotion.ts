const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Read the current preference on every action so runtime changes take effect. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}
