function isPositiveFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

/** Preserves the average weekly amount across a repeating interval. */
export function intervalDose(weeklyMg: number | undefined, days: number | undefined): number | null {
  if (!isPositiveFinite(weeklyMg) || !isPositiveFinite(days)) return null;
  const dose = (weeklyMg / 7) * days;
  return isPositiveFinite(dose) ? dose : null;
}

/** Each dose is proportional to the gap until the next selected weekday. */
export function twiceWeeklyDoses(weeklyMg: number | undefined, days: number[]) {
  if (!isPositiveFinite(weeklyMg) || days.length !== 2 || days[0] === days[1] ||
    days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) return null;

  const [first, second] = [...days].sort((a, b) => a - b);
  const gap = second - first;
  const doses = [
    { day: first, daysUntilNext: gap, doseMg: intervalDose(weeklyMg, gap) },
    { day: second, daysUntilNext: 7 - gap, doseMg: intervalDose(weeklyMg, 7 - gap) }
  ];
  if (doses.some((dose) => dose.doseMg === null)) return null;
  return doses.map((dose) => ({ ...dose, doseMg: dose.doseMg! }));
}

export function formatSplitDose(value: number): string {
  // Avoid displaying a positive dose as zero at the UI's two-decimal precision.
  return value < 0.01 ? '<0.01' : value.toFixed(2);
}
