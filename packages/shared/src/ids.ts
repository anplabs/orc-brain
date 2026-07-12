/** Branded ID helpers. All entities carry a ULID `id` (§4). */

/** A ULID string identifying any orc-brain entity. */
export type Ulid = string;

/** ISO-8601 timestamp string (UTC). */
export type IsoTimestamp = string;

/** Fields shared by every persisted entity (§4). */
export interface EntityBase {
  id: Ulid;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}
