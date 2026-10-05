/**
 * In-memory PaddleStore for unit tests and local experiments. Not for production:
 * it forgets everything on restart, and webhooks would then re-grant or lose access.
 * It documents the exact semantics a real implementation must keep.
 */
import type { PaddleStore, PlanCatalogRow, PurchaseRow, SubscriptionRow } from "./store.js";

export class MemoryPaddleStore implements PaddleStore {
  customers = new Map<string, { paddleCustomerId: string; email: string | null }>(); // userId -> customer
  events = new Map<string, { eventType: string; occurredAt: Date; payload: unknown; processedAt?: Date; error?: string }>();
  subscriptions = new Map<string, SubscriptionRow>();
  purchases = new Map<string, PurchaseRow>();
  claims = new Map<string, { userId: string; transactionId: string | null; claimedAt: Date }>();
  plans = new Map<string, PlanCatalogRow>();
  credits: { userId: string; delta: number; reason: string; transactionId?: string }[] = [];

  async getCustomerIdForUser(userId: string) {
    return this.customers.get(userId)?.paddleCustomerId;
  }
  async getUserIdForCustomer(paddleCustomerId: string) {
    for (const [userId, c] of this.customers) if (c.paddleCustomerId === paddleCustomerId) return userId;
    return undefined;
  }
  async linkCustomer(userId: string, paddleCustomerId: string, email: string | null) {
    const linkedUser = await this.getUserIdForCustomer(paddleCustomerId);
    if (linkedUser && linkedUser !== userId) throw new Error(`${paddleCustomerId} is already linked to another user`); // UNIQUE(paddle_customer_id)
    this.customers.set(userId, { paddleCustomerId, email });
  }

  async recordEvent(event: { eventId: string; eventType: string; occurredAt: Date; payload: unknown }) {
    const existing = this.events.get(event.eventId);
    if (existing) return existing.processedAt === undefined; // processed already: duplicate delivery
    this.events.set(event.eventId, { eventType: event.eventType, occurredAt: event.occurredAt, payload: event.payload });
    return true;
  }
  async markEventProcessed(eventId: string) {
    const e = this.events.get(eventId);
    if (e) {
      e.processedAt = new Date();
      delete e.error;
    }
  }
  async markEventFailed(eventId: string, error: string) {
    const e = this.events.get(eventId);
    if (e) e.error = error;
  }

  async upsertSubscription(row: SubscriptionRow) {
    const existing = this.subscriptions.get(row.id);
    if (existing && existing.lastEventOccurredAt > row.lastEventOccurredAt) return; // older event: ignore
    this.subscriptions.set(row.id, row);
  }
  async getSubscription(id: string) {
    return this.subscriptions.get(id);
  }
  async listSubscriptionsForUser(userId: string) {
    return [...this.subscriptions.values()].filter((s) => s.userId === userId);
  }
  async upsertPurchase(row: PurchaseRow) {
    const existing = this.purchases.get(row.transactionId);
    if (existing && existing.lastEventOccurredAt > row.lastEventOccurredAt) return;
    this.purchases.set(row.transactionId, row);
  }
  async listPurchasesForUser(userId: string) {
    return [...this.purchases.values()].filter((p) => p.userId === userId);
  }

  async claimTransaction(claimKey: string, userId: string) {
    const existing = this.claims.get(claimKey);
    if (existing) return { claimed: false as const, transactionId: existing.transactionId, claimedAt: existing.claimedAt };
    this.claims.set(claimKey, { userId, transactionId: null, claimedAt: new Date() }); // a real store relies on a UNIQUE constraint here
    return { claimed: true as const };
  }
  async linkClaimedTransaction(claimKey: string, transactionId: string) {
    const c = this.claims.get(claimKey);
    if (c) c.transactionId = transactionId;
  }
  async releaseClaim(claimKey: string) {
    this.claims.delete(claimKey);
  }

  async getPlanByPriceId(priceId: string) {
    return this.plans.get(priceId);
  }
  async listPlans() {
    return [...this.plans.values()].filter((p) => p.active).sort((a, b) => a.displayOrder - b.displayOrder);
  }

  async addCredits(entry: { userId: string; delta: number; reason: string; transactionId?: string }) {
    if (entry.transactionId && this.credits.some((c) => c.transactionId === entry.transactionId && c.reason === entry.reason)) return; // UNIQUE(transaction_id, reason)
    this.credits.push(entry);
  }
  async getCreditBalance(userId: string) {
    return this.credits.filter((c) => c.userId === userId).reduce((sum, c) => sum + c.delta, 0);
  }
}
