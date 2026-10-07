import { setTimeout as sleep } from 'node:timers/promises';

// Shorter than Vitest's 5 s test timeout, so a stuck wait fails with its own name and cleans up.
const DEADLINE_MS = 2_000;

export class WaitTimeout extends Error {
  override name = 'WaitTimeout';
}

/** Rejects with WaitTimeout if `promise` hasn't settled within the deadline. */
export async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  const controller = new AbortController();
  const deadline = sleep(DEADLINE_MS, undefined, { signal: controller.signal }).then(() => {
    throw new WaitTimeout(`${label} after ${DEADLINE_MS} ms`);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    controller.abort();
    deadline.catch(() => {});
  }
}

/** Resolves with the first `n` of `promises` to fulfil, in the order they fulfilled. */
export function firstFulfilled<T>(promises: Promise<T>[], n: number): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const fulfilled: T[] = [];
    for (const promise of promises) {
      promise.then((value) => {
        fulfilled.push(value);
        if (fulfilled.length === n) resolve([...fulfilled]);
      }, reject);
    }
  });
}
