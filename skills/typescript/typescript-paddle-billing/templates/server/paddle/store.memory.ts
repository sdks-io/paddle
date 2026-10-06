/**
 * In-memory PaddleStore for unit tests and local experiments. Not for production:
 * it forgets everything on restart, and webhooks would then re-grant or lose access.
 * It documents the exact semantics a real implementation must keep (store.pg.ts does).
 */
import type {
  ClaimResult,
  EventFinalState,
  PaddleStore,
  PendingEvent,
  PendingPlanChange,
  PlanCatalogRow,
  PurchaseItem,
  PurchaseRow,
  SubscriptionRow,
  WriteKind,
} from "./store.js";

/** Event types that mirror state; "reopen ignored" replays only these. */
const MIRRORED_TYPES = /^(subscription\.|transaction\.completed$|adjustment\.)/;

interface EventRecord {
  eventType: string;
  occurredAt: Date;
  payload: unknown;
  receivedAt: Date;
  lastAttemptAt?: Date;
  processedAt?: Date;
  attempts: number;
  finalState?: EventFinalState;
  error?: string;
}

export class MemoryPaddleStore implements PaddleStore {
  customers = new Map<string, { paddleCustomerId: string; email: string | null }>(); // userId -> customer
  events = new Map<string, EventRecord>();
  subscriptions = new Map<string, SubscriptionRow>();
  purchases = new Map<string, PurchaseRow>();
  claims = new Map<string, { kind: WriteKind; userId: string | null; resultId: string | null; claimedAt: Date }>();
  plans = new Map<string, PlanCatalogRow>();
  credits: { userId: string; delta: number; reason: string; transactionId?: string; ref: string }[] = [];
  planChanges = new Map<string, PendingPlanChange>();

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
  async assignUserToCustomerRows(userId: string, paddleCustomerId: string) {
    let changed = 0;
    for (const row of [...this.subscriptions.values(), ...this.purchases.values()]) {
      if (row.userId === null && row.paddleCustomerId === paddleCustomerId) {
        row.userId = userId;
        changed++;
      }
    }
    return changed;
  }

  async recordEvent(event: { eventId: string; eventType: string; occurredAt: Date; payload: unknown }) {
    const existing = this.events.get(event.eventId);
    if (existing) {
      if (existing.processedAt !== undefined) return false; // processed already: duplicate delivery
      existing.receivedAt = new Date();
      return true;
    }
    this.events.set(event.eventId, { eventType: event.eventType, occurredAt: event.occurredAt, payload: event.payload, receivedAt: new Date(), attempts: 0 });
    return true;
  }
  async markEventProcessed(eventId: string, note?: string) {
    const e = this.events.get(eventId);
    if (!e) return;
    e.processedAt = new Date();
    delete e.finalState;
    if (note) e.error = note;
    else delete e.error;
  }
  async markEventFailed(eventId: string, error: string) {
    const e = this.events.get(eventId);
    if (!e) return;
    e.attempts += 1;
    e.lastAttemptAt = new Date();
    e.error = error;
  }
  async markEventFinal(eventId: string, state: EventFinalState, error: string) {
    const e = this.events.get(eventId);
    if (!e) return;
    e.finalState = state;
    e.error = error;
  }
  async leasePendingEvents(options: { maxAttempts: number; limit: number; leaseMs: number }): Promise<PendingEvent[]> {
    const now = Date.now();
    const leased = [...this.events.entries()]
      .filter(([, e]) => e.processedAt === undefined && e.finalState === undefined && e.attempts < options.maxAttempts)
      .filter(([, e]) => now - e.receivedAt.getTime() >= options.leaseMs && (!e.lastAttemptAt || now - e.lastAttemptAt.getTime() >= options.leaseMs))
      .sort(([, a], [, b]) => a.occurredAt.getTime() - b.occurredAt.getTime())
      .slice(0, options.limit);
    for (const [, e] of leased) e.lastAttemptAt = new Date(now);
    return leased.map(([eventId, e]) => ({ eventId, eventType: e.eventType, payload: e.payload, attempts: e.attempts }));
  }
  async reopenEvents(state: EventFinalState | "ignored", options: { since?: Date } = {}) {
    let n = 0;
    for (const e of this.events.values()) {
      const parked = state !== "ignored" && e.processedAt === undefined && e.finalState === state;
      const ignored =
        state === "ignored" &&
        e.processedAt !== undefined &&
        (e.error ?? "").startsWith("ignored:") &&
        MIRRORED_TYPES.test(e.eventType) &&
        (!options.since || e.receivedAt >= options.since);
      if (parked || ignored) {
        delete e.finalState;
        delete e.processedAt;
        delete e.lastAttemptAt;
        e.attempts = 0;
        n++;
      }
    }
    return n;
  }

  async parkExhaustedEvents(maxAttempts: number) {
    const parked: { eventId: string; eventType: string; error: string }[] = [];
    for (const [eventId, e] of this.events) {
      if (e.processedAt === undefined && e.finalState === undefined && e.attempts >= maxAttempts) {
        e.finalState = "gave_up";
        parked.push({ eventId, eventType: e.eventType, error: e.error ?? "" });
      }
    }
    return parked;
  }

  async upsertSubscription(row: SubscriptionRow) {
    const existing = this.subscriptions.get(row.id);
    if (existing && existing.lastEventOccurredAt > row.lastEventOccurredAt) return; // older event: ignore
    this.subscriptions.set(row.id, { ...row, userId: row.userId ?? existing?.userId ?? null });
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
    // Keep refund marks already recorded for the same lines.
    const refunded = new Map((existing?.items ?? []).map((i, idx) => [idx, i.refundedAt]));
    this.purchases.set(row.transactionId, {
      ...row,
      userId: row.userId ?? existing?.userId ?? null,
      items: row.items.map((i, idx) => ({ ...i, refundedAt: refunded.get(idx) ?? i.refundedAt })),
    });
  }
  async getPurchase(transactionId: string) {
    return this.purchases.get(transactionId);
  }
  async listPurchasesForUser(userId: string) {
    return [...this.purchases.values()].filter((p) => p.userId === userId);
  }
  async markPurchaseItemsRefunded(transactionId: string, lineItemIds: string[] | "all", at: Date): Promise<PurchaseItem[]> {
    const p = this.purchases.get(transactionId);
    if (!p) return [];
    const marked: PurchaseItem[] = [];
    for (const item of p.items) {
      const hit = lineItemIds === "all" || (item.lineItemId !== null && lineItemIds.includes(item.lineItemId));
      if (hit && item.refundedAt === null) {
        item.refundedAt = at;
        marked.push({ ...item });
      }
    }
    return marked;
  }

  async claimWrite(claimKey: string, kind: WriteKind, userId: string | null): Promise<ClaimResult> {
    const existing = this.claims.get(claimKey);
    if (existing) return { claimed: false, resultId: existing.resultId, claimedAt: existing.claimedAt };
    this.claims.set(claimKey, { kind, userId, resultId: null, claimedAt: new Date() }); // a real store relies on a UNIQUE constraint here
    return { claimed: true };
  }
  async completeClaim(claimKey: string, resultId: string) {
    const c = this.claims.get(claimKey);
    if (c) c.resultId = resultId;
  }
  async releaseClaim(claimKey: string) {
    this.claims.delete(claimKey);
  }
  async retakeClaim(claimKey: string, seen: { resultId: string | null; claimedAt: Date }) {
    const c = this.claims.get(claimKey);
    if (!c || c.resultId !== seen.resultId || c.claimedAt.getTime() !== seen.claimedAt.getTime()) return false;
    c.resultId = null;
    c.claimedAt = new Date(Math.max(Date.now(), seen.claimedAt.getTime() + 1));
    return true;
  }

  async getPlanByPriceId(priceId: string) {
    return this.plans.get(priceId);
  }
  async isClaimResult(resultId: string) {
    return [...this.claims.values()].some((c) => c.resultId === resultId);
  }
  async listUnsettledClaims(olderThanMs: number) {
    const cutoff = Date.now() - olderThanMs;
    return [...this.claims.entries()]
      .filter(([, c]) => c.resultId === null && c.claimedAt.getTime() <= cutoff)
      .map(([claimKey, c]) => ({ claimKey, kind: c.kind, userId: c.userId, claimedAt: c.claimedAt }));
  }
  async isCatalogProduct(productId: string) {
    return [...this.plans.values()].some((p) => p.productId === productId);
  }
  async listPlans() {
    return [...this.plans.values()].filter((p) => p.active).sort((a, b) => a.displayOrder - b.displayOrder);
  }

  async addCredits(entry: { userId: string; delta: number; reason: string; transactionId?: string; ref?: string }) {
    const ref = entry.ref ?? "";
    if (entry.transactionId && this.credits.some((c) => c.transactionId === entry.transactionId && c.reason === entry.reason && c.ref === ref)) return; // UNIQUE(transaction_id, reason, ref)
    this.credits.push({ ...entry, ref });
  }
  async getCreditBalance(userId: string) {
    return this.credits.filter((c) => c.userId === userId).reduce((sum, c) => sum + c.delta, 0);
  }

  async savePendingPlanChange(change: PendingPlanChange) {
    this.planChanges.set(change.subscriptionId, { ...change });
  }
  async getPendingPlanChange(subscriptionId: string) {
    const c = this.planChanges.get(subscriptionId);
    return c && c.appliedAt === null && c.canceledAt === null ? c : undefined;
  }
  async listDuePendingPlanChanges(dueBefore: Date) {
    return [...this.planChanges.values()].filter((c) => c.appliedAt === null && c.canceledAt === null && c.applyAfter <= dueBefore);
  }
  async finishPendingPlanChange(subscriptionId: string, outcome: "applied" | "canceled", at: Date, note?: string) {
    const c = this.planChanges.get(subscriptionId);
    if (!c || c.appliedAt !== null || c.canceledAt !== null) return false;
    if (outcome === "applied") c.appliedAt = at;
    else c.canceledAt = at;
    c.note = note ?? null;
    return true;
  }
  async replanPendingPlanChange(subscriptionId: string, renewalAt: Date, applyAfter: Date) {
    const c = this.planChanges.get(subscriptionId);
    if (!c || c.appliedAt !== null || c.canceledAt !== null) return false;
    c.renewalAt = renewalAt;
    c.applyAfter = applyAfter;
    return true;
  }
  async reopenPendingPlanChange(subscriptionId: string, appliedAt: Date, note: string) {
    const c = this.planChanges.get(subscriptionId);
    if (!c || c.canceledAt !== null || c.appliedAt?.getTime() !== appliedAt.getTime()) return false;
    c.appliedAt = null;
    c.note = note;
    return true;
  }
}
