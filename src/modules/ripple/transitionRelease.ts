import { prefersReducedMotion } from "../../utils/reducedMotion";

export type TransitionReleaseTimer = ReturnType<typeof setTimeout>;

/**
 * Move an owned opacity target to its natural value before releasing the
 * inline-style claim. Reduced motion and zero-duration transitions release in
 * the same task; callers still own cancellation and identity checks.
 */
export function releaseAfterOpacityTransition(
  durationSeconds: number,
  setNaturalOpacity: () => boolean,
  release: () => void,
): TransitionReleaseTimer | null {
  if (!setNaturalOpacity()) {
    release();
    return null;
  }

  if (durationSeconds <= 0 || prefersReducedMotion()) {
    release();
    return null;
  }

  return setTimeout(release, durationSeconds * 1000);
}
