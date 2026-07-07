/** State store: persistence for runs, tasks, and events. Schema is defined in a later commit. */

export interface Store {
  /** Whether the store is initialized and ready for reads/writes. */
  readonly ready: boolean;
  // TODO: run/task/event persistence API (SQLite schema TBD).
}

// TODO: implement the concrete state store.
export function createStore(): Store {
  throw new Error("TODO: implement createStore");
}
