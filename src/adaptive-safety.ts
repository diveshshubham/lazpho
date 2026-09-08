export function clampAdaptiveLimit(proposedLimit: number, minLimit: number, maxLimit: number): number {
  return Math.min(maxLimit, Math.max(minLimit, Math.round(proposedLimit)));
}
