/**
 * The claim pattern for provider writes that create something (a transaction, customer, refund,
 * credit, one-off charge, discount or webhook destination).
 *
 * Paddle documents no idempotency key: "Before retrying a create, list or get the entity to check
 * whether it already exists." So every create here follows one order:
 *   claim (a row under a key every caller of the same write computes the same; UNIQUE in the store)
 *   → SDK call → record the created id on the claim.
 * - A second caller with the same key does not reach Paddle: it reuses the recorded result, or,
 *   while the first call is in flight, gets WriteInProgressError (answer 409, retry shortly).
 * - Paddle refused the call (4xx) or it was never sent: the claim is released, the error rethrown.
 * - The outcome is unknown (connection lost, timeout, 5xx, unreadable 2xx): the write is looked up
 *   by the reference that was sent. Found → recorded and returned. Not found, or the lookup failed
 *   → OutcomeUnknownError, and the claim stays so a repeat cannot write twice.
 * These are the DUPLICATE CLAIMS and UNKNOWN OUTCOMES rows of the routing skill's table 1b.1.
 *
 * Updates that set a state (change items, cancel, pause, remove a scheduled change) are not
 * claimed: repeating them leaves the same state. Their unknown outcomes are settled by re-reading
 * the subscription (subscriptions.ts).
 */
import { OutcomeUnknownError, writeOutcome } from "./errors.js";
import type { PaddleStore, WriteKind } from "./store.js";

/** Another request holds the claim and has not finished yet. Answer 409 and let the caller retry shortly. */
export class WriteInProgressError extends Error {
  readonly status = 409;
  constructor(public readonly claimKey: string) {
    super("the same request is already being processed; retry shortly");
    this.name = "WriteInProgressError";
  }
}

/** A claim with no result after this long is looked up again; if Paddle has nothing, it is taken again. */
export const STALE_CLAIM_MS = 2 * 60_000;

export interface ClaimedWrite<T> {
  claimKey: string;
  kind: WriteKind;
  userId: string | null;
  /** Names the write in OutcomeUnknownError and logs, e.g. "createTransaction". */
  operation: string;
  /** The SDK call. Returns the created entity's id and the value to hand back. */
  write: () => Promise<{ id: string; value: T }>;
  /** Looks the write up by the reference it carried (custom_data, code, destination, ...), created at or after `since`. */
  find: (since: Date) => Promise<{ id: string; value: T } | undefined>;
  /**
   * An earlier write under this key finished with `resultId`. Return the value to reuse it, or
   * undefined when that result is used up (for example a checkout that was paid) so a new write is made.
   */
  reuse: (resultId: string) => Promise<T | undefined>;
}

export async function claimedWrite<T>(store: PaddleStore, w: ClaimedWrite<T>): Promise<{ value: T; reused: boolean }> {
  for (let round = 0; round < 3; round++) {
    const claim = await store.claimWrite(w.claimKey, w.kind, w.userId);
    if (!claim.claimed) {
      if (claim.resultId) {
        const value = await w.reuse(claim.resultId);
        if (value !== undefined) return { value, reused: true };
        await store.releaseClaim(w.claimKey); // used up: the next round claims the key again for a new write
        continue;
      }
      // Claimed but no result: another request is writing, or an earlier attempt ended unknown.
      if (Date.now() - claim.claimedAt.getTime() < STALE_CLAIM_MS) throw new WriteInProgressError(w.claimKey);
      const found = await w.find(claim.claimedAt);
      if (found) {
        await store.completeClaim(w.claimKey, found.id);
        return { value: found.value, reused: true };
      }
      await store.releaseClaim(w.claimKey); // Paddle has nothing under this reference: take the claim again
      continue;
    }

    const since = new Date(Date.now() - 1000);
    try {
      const created = await w.write();
      await store.completeClaim(w.claimKey, created.id);
      return { value: created.value, reused: false };
    } catch (err) {
      if (writeOutcome(err) !== "unknown") {
        await store.releaseClaim(w.claimKey); // refused or never sent: nothing was created
        throw err;
      }
      try {
        const found = await w.find(since);
        if (found) {
          await store.completeClaim(w.claimKey, found.id);
          return { value: found.value, reused: false };
        }
      } catch {
        // the lookup failed too: still unknown
      }
      throw new OutcomeUnknownError(w.operation, w.claimKey, { cause: err });
    }
  }
  throw new Error(`claimedWrite: could not settle claim ${w.claimKey}`);
}
