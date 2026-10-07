import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from 'pg';
import { inject } from 'vitest';
import { z } from 'zod';

export type LockTarget = { table: 'carts' | 'products'; id: string } | { advisoryLock: number };

export type HeldLock = { pid: number; release: () => Promise<void> };

export class BarrierTimeout extends Error {
  override name = 'BarrierTimeout';
}

// Shorter than Vitest's 5 s test timeout, so a stuck barrier fails as BarrierTimeout and cleans up
// before the test is abandoned.
const BARRIER_DEADLINE_MS = 2_000;
const POLL_INTERVAL_MS = 10;

const pidRowsSchema = z.tuple([z.object({ pid: z.number() })]);
const countRowsSchema = z.tuple([z.object({ n: z.number() })]);

async function connect(): Promise<{ client: Client; pid: number }> {
  const client = new Client({ connectionString: inject('databaseUrl') });
  await client.connect();
  try {
    const [{ pid }] = pidRowsSchema.parse((await client.query('SELECT pg_backend_pid() AS pid')).rows);
    return { client, pid };
  } catch (err) {
    await Promise.allSettled([client.end()]);
    throw err;
  }
}

/** Locks the target on a dedicated connection until release() is called. release() is safe to call twice. */
export async function holdLock(target: LockTarget): Promise<HeldLock> {
  const { client, pid } = await connect();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  };

  try {
    await client.query('BEGIN');
    if ('advisoryLock' in target) {
      await client.query('SELECT pg_advisory_xact_lock($1)', [target.advisoryLock]);
    } else {
      const locked = await client.query(`SELECT 1 FROM ${target.table} WHERE id = $1 FOR UPDATE`, [target.id]);
      if (locked.rowCount !== 1) throw new Error(`holdLock: no ${target.table} row with id ${target.id}`);
    }
    return { pid, release };
  } catch (err) {
    await Promise.allSettled([release()]);
    throw err;
  }
}

async function untilLockWaiters(waiters: number, lockPid: number, requests: Promise<unknown>[]): Promise<void> {
  let finished = 0;
  for (const request of requests) {
    request.then(
      () => finished++,
      () => finished++,
    );
  }

  const poller = await connect();
  try {
    const deadline = Date.now() + BARRIER_DEADLINE_MS;
    for (;;) {
      if (finished > 0) throw new Error(`${finished} request(s) finished without blocking on the barrier`);
      const result = await poller.client.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> ALL($1::int[])`,
        [[lockPid, poller.pid]],
      );
      const [{ n }] = countRowsSchema.parse(result.rows);
      if (n >= waiters) break;
      if (Date.now() > deadline) {
        throw new BarrierTimeout(`${n} of ${waiters} requests were waiting on a lock after ${BARRIER_DEADLINE_MS} ms`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  } catch (err) {
    await Promise.allSettled([poller.client.end()]);
    throw err;
  }
  await poller.client.end();
}

/**
 * Holds the target lock, fires the requests, waits until `waiters` of them are blocked on a lock,
 * then releases so they all contend at once. Every path releases the lock and settles the requests.
 */
export async function barrier<T>(target: LockTarget, waiters: number, fire: () => Promise<T>[]): Promise<T[]> {
  const lock = await holdLock(target);
  let requests: Promise<T>[] = [];
  try {
    requests = fire();
    await untilLockWaiters(waiters, lock.pid, requests);
  } catch (err) {
    await Promise.allSettled([lock.release(), ...requests]);
    throw err;
  }
  const released = lock.release();
  await Promise.allSettled([released, ...requests]);
  await released;
  return Promise.all(requests);
}
