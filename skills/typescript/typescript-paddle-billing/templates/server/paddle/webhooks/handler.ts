/**
 * Framework-agnostic webhook handling.
 *
 *   receive(rawBody, signatureHeader)  -> verify, record once
 *   process(payload)                   -> apply the event to the app's tables
 *
 * Rules this implements (from Paddle's webhook docs):
 * - Verify the Paddle-Signature header against the raw body before anything else.
 * - Answer within 5 seconds. The adapters process before answering by default, so a failure
 *   answers 500 and Paddle retries (live: 60 times over 3 days; sandbox: 3 times in 15 minutes).
 *   When Paddle stops retrying, the reprocess job (reprocess.ts) re-runs events still unprocessed.
 * - Delivery is at-least-once: dedupe on event_id. An event whose processing failed is not a
 *   duplicate: a redelivery or the reprocess job processes it again.
 * - Order is not guaranteed: apply an event only if its occurred_at is newer than what the row
 *   already reflects.
 * - A body that does not match the SDK model can never be applied, however often it is retried:
 *   it is parked as "undecodable" with its raw payload, answered 200, and reported through
 *   onEventNeedsAttention. After an SDK upgrade, `scripts/paddle/paddle-jobs.ts reopen undecodable`
 *   reopens and applies them.
 * - A notification destination receives every event of the Paddle account, including other apps'.
 *   Events whose prices are not in plan_catalog (and that concern no row this app already holds)
 *   are recorded and ignored.
 * - subscription.* events carry the full subscription and are enough for entitlement.
 * - Fulfil one-time purchases on transaction.completed, never transaction.paid.
 *
 * Payloads are decoded with the SDK's webhook models (see types.ts).
 */
import { getPaddleClient } from "../client.js";
import type { PaddleConfig } from "../config.js";
import type { EventFinalState, PaddleStore, PurchaseItem, PurchaseRow, SubscriptionRow } from "../store.js";
import { decodeEnvelope, decodeEvent, type AdjustmentEvent, type DecodedEvent, type SubscriptionEvent, type WebhookAdjustment, type WebhookTransaction } from "./types.js";
import { verifyPaddleSignature } from "./verify.js";

export interface WebhookHooks {
  /** Called after a subscription row changed; use to send emails, invalidate caches, etc. */
  onSubscriptionChanged?(row: SubscriptionRow, event: SubscriptionEvent): Promise<void>;
  /**
   * Called once per completed checkout that bought one-time catalog items: a one-time checkout, or the
   * one-time items of a subscription checkout. `purchase.items` holds only those lines, with quantities
   * (for credit packs: credits × quantity per line, ledger ref = the line's lineItemId). Not called for renewals.
   */
  onPurchaseCompleted?(purchase: PurchaseRow, tx: WebhookTransaction): Promise<void>;
  /**
   * Called when an approved refund of whole lines (item type "full", or a full adjustment) or a
   * chargeback covered purchased lines; the lines are already marked refunded (hasPurchased turns
   * false for them). Revoke what they gave, e.g. a negative credit entry with ref = adjustment.id.
   * A refund of part of a line's amount leaves the line in place; handle it in onAdjustment if the app pro-rates.
   */
  onPurchaseRefunded?(purchase: PurchaseRow, refundedItems: PurchaseItem[], adjustment: WebhookAdjustment): Promise<void>;
  /** Every refund, credit and chargeback event that concerns this app (any status), after the built-in handling. */
  onAdjustment?(event: AdjustmentEvent): Promise<void>;
  /** Payment failed (checkout or renewal); show a banner, email the customer. */
  onPaymentFailed?(tx: WebhookTransaction): Promise<void>;
  /**
   * A completed transaction that belongs to a subscription: the first checkout (origin "web"), renewals,
   * plan changes and one-off charges. Check `tx.origin`, e.g. "subscription_charge" for overage. Access is not decided here.
   */
  onSubscriptionTransactionCompleted?(tx: WebhookTransaction): Promise<void>;
  /** An event that needs a person: "undecodable" (body does not match the SDK model) or "gave_up" (retries exhausted). Alert the owner. */
  onEventNeedsAttention?(info: { eventId: string; eventType: string; state: EventFinalState; error: string }): Promise<void>;
}

export type ReceiveResult =
  | { status: 200; duplicate: boolean; eventId: string; payload: unknown; parked: boolean }
  | { status: 400 | 401 | 500; error: string };

/** What process() did: applied, ignored (another app's event, or nothing to do), or parked as undecodable. */
export type ProcessResult = "applied" | "ignored" | "undecodable";

export interface HandlerOptions {
  /**
   * Reads a transaction's prices and products from Paddle. Used when a refund or chargeback arrives
   * before the purchase it concerns. Defaults to the SDK client; tests pass a stub.
   */
  lookupTransaction?: (transactionId: string) => Promise<{ origin: string; items: { priceId: string; productId: string; recurring: boolean }[] } | undefined>;
}

export class PaddleWebhookHandler {
  private readonly lookupTransaction: NonNullable<HandlerOptions["lookupTransaction"]>;

  constructor(
    private readonly config: PaddleConfig,
    private readonly store: PaddleStore,
    private readonly hooks: WebhookHooks = {},
    private readonly log: (msg: string, extra?: Record<string, unknown>) => void = () => {},
    options: HandlerOptions = {},
  ) {
    this.lookupTransaction =
      options.lookupTransaction ??
      (async (transactionId) => {
        const tx = (await getPaddleClient().transactions.getTransaction({ transactionId })).data;
        return { origin: tx.origin, items: tx.items.map((i) => ({ priceId: i.price.id, productId: i.price.productId, recurring: i.price.billingCycle != null })) };
      });
  }

  /**
   * Step 1 — call from the HTTP route. Returns the status to answer with (see express.ts / nextjs.ts).
   * `parked: true` means the body was recorded as undecodable: answer 200 and do not process it.
   */
  async receive(rawBody: string | Buffer, signatureHeader: string | null | undefined): Promise<ReceiveResult> {
    const secret = this.config.webhookSecret;
    if (!secret) return { status: 500, error: "PADDLE_WEBHOOK_SECRET is not configured" };

    const verified = verifyPaddleSignature(rawBody, signatureHeader, secret, {
      toleranceSeconds: this.config.webhookToleranceSeconds,
    });
    if (!verified.ok) {
      this.log("paddle webhook rejected", { reason: verified.reason });
      return { status: 401, error: verified.reason };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"));
    } catch {
      return { status: 400, error: "body is not JSON" };
    }

    let envelope;
    try {
      envelope = decodeEnvelope(payload);
    } catch (err) {
      // Signed by Paddle but not readable as a notification: keep it for a person, do not make Paddle retry it.
      const raw = rawEnvelope(payload);
      if (!raw) return { status: 400, error: "body is not a Paddle notification" };
      const toProcess = await this.store.recordEvent({ ...raw, payload });
      if (toProcess) await this.park(raw.eventId, raw.eventType, "undecodable", err);
      return { status: 200, duplicate: !toProcess, eventId: raw.eventId, payload, parked: true };
    }

    // false only when this event_id was already processed successfully.
    const toProcess = await this.store.recordEvent({
      eventId: envelope.eventId,
      eventType: envelope.eventType,
      occurredAt: envelope.occurredAt,
      payload,
    });
    return { status: 200, duplicate: !toProcess, eventId: envelope.eventId, payload, parked: false };
  }

  /**
   * Step 2 — apply the event. `payload` is the parsed body that `receive` returned, or the stored
   * `payload` column when the reprocess job re-runs an event. Throws when applying failed (the
   * event stays unprocessed for a retry); returns "undecodable" without throwing for a body that
   * does not match the SDK model.
   */
  async process(payload: unknown): Promise<ProcessResult> {
    const raw = rawEnvelope(payload);
    let decoded: DecodedEvent;
    try {
      decoded = decodeEvent(payload);
    } catch (err) {
      if (!raw) throw err;
      await this.park(raw.eventId, raw.eventType, "undecodable", err);
      return "undecodable";
    }
    const { eventId, eventType } = decoded.event;

    try {
      let note: string | undefined;
      switch (decoded.kind) {
        case "subscription":
          note = await this.applySubscription(decoded.event);
          break;
        case "transaction.completed":
          note = await this.applyCompletedTransaction(decoded.event.data, decoded.event.occurredAt);
          break;
        case "transaction.payment_failed":
          if (await this.concernsThisApp(decoded.event.data)) await this.hooks.onPaymentFailed?.(decoded.event.data);
          else note = "ignored: prices not in plan_catalog";
          break;
        case "adjustment":
          note = await this.applyAdjustment(decoded.event);
          break;
        case "other":
          // customer.*, address.*, price.*, product.*, payout.*, other transaction.* ...: recorded, nothing to mirror.
          break;
      }
      await this.store.markEventProcessed(eventId, note);
      return note ? "ignored" : "applied";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log("paddle webhook processing failed", { eventId, eventType, message });
      // processed_at stays empty: a redelivery or the reprocess job processes the event again.
      await this.store.markEventFailed(eventId, message);
      throw err;
    }
  }

  /** Parks an event and reports it. Used by process() and by the reprocess job when retries run out. */
  async park(eventId: string, eventType: string, state: EventFinalState, cause: unknown): Promise<void> {
    const error = cause instanceof Error ? cause.message : String(cause);
    await this.store.markEventFinal(eventId, state, error);
    await this.reportParked(eventId, eventType, state, error);
  }

  /** Reports an event that is already parked (the store parked it, e.g. parkExhaustedEvents). */
  async reportParked(eventId: string, eventType: string, state: EventFinalState, error: string): Promise<void> {
    this.log(`paddle webhook ${state}`, { eventId, eventType, error });
    try {
      await this.hooks.onEventNeedsAttention?.({ eventId, eventType, state, error });
    } catch (err) {
      this.log("onEventNeedsAttention failed", { eventId, message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async resolveUserId(customData: Record<string, unknown> | null | undefined, customerId: string | null | undefined): Promise<string | null> {
    // Preferred: the user id the app passed as customData at checkout (copied to the subscription by Paddle).
    const fromCustomData = customData?.["user_id"];
    if (typeof fromCustomData === "string" && fromCustomData) return fromCustomData;
    // Fallback: the customer was linked when the checkout was opened with customer.id.
    if (customerId) return (await this.store.getUserIdForCustomer(customerId)) ?? null;
    return null;
  }

  /** Remembers user → Paddle customer the first time both are known. Never moves a customer to a second user. */
  private async linkCustomerOnce(userId: string, customerId: string): Promise<void> {
    if (await this.store.getCustomerIdForUser(userId)) return;
    const linkedUser = await this.store.getUserIdForCustomer(customerId);
    if (linkedUser && linkedUser !== userId) {
      this.log("paddle customer already linked to another user; not relinked", { customerId, userId, linkedUser });
      return;
    }
    if (!linkedUser) await this.store.linkCustomer(userId, customerId, null);
  }

  /** A price this app sells: listed in plan_catalog, or a custom price of a listed product (quotes, inline prices). */
  private async isCatalogItem(price: { id: string; productId: string }): Promise<boolean> {
    return (await this.store.getPlanByPriceId(price.id)) !== undefined || (await this.store.isCatalogProduct(price.productId));
  }

  /** A transaction concerns this app when one of its prices is this app's or its subscription is already mirrored. */
  private async concernsThisApp(tx: WebhookTransaction): Promise<boolean> {
    for (const item of tx.items) if (await this.isCatalogItem(item.price)) return true;
    return tx.subscriptionId ? (await this.store.getSubscription(tx.subscriptionId)) !== undefined : false;
  }

  /** True when this transaction, once completed, records a purchase here: a checkout (not a subscription renewal or charge) with a one-time catalog item. */
  private async wouldRecordPurchase(transactionId: string): Promise<boolean> {
    const tx = await this.lookupTransaction(transactionId);
    if (!tx || tx.origin.startsWith("subscription_")) return false;
    for (const item of tx.items) {
      if (!item.recurring && (await this.isCatalogItem({ id: item.priceId, productId: item.productId }))) return true;
    }
    return false;
  }

  private async applySubscription(event: SubscriptionEvent): Promise<string | undefined> {
    const sub = event.data;
    const existing = await this.store.getSubscription(sub.id);
    if (!existing) {
      let ours = false;
      for (const item of sub.items) if (await this.isCatalogItem(item.price)) ours = true;
      if (!ours) return "ignored: prices not in plan_catalog";
    }
    if (existing && existing.lastEventOccurredAt > event.occurredAt) {
      this.log("paddle webhook out of order, ignored", { subscriptionId: sub.id, eventId: event.eventId });
      return "ignored: older than the stored state";
    }

    const userId = (await this.resolveUserId(sub.customData, sub.customerId)) ?? existing?.userId ?? null;
    if (userId) await this.linkCustomerOnce(userId, sub.customerId);

    const activeItems = sub.items.filter((i) => i.status !== "inactive");
    const row: SubscriptionRow = {
      id: sub.id,
      userId,
      paddleCustomerId: sub.customerId,
      status: sub.status,
      priceIds: activeItems.map((i) => i.price.id),
      productIds: activeItems.map((i) => i.price.productId),
      quantity: activeItems[0]?.quantity ?? 1,
      currentPeriodStartsAt: sub.currentBillingPeriod?.startsAt ?? null,
      currentPeriodEndsAt: sub.currentBillingPeriod?.endsAt ?? null,
      nextBilledAt: sub.nextBilledAt ?? null,
      scheduledChangeAction: sub.scheduledChange?.action ?? null,
      scheduledChangeEffectiveAt: sub.scheduledChange?.effectiveAt ?? null,
      collectionMode: sub.collectionMode ?? null,
      customData: sub.customData ?? null,
      lastEventOccurredAt: event.occurredAt,
    };
    await this.store.upsertSubscription(row);
    await this.hooks.onSubscriptionChanged?.(row, event);
    return undefined;
  }

  private async applyCompletedTransaction(tx: WebhookTransaction, occurredAt: Date): Promise<string | undefined> {
    if (!(await this.concernsThisApp(tx))) return "ignored: prices not in plan_catalog";

    // Subscription renewals also complete, but entitlement for them comes from subscription.* events.
    if (tx.subscriptionId) await this.hooks.onSubscriptionTransactionCompleted?.(tx);

    // One-time items to fulfil: every item of a one-time checkout, and the one-time items bought
    // at checkout together with a subscription. Transactions Paddle creates for an existing
    // subscription (origin subscription_*) are renewals, changes and one-off charges, not purchases.
    if (tx.origin.startsWith("subscription_")) return undefined;
    const lines = tx.details.lineItems;
    const used = new Set<string>();
    const items: PurchaseItem[] = [];
    for (const item of tx.items) {
      if (item.price.billingCycle != null) continue; // recurring: the subscription grants it
      if (!(await this.isCatalogItem(item.price))) continue;
      const line = lines.find((l) => l.priceId === item.price.id && !used.has(l.id));
      if (line) used.add(line.id);
      items.push({ lineItemId: line?.id ?? null, priceId: item.price.id, productId: item.price.productId, quantity: item.quantity, refundedAt: null });
    }
    if (items.length === 0) return undefined;

    const userId = await this.resolveUserId(tx.customData, tx.customerId);
    const purchase: PurchaseRow = {
      transactionId: tx.id,
      userId,
      paddleCustomerId: tx.customerId ?? null,
      items,
      customData: tx.customData ?? null,
      completedAt: occurredAt,
      lastEventOccurredAt: occurredAt,
    };
    await this.store.upsertPurchase(purchase);
    await this.hooks.onPurchaseCompleted?.(purchase, tx);
    return undefined;
  }

  private async applyAdjustment(event: AdjustmentEvent): Promise<string | undefined> {
    const adj = event.data;
    const purchase = await this.store.getPurchase(adj.transactionId);
    const subscription = adj.subscriptionId ? await this.store.getSubscription(adj.subscriptionId) : undefined;
    // An approved refund or a chargeback takes back what the lines gave. A reversed chargeback is the owner's call (onAdjustment).
    const takesBack = (adj.action === "refund" && adj.status === "approved") || adj.action === "chargeback";
    if (!purchase && takesBack && (await this.wouldRecordPurchase(adj.transactionId))) {
      // The purchase is not recorded yet (its transaction.completed is still on its way or waiting for a retry):
      // fail, so this event is retried once the purchase exists.
      throw new Error(`purchase ${adj.transactionId} not recorded yet; retrying the ${adj.action} later`);
    }
    if (!purchase && !subscription) return "ignored: transaction not known to this app";

    if (purchase && takesBack) {
      // Whole lines only: a refund of part of a line's amount leaves the line (and what it gave) in place.
      const lineIds =
        adj.type === "full" || adj.action === "chargeback" || adj.items.length === 0
          ? ("all" as const)
          : adj.items.filter((i) => i.type === "full").map((i) => i.itemId);
      const refunded = await this.store.markPurchaseItemsRefunded(adj.transactionId, lineIds, event.occurredAt);
      if (refunded.length > 0) await this.hooks.onPurchaseRefunded?.((await this.store.getPurchase(adj.transactionId)) ?? purchase, refunded, adj);
    }
    await this.hooks.onAdjustment?.(event);
    return undefined;
  }
}

/** event_id, event_type and occurred_at read straight from the JSON, for bodies that do not match the SDK model. */
function rawEnvelope(payload: unknown): { eventId: string; eventType: string; occurredAt: Date } | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p["event_id"] !== "string") return undefined;
  const occurred = typeof p["occurred_at"] === "string" ? new Date(p["occurred_at"]) : new Date();
  return {
    eventId: p["event_id"],
    eventType: typeof p["event_type"] === "string" ? p["event_type"] : "unknown",
    occurredAt: Number.isNaN(occurred.getTime()) ? new Date() : occurred,
  };
}
