import { useSyncExternalStore } from 'react';

export type LoggedCall = {
  id: number;
  method: string;
  path: string;
  status: number;
  idempotencyKey: string | undefined;
  replayed: boolean;
  retryAfter: string | null;
  body: unknown;
};

const MAX_CALLS = 10;
const EMPTY: LoggedCall[] = [];

let calls = EMPTY;
let nextId = 1;
const listeners = new Set<() => void>();

export function logCall(call: Omit<LoggedCall, 'id'>) {
  calls = [{ ...call, id: nextId++ }, ...calls].slice(0, MAX_CALLS);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The latest calls, newest first. */
export function useCallLog(): LoggedCall[] {
  return useSyncExternalStore(
    subscribe,
    () => calls,
    () => EMPTY,
  );
}
