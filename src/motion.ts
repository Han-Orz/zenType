export function approach(current: number, target: number, elapsed: number, response: number): number {
  if (response <= 0 || Math.abs(target - current) < 0.01) return target;
  return current + (target - current) * -Math.expm1(-Math.max(0, elapsed) / response);
}
export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
