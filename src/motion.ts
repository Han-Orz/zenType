export interface CriticalState {
  value: number;
  velocity: number;
}

// For a unit step from rest, critical damping leaves (1 + s)e^-s of the
// displacement after s = omega * t. This is the positive solution of
// (1 + s)e^-s = 0.05, so response95Ms has one meaning for every feature.
const RESPONSE95_S = 4.743864518390577;

/** Advance a fixed-zeta=1 state through the analytic continuous solution. */
export function stepCritical(
  state: CriticalState,
  target: number,
  elapsedMs: number,
  response95Ms: number,
  positionEpsilon = 0.01,
): boolean {
  if (response95Ms <= 0) {
    state.value = target;
    state.velocity = 0;
    return true;
  }

  const elapsed = Math.max(0, elapsedMs);
  const omega = RESPONSE95_S / response95Ms;
  if (elapsed > 0) {
    const error = state.value - target;
    const coefficient = state.velocity + omega * error;
    const decay = Math.exp(-omega * elapsed);
    state.value = target + (error + coefficient * elapsed) * decay;
    state.velocity = (state.velocity - omega * coefficient * elapsed) * decay;
  }

  const epsilon = Math.max(0, positionEpsilon);
  // The velocity threshold uses the same local time scale as the position
  // threshold; callers only choose an epsilon in their own units.
  const velocityEpsilon = epsilon * omega;
  if (Math.abs(state.value - target) <= epsilon && Math.abs(state.velocity) <= velocityEpsilon) {
    state.value = target;
    state.velocity = 0;
    return true;
  }
  return false;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
