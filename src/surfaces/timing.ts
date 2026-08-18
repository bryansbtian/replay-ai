/**
 * Durations reported by a surface come from the monotonic clock rather than
 * `Date.now`, so a clock adjustment during a long run cannot produce a negative or
 * wildly inflated step duration in the evidence.
 */
export type Stopwatch = () => number;

export function startStopwatch(): Stopwatch {
  const start = performance.now();
  return (): number => Math.round(performance.now() - start);
}
