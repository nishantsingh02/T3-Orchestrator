// Fractional ordering within a column (tasks.position is a real).

const STEP = 1024;

/** A position strictly between `before` and `after` (either may be missing). */
export function positionBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return STEP;
  if (before === undefined) return (after as number) - STEP;
  if (after === undefined) return before + STEP;
  if (before === after) return before + 1e-6;
  return (before + after) / 2;
}

/** `count` increasing positions, evenly spaced, strictly between `before` and `after` (either may be missing). */
export function positionsBetween(before: number | undefined, after: number | undefined, count: number): number[] {
  return Array.from({ length: count }, (_, i) => {
    if (before !== undefined && after !== undefined) return before + ((after - before) * (i + 1)) / (count + 1);
    if (before !== undefined) return before + STEP * (i + 1);
    if (after !== undefined) return after - STEP * (count - i);
    return STEP * (i + 1);
  });
}

/**
 * Position for an item dropped at `index` in `list` (sorted by position, already excluding the
 * dragged item).
 */
export function positionAt(list: ReadonlyArray<{ position: number }>, index: number): number {
  const clamped = Math.max(0, Math.min(index, list.length));
  return positionBetween(list[clamped - 1]?.position, list[clamped]?.position);
}
