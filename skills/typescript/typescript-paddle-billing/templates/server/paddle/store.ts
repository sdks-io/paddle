/**
 * The storage contract the Paddle modules depend on. Implement it with the
 * project's ORM against the tables in templates/db/schema.sql. Keep the
 * semantics exactly; the webhook handler relies on them:
 *
 * - `recordEvent` must be atomic on event_id. It returns true when the event
 *   is new or was recorded but never processed successfully, and false only
 *   when it was already processed. In SQL:
 *     INSERT INTO paddle_webhook_events (event_id, event_type, occurred_at, payload)
 *     VALUES ($1, $2, $3, $4)
 *     ON CONFLICT (event_id) DO UPDATE SET received_at = now()
 *       WHERE paddle_webhook_events.processed_at IS NULL
 *     RETURNING event_id;          -- a returned row means "process it"
 * - `markEventFailed` records the error and leaves processed_at NULL, so
 *   Paddle's retry or a scheduled job processes the event again.
 * - `upsertSubscription` / `upsertPurchase` must ignore the write when the row
 *   already holds a newer `lastEventOccurredAt` (webhooks arrive out of order).
 * - `claimTransaction` must rely on a UNIQUE constraint, not a read-then-write.
 * - `linkCustomer` must keep one user per Paddle customer (UNIQUE on
 *   paddle_customer_id) and throw rather than move a customer to another user.
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

export interface PurchaseRow {
  transactionId: string;
  userId: string | null;
  paddleCustomerId: string | null;
  status: "completed";
  priceIds: string[];
  productIds: string[];
  customData: Record<string, unknown> | null;
  completedAt: Date | null;
  lastEventOccurredAt: Date;
}

export interface PlanCatalogRow {
  priceId: string;
  productId: string;
  tierKey: string;
  displayOrder: number;
  features: Record<string, unknown>;
  active: boolean;
}

export interface PaddleStore {
  // customers
  getCustomerIdForUser(userId: string): Promise<string | undefined>;
  getUserIdForCustomer(paddleCustomerId: string): Promise<string | undefined>;
  /** email is null when learned from a webhook (subscription payloads carry no email). */
  linkCustomer(userId: string, paddleCustomerId: string, email: string | null): Promise<void>;

  // webhook bookkeeping
  /** Insert the event; return false only when this event_id was already processed successfully. */
  recordEvent(event: { eventId: string; eventType: string; occurredAt: Date; payload: unknown }): Promise<boolean>;
  /** Sets processed_at and clears error. */
  markEventProcessed(eventId: string): Promise<void>;
  /** Records the error; processed_at stays NULL. */
  markEventFailed(eventId: string, error: string): Promise<void>;

  // mirrors
  upsertSubscription(row: SubscriptionRow): Promise<void>;
  getSubscription(id: string): Promise<SubscriptionRow | undefined>;
  listSubscriptionsForUser(userId: string): Promise<SubscriptionRow[]>;
  upsertPurchase(row: PurchaseRow): Promise<void>;
  listPurchasesForUser(userId: string): Promise<PurchaseRow[]>;

  // server-created transactions
  /** Insert a claim; when the key was already claimed, return its transactionId (null if not yet linked) and when it was claimed. */
  claimTransaction(claimKey: string, userId: string): Promise<{ claimed: true } | { claimed: false; transactionId: string | null; claimedAt: Date }>;
  linkClaimedTransaction(claimKey: string, transactionId: string): Promise<void>;
  releaseClaim(claimKey: string): Promise<void>;

  // plan catalog (the app's own attributes per price)
  getPlanByPriceId(priceId: string): Promise<PlanCatalogRow | undefined>;
  listPlans(): Promise<PlanCatalogRow[]>;

  // credits (recipe 03 only)
  addCredits(entry: { userId: string; delta: number; reason: string; transactionId?: string }): Promise<void>;
  getCreditBalance(userId: string): Promise<number>;
}
