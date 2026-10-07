/**
 * Runs `body`, then all cleanups concurrently, even when `body` or another cleanup fails. Cleanups must
 * not depend on each other's order. A `body` error wins over cleanup errors, so a failing cleanup never
 * hides the assertion that failed first; otherwise every cleanup failure is reported.
 */
export async function withCleanup<T>(body: () => Promise<T>, ...cleanups: (() => Promise<unknown>)[]): Promise<T> {
  let result: T;
  try {
    result = await body();
  } catch (err) {
    await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
    throw err;
  }
  const settled = await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
  const reasons = settled.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason] : []));
  if (reasons.length === 1) throw reasons[0];
  if (reasons.length > 1) throw new AggregateError(reasons, `${reasons.length} cleanups failed`);
  return result;
}
