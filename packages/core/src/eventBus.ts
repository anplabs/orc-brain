/**
 * Event bus (§3): in-process typed pub/sub. Every event is *synchronously
 * appended to the store before fan-out*, so the persisted log is never behind
 * the UI. The store assigns the monotonic `seq` used as the SSE `id:` for
 * Last-Event-ID resume.
 */

import type { BusEvent } from "@orc-brain/shared";
import type { Store } from "./store/index.js";

/** A subscriber receives every published event, in order. */
export type BusSubscriber = (event: BusEvent) => void;

/** Input to {@link EventBus.publish}: everything but the store-assigned `seq`. */
export type PublishInput = Omit<BusEvent, "seq" | "ts"> & { ts?: string };

/** Typed in-process event bus backed by the persistent store. */
export class EventBus {
  private readonly subscribers = new Set<BusSubscriber>();

  constructor(private readonly store: Store) {}

  /** Subscribes to all events; returns an unsubscribe function. */
  subscribe(fn: BusSubscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /**
   * Persists then fans out an event. Persistence happens first and
   * synchronously (better-sqlite3), guaranteeing the store is never behind a
   * delivered event. Subscriber exceptions are isolated so one bad listener
   * cannot break delivery to the others or the caller.
   */
  publish(input: PublishInput): BusEvent {
    const ts = input.ts ?? new Date().toISOString();
    const withoutSeq = { ...input, ts } as Omit<BusEvent, "seq">;
    const seq = this.store.appendEvent(withoutSeq);
    const event = { ...withoutSeq, seq } as BusEvent;
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch (err) {
        // Never let a subscriber failure propagate to the publisher.
        console.error("[eventBus] subscriber threw:", err);
      }
    }
    return event;
  }
}
