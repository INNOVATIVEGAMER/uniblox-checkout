/**
 * Runs `body`, then every cleanup, even when `body` or another cleanup fails. A `body` error wins over
 * cleanup errors, so a failing cleanup never hides the assertion that failed first.
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
  const failed = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (failed) throw failed.reason;
  return result;
}
