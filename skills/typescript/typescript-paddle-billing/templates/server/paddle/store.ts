/**
 * The storage contract the Paddle modules depend on. Implement it with the
 * project's ORM against the tables in templates/db/schema.sql. Keep the
 * semantics exactly; the webhook handler relies on them:
 *
 * - `recordEvent` must be atomic "insert if absent" on event_id and return
 *   false when the event was already recorded (duplicate delivery).
 * - `upsertSubscription` / `upsertPurchase` must ignore the write when the row
 *   already holds a newer `lastEventOccurredAt` (webhooks arrive out of order).
 * - `claimTransaction` must rely on a UNIQUE constraint, not a read-then-write.
 */

export type SubscriptionStatus = "active" | "trialing" | "past_due" | "paused" | "canceled";

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
  scheduledChangeAction: "cancel" | "pause" | "resume" | null;
  scheduledChangeEffectiveAt: Date | null;
  collectionMode: "automatic" | "manual";
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
  /** Insert the event; return false if event_id already existed. */
  recordEvent(event: { eventId: string; eventType: string; occurredAt: Date; payload: unknown }): Promise<boolean>;
  markEventProcessed(eventId: string, error?: string): Promise<void>;

  // mirrors
  upsertSubscription(row: SubscriptionRow): Promise<void>;
  getSubscription(id: string): Promise<SubscriptionRow | undefined>;
  listSubscriptionsForUser(userId: string): Promise<SubscriptionRow[]>;
  upsertPurchase(row: PurchaseRow): Promise<void>;
  listPurchasesForUser(userId: string): Promise<PurchaseRow[]>;

  // server-created transactions
  /** Insert a claim; return the existing transactionId when the key was already claimed (null if claimed but not yet linked). */
  claimTransaction(claimKey: string, userId: string): Promise<{ claimed: true } | { claimed: false; transactionId: string | null }>;
  linkClaimedTransaction(claimKey: string, transactionId: string): Promise<void>;
  releaseClaim(claimKey: string): Promise<void>;

  // plan catalog (the app's own attributes per price)
  getPlanByPriceId(priceId: string): Promise<PlanCatalogRow | undefined>;
  listPlans(): Promise<PlanCatalogRow[]>;

  // credits (recipe 03 only)
  addCredits(entry: { userId: string; delta: number; reason: string; transactionId?: string }): Promise<void>;
  getCreditBalance(userId: string): Promise<number>;
}
