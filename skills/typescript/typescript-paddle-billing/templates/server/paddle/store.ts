/**
 * The storage contract the Paddle modules depend on. `store.pg.ts` implements it for
 * PostgreSQL against templates/db/schema.sql; port it to the project's ORM if it has one.
 * `store.memory.ts` is the reference for tests. Keep the semantics exactly; the webhook
 * handler and the write helpers rely on them:
 *
 * - `recordEvent` must be atomic on event_id. It returns true when the event is new or was
 *   recorded but never processed, and false only when it was already processed. In SQL:
 *     INSERT INTO paddle_webhook_events (event_id, event_type, occurred_at, payload)
 *     VALUES ($1, $2, $3, $4)
 *     ON CONFLICT (event_id) DO UPDATE SET received_at = now()
 *       WHERE paddle_webhook_events.processed_at IS NULL
 *     RETURNING event_id;          -- a returned row means "process it"
 * - `markEventFailed` counts the attempt and records the error; processed_at stays NULL, so the
 *   reprocess job (webhooks/reprocess.ts) or a redelivery processes the event again.
 * - `markEventFinal` parks an event the job must not retry: "undecodable" (the body does not
 *   match the SDK model) or "gave_up" (attempts exhausted). `reopenEvents` puts them back,
 *   for example after an SDK upgrade or a fix.
 * - `upsertSubscription` / `upsertPurchase` must ignore the write when the row already holds a
 *   newer `lastEventOccurredAt` (webhooks arrive out of order).
 * - `claimWrite` must rely on a UNIQUE constraint, not a read-then-write.
 * - `linkCustomer` must keep one user per Paddle customer (UNIQUE on paddle_customer_id) and
 *   throw rather than move a customer to another user.
 * - `addCredits` must be idempotent on (transactionId, reason, ref).
 */
import type { CollectionMode, ScheduledChangeAction, SubscriptionStatus } from "paddle-apimatic-sdk";

export interface SubscriptionRow {
  id: string;
  userId: string | null;
  paddleCustomerId: string;
  status: SubscriptionStatus;
  priceIds: string[];
  productIds: string[];
  quantity: number;
  currentPeriodStartsAt: Date | null;
  currentPeriodEndsAt: Date | null;
  nextBilledAt: Date | null;
  scheduledChangeAction: ScheduledChangeAction | null;
  scheduledChangeEffectiveAt: Date | null;
  collectionMode: CollectionMode | null;
  customData: Record<string, unknown> | null;
  lastEventOccurredAt: Date;
}

/** One purchased line of a completed transaction. */
export interface PurchaseItem {
  /** Paddle's line item id (txnitm_...) from details.line_items; refunds name it. */
  lineItemId: string | null;
  priceId: string;
  productId: string;
  quantity: number;
  /** Set when an approved refund or a chargeback covered this line. */
  refundedAt: Date | null;
}

/** A completed transaction that bought one-time items. */
export interface PurchaseRow {
  transactionId: string;
  userId: string | null;
  paddleCustomerId: string | null;
  items: PurchaseItem[];
  customData: Record<string, unknown> | null;
  completedAt: Date;
  lastEventOccurredAt: Date;
}

export interface PlanCatalogRow {
  priceId: string;
  productId: string;
  /** What the price unlocks: a tier for recurring prices ("pro"), or the item for one-time prices ("credits-100"). */
  tierKey: string;
  displayOrder: number;
  features: Record<string, unknown>;
  active: boolean;
}

/**
 * A plan change the customer asked to take effect at the end of the current term (recipe 04).
 * Paddle has no scheduled item change, so the app keeps it and applies it shortly before the
 * renewal (subscriptions.ts applyDuePlanChanges).
 */
export interface PendingPlanChange {
  subscriptionId: string;
  userId: string;
  /** The complete item list the subscription should have after the change. */
  items: { priceId: string; quantity: number }[];
  /** The renewal (next_billed_at) the change was planned against. */
  renewalAt: Date;
  /** Earliest time the job applies it: the start of the window before renewalAt. */
  applyAfter: Date;
  requestedAt: Date;
  appliedAt: Date | null;
  canceledAt: Date | null;
  /** Why it was canceled or how it was applied. */
  note: string | null;
}

export type EventFinalState = "undecodable" | "gave_up";

export interface PendingEvent {
  eventId: string;
  eventType: string;
  payload: unknown;
  attempts: number;
}

/** Kinds of provider writes guarded by a claim (writes.ts). */
export type WriteKind = "transaction" | "customer" | "refund" | "credit" | "charge" | "destination";

export type ClaimResult = { claimed: true } | { claimed: false; resultId: string | null; claimedAt: Date };

export interface PaddleStore {
  // customers
  getCustomerIdForUser(userId: string): Promise<string | undefined>;
  getUserIdForCustomer(paddleCustomerId: string): Promise<string | undefined>;
  /** email is null when learned from a webhook (subscription payloads carry no email). */
  linkCustomer(userId: string, paddleCustomerId: string, email: string | null): Promise<void>;
  /** Gives rows stored without a user (user_id NULL) for this customer to the user. Returns how many rows changed. */
  assignUserToCustomerRows(userId: string, paddleCustomerId: string): Promise<number>;

  // webhook bookkeeping
  /** Insert the event; return false only when this event_id was already processed. */
  recordEvent(event: { eventId: string; eventType: string; occurredAt: Date; payload: unknown }): Promise<boolean>;
  /** Sets processed_at, clears error and final state. `note` records why nothing was applied (e.g. another app's event). */
  markEventProcessed(eventId: string, note?: string): Promise<void>;
  /** Counts the attempt and records the error; processed_at stays NULL. */
  markEventFailed(eventId: string, error: string): Promise<void>;
  /** Parks the event: the reprocess job skips it until reopenEvents. */
  markEventFinal(eventId: string, state: EventFinalState, error: string): Promise<void>;
  /** Unprocessed, not parked, fewer than maxAttempts attempts; oldest occurred_at first. */
  listPendingEvents(options: { maxAttempts: number; limit: number }): Promise<PendingEvent[]>;
  /** Clears the final state and the attempt count of every event parked in `state`. Returns how many. */
  reopenEvents(state: EventFinalState): Promise<number>;

  // mirrors
  upsertSubscription(row: SubscriptionRow): Promise<void>;
  getSubscription(id: string): Promise<SubscriptionRow | undefined>;
  listSubscriptionsForUser(userId: string): Promise<SubscriptionRow[]>;
  upsertPurchase(row: PurchaseRow): Promise<void>;
  getPurchase(transactionId: string): Promise<PurchaseRow | undefined>;
  listPurchasesForUser(userId: string): Promise<PurchaseRow[]>;
  /** Marks lines refunded ("all", or Paddle line item ids). Returns the lines newly marked. Idempotent. */
  markPurchaseItemsRefunded(transactionId: string, lineItemIds: string[] | "all", at: Date): Promise<PurchaseItem[]>;

  // provider-write claims (writes.ts)
  /** Insert a claim; when the key exists, return its result id (null while unknown) and when it was claimed. */
  claimWrite(claimKey: string, kind: WriteKind, userId: string | null): Promise<ClaimResult>;
  /** Record the id of what the write created (txn_, ctm_, adj_, ntfset_, or the subscription for a charge). */
  completeClaim(claimKey: string, resultId: string): Promise<void>;
  /** Delete the claim: Paddle refused the write or it was never sent, so a later attempt may write. */
  releaseClaim(claimKey: string): Promise<void>;

  // plan catalog (the app's own attributes per price it sells)
  getPlanByPriceId(priceId: string): Promise<PlanCatalogRow | undefined>;
  listPlans(): Promise<PlanCatalogRow[]>;

  // credits (recipe 03 only)
  /** Idempotent on (transactionId, reason, ref): a redelivered webhook adds nothing. */
  addCredits(entry: { userId: string; delta: number; reason: string; transactionId?: string; ref?: string }): Promise<void>;
  getCreditBalance(userId: string): Promise<number>;

  // plan changes at the end of the term (recipe 04 only)
  /** One open change per subscription: saving replaces the open one. */
  savePendingPlanChange(change: PendingPlanChange): Promise<void>;
  /** The open (not applied, not canceled) change, if any. */
  getPendingPlanChange(subscriptionId: string): Promise<PendingPlanChange | undefined>;
  /** Open changes whose applyAfter is at or before `dueBefore`. */
  listDuePendingPlanChanges(dueBefore: Date): Promise<PendingPlanChange[]>;
  finishPendingPlanChange(subscriptionId: string, outcome: "applied" | "canceled", at: Date, note?: string): Promise<void>;
}
