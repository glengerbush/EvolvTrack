export const WELLNESS_SCORE_MIN = 0;
export const WELLNESS_SCORE_MAX = 10;

export function clampWellnessScore(value: number): number {
  return Math.min(Math.max(value, WELLNESS_SCORE_MIN), WELLNESS_SCORE_MAX);
}

export function parseWellnessScore(value: string): number | undefined {
  if (!value.trim()) return undefined;

  const wellness = Number(value);
  return Number.isFinite(wellness) ? clampWellnessScore(wellness) : undefined;
}

export function normalizeWellnessScoreInput(value: string): string {
  const wellness = parseWellnessScore(value);
  return wellness === undefined ? '' : String(wellness);
}
