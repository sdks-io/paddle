/**
 * Framework-agnostic webhook handling.
 *
 *   receive(rawBody, signatureHeader)  -> verify, record once, answer fast
 *   process(payload)                   -> apply the event to the app's tables
 *
 * Rules this implements (all from Paddle's webhook docs):
 * - Verify the Paddle-Signature header against the raw body before anything else.
 * - Answer HTTP 200 within 5 seconds. Heavy work happens after the response
 *   (queue or background task); on failure Paddle retries (live: 60 times over
 *   3 days; sandbox: 3 times in 15 minutes).
 * - Delivery is at-least-once: dedupe on event_id. An event whose processing
 *   failed is not a duplicate: Paddle's retry processes it again.
 * - Order is not guaranteed: apply an event only if its occurred_at is newer
 *   than what the row already reflects.
 * - subscription.* events carry the full subscription and are enough for
 *   entitlement.
 * - Fulfil one-time purchases on transaction.completed, never transaction.paid.
 *
 * Payloads are decoded with the SDK's webhook models (see types.ts).
 */
import type { PaddleConfig } from "../config.js";
import type { PaddleStore, SubscriptionRow } from "../store.js";
import { decodeEnvelope, decodeEvent, type AdjustmentEvent, type SubscriptionEvent, type WebhookTransaction } from "./types.js";
import { verifyPaddleSignature } from "./verify.js";

type TransactionItem = WebhookTransaction["items"][number];

export interface WebhookHooks {
  /** Called after a subscription row changed; use to send emails, invalidate caches, etc. Must not throw. */
  onSubscriptionChanged?(row: SubscriptionRow, event: SubscriptionEvent): Promise<void>;
  /**
   * Called once per completed checkout that bought one-time items: a one-time checkout, or the
   * one-time items of a subscription checkout. `items` holds only the one-time items. Not called for renewals.
   */
  onPurchaseCompleted?(tx: WebhookTransaction, userId: string | null, items: TransactionItem[]): Promise<void>;
  /** Refunds, credits, chargebacks. */
  onAdjustment?(event: AdjustmentEvent): Promise<void>;
  /** Payment failed on a renewal; show a banner, email the customer. */
  onPaymentFailed?(tx: WebhookTransaction): Promise<void>;
  /** A completed transaction that belongs to a subscription (renewal, plan change, one-off charge). Check `tx.origin`, e.g. "subscription_charge" for overage. Access is not decided here. */
  onSubscriptionTransactionCompleted?(tx: WebhookTransaction): Promise<void>;
}

export type ReceiveResult =
  | { status: 200; duplicate: boolean; eventId: string; payload: unknown }
  | { status: 400 | 401 | 500; error: string };

export class PaddleWebhookHandler {
  constructor(
    private readonly config: PaddleConfig,
    private readonly store: PaddleStore,
    private readonly hooks: WebhookHooks = {},
    private readonly log: (msg: string, extra?: Record<string, unknown>) => void = () => {},
  ) {}

  /**
   * Step 1 — call from the HTTP route. Returns the status to answer with.
   * Process the event after responding (see express.ts / nextjs.ts).
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
    let envelope;
    try {
      payload = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"));
      envelope = decodeEnvelope(payload);
    } catch {
      return { status: 400, error: "body is not a Paddle notification" };
    }

    // false only when this event_id was already processed successfully.
    const toProcess = await this.store.recordEvent({
      eventId: envelope.eventId,
      eventType: envelope.eventType,
      occurredAt: envelope.occurredAt,
      payload,
    });
    return { status: 200, duplicate: !toProcess, eventId: envelope.eventId, payload };
  }

  /**
   * Step 2 — apply the event. `payload` is the parsed body that `receive` returned, or the
   * stored `payload` column when a scheduled job re-runs unprocessed events.
   */
  async process(payload: unknown): Promise<void> {
    const envelope = decodeEnvelope(payload);
    try {
      const decoded = decodeEvent(payload);
      switch (decoded.kind) {
        case "subscription":
          await this.applySubscription(decoded.event);
          break;
        case "transaction.completed":
          await this.applyCompletedTransaction(decoded.event.data, decoded.event.occurredAt);
          break;
        case "transaction.payment_failed":
          await this.hooks.onPaymentFailed?.(decoded.event.data);
          break;
        case "adjustment":
          await this.hooks.onAdjustment?.(decoded.event);
          break;
        case "other":
          // customer.*, address.*, price.*, product.*, payout.*, other transaction.* ...: recorded, nothing to mirror.
          break;
      }
      await this.store.markEventProcessed(envelope.eventId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log("paddle webhook processing failed", { eventId: envelope.eventId, eventType: envelope.eventType, message });
      // Leaves processed_at empty, so Paddle's retry or a scheduled job processes the event again.
      await this.store.markEventFailed(envelope.eventId, message);
      throw err; // let the caller decide: if processing is synchronous, a non-2xx makes Paddle retry.
    }
  }

  private async resolveUserId(customData: Record<string, unknown> | null, customerId: string | null): Promise<string | null> {
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

  private async applySubscription(event: SubscriptionEvent): Promise<void> {
    const sub = event.data;
    const existing = await this.store.getSubscription(sub.id);
    if (existing && existing.lastEventOccurredAt > event.occurredAt) {
      this.log("paddle webhook out of order, ignored", { subscriptionId: sub.id, eventId: event.eventId });
      return;
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
      nextBilledAt: sub.nextBilledAt,
      scheduledChangeAction: sub.scheduledChange?.action ?? null,
      scheduledChangeEffectiveAt: sub.scheduledChange?.effectiveAt ?? null,
      collectionMode: sub.collectionMode,
      customData: sub.customData,
      lastEventOccurredAt: event.occurredAt,
    };
    await this.store.upsertSubscription(row);
    await this.hooks.onSubscriptionChanged?.(row, event);
  }

  private async applyCompletedTransaction(tx: WebhookTransaction, occurredAt: Date): Promise<void> {
    // Subscription renewals also complete, but entitlement for them comes from subscription.* events.
    if (tx.subscriptionId) await this.hooks.onSubscriptionTransactionCompleted?.(tx);

    // One-time items to fulfil: every item of a one-time checkout, and the one-time items bought
    // at checkout together with a subscription. Transactions Paddle creates for an existing
    // subscription (origin subscription_*) are renewals, changes and one-off charges, not purchases.
    const fromSubscriptionBilling = tx.origin.startsWith("subscription_");
    const items = tx.subscriptionId
      ? fromSubscriptionBilling ? [] : tx.items.filter((i) => i.price.billingCycle === null)
      : tx.items;
    if (items.length === 0) return;

    const userId = await this.resolveUserId(tx.customData, tx.customerId);
    await this.store.upsertPurchase({
      transactionId: tx.id,
      userId,
      paddleCustomerId: tx.customerId,
      status: "completed",
      priceIds: items.map((i) => i.price.id),
      productIds: items.map((i) => i.price.productId),
      customData: tx.customData,
      completedAt: occurredAt,
      lastEventOccurredAt: occurredAt,
    });
    await this.hooks.onPurchaseCompleted?.(tx, userId, items);
  }
}
