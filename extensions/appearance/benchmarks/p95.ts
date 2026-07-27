export function p95(samples: readonly number[]): number {
  if (samples.length === 0) throw new RangeError("p95 requires at least one sample");
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}
