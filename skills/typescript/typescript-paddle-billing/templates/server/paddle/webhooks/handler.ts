/**
 * Framework-agnostic webhook handling.
 *
 *   receive(rawBody, signatureHeader)  -> verify, record once, answer fast
 *   process(envelope)                  -> apply the event to the app's tables
 *
 * Rules this implements (all from Paddle's webhook docs):
 * - Verify the Paddle-Signature header against the raw body before anything else.
 * - Answer HTTP 200 within 5 seconds. Heavy work happens after the response
 *   (queue or background task); on failure Paddle retries (live: 60 times over
 *   3 days; sandbox: 3 times in 15 minutes).
 * - Delivery is at-least-once: dedupe on event_id.
 * - Order is not guaranteed: apply an event only if its occurred_at is newer
 *   than what the row already reflects.
 * - subscription.created + subscription.updated carry the full subscription
 *   and are enough for entitlement; status-specific events are informational.
 * - Fulfil one-time purchases on transaction.completed, never transaction.paid.
 */
import type { PaddleConfig } from "../config.js";
import type { PaddleStore, SubscriptionRow } from "../store.js";
import { verifyPaddleSignature } from "./verify.js";
import {
  parseDate,
  type PaddleWebhookEnvelope,
  type WebhookAdjustment,
  type WebhookSubscription,
  type WebhookTransaction,
} from "./types.js";

export interface WebhookHooks {
  /** Called after a subscription row changed; use to send emails, invalidate caches, etc. Must not throw. */
  onSubscriptionChanged?(row: SubscriptionRow, event: PaddleWebhookEnvelope<WebhookSubscription>): Promise<void>;
  /** Called once per completed one-time transaction (not for subscription renewals). */
  onPurchaseCompleted?(tx: WebhookTransaction, userId: string | null): Promise<void>;
  /** Refunds, credits, chargebacks. */
  onAdjustment?(adj: WebhookAdjustment, event: PaddleWebhookEnvelope<WebhookAdjustment>): Promise<void>;
  /** Payment failed on a renewal; show a banner, email the customer. */
  onPaymentFailed?(tx: WebhookTransaction): Promise<void>;
  /** A completed transaction that belongs to a subscription (renewal, plan change, one-off charge). Check `tx.origin`, e.g. "subscription_charge" for overage. Access is not decided here. */
  onSubscriptionTransactionCompleted?(tx: WebhookTransaction): Promise<void>;
}

export type ReceiveResult =
  | { status: 200; duplicate: boolean; envelope: PaddleWebhookEnvelope }
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

    let envelope: PaddleWebhookEnvelope;
    try {
      envelope = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")) as PaddleWebhookEnvelope;
    } catch {
      return { status: 400, error: "body is not JSON" };
    }
    if (!envelope.event_id || !envelope.event_type || !envelope.occurred_at) {
      return { status: 400, error: "missing event_id, event_type or occurred_at" };
    }

    const occurredAt = parseDate(envelope.occurred_at);
    if (!occurredAt) return { status: 400, error: "occurred_at is not a date" };

    const isNew = await this.store.recordEvent({
      eventId: envelope.event_id,
      eventType: envelope.event_type,
      occurredAt,
      payload: envelope,
    });
    return { status: 200, duplicate: !isNew, envelope };
  }

  /** Step 2 — apply the event. Safe to call for duplicates (the mirrors are idempotent) but skip them to save work. */
  async process(envelope: PaddleWebhookEnvelope): Promise<void> {
    try {
      const [entity] = envelope.event_type.split(".");
      switch (entity) {
        case "subscription":
          await this.applySubscription(envelope as PaddleWebhookEnvelope<WebhookSubscription>);
          break;
        case "transaction":
          await this.applyTransaction(envelope as PaddleWebhookEnvelope<WebhookTransaction>);
          break;
        case "adjustment":
          await this.hooks.onAdjustment?.(envelope.data as WebhookAdjustment, envelope as PaddleWebhookEnvelope<WebhookAdjustment>);
          break;
        default:
          // customer.*, address.*, price.*, product.*, payout.*, ... : recorded, nothing to mirror.
          break;
      }
      await this.store.markEventProcessed(envelope.event_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log("paddle webhook processing failed", { eventId: envelope.event_id, eventType: envelope.event_type, message });
      await this.store.markEventProcessed(envelope.event_id, message);
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

  private async applySubscription(event: PaddleWebhookEnvelope<WebhookSubscription>): Promise<void> {
    const sub = event.data;
    const occurredAt = parseDate(event.occurred_at)!;
    const existing = await this.store.getSubscription(sub.id);
    if (existing && existing.lastEventOccurredAt > occurredAt) {
      this.log("paddle webhook out of order, ignored", { subscriptionId: sub.id, eventId: event.event_id });
      return;
    }

    const userId = (await this.resolveUserId(sub.custom_data, sub.customer_id)) ?? existing?.userId ?? null;
    if (userId && !(await this.store.getCustomerIdForUser(userId))) {
      // First time we see this user with a Paddle customer: remember the link for later portal sessions and checkouts.
      await this.store.linkCustomer(userId, sub.customer_id, null);
    }

    const activeItems = sub.items.filter((i) => i.status !== "inactive");
    const row: SubscriptionRow = {
      id: sub.id,
      userId,
      paddleCustomerId: sub.customer_id,
      status: sub.status,
      priceIds: activeItems.map((i) => i.price.id),
      productIds: activeItems.map((i) => i.price.product_id),
      quantity: activeItems[0]?.quantity ?? 1,
      currentPeriodStartsAt: parseDate(sub.current_billing_period?.starts_at),
      currentPeriodEndsAt: parseDate(sub.current_billing_period?.ends_at),
      nextBilledAt: parseDate(sub.next_billed_at),
      scheduledChangeAction: sub.scheduled_change?.action ?? null,
      scheduledChangeEffectiveAt: parseDate(sub.scheduled_change?.effective_at),
      collectionMode: sub.collection_mode,
      customData: sub.custom_data,
      lastEventOccurredAt: occurredAt,
    };
    await this.store.upsertSubscription(row);
    await this.hooks.onSubscriptionChanged?.(row, event);
  }

  private async applyTransaction(event: PaddleWebhookEnvelope<WebhookTransaction>): Promise<void> {
    const tx = event.data;
    if (event.event_type === "transaction.payment_failed") {
      await this.hooks.onPaymentFailed?.(tx);
      return;
    }
    // Only completed, non-subscription transactions are one-time purchases to fulfil.
    // Subscription renewals also complete, but entitlement for them comes from subscription.updated.
    if (event.event_type !== "transaction.completed") return;
    if (tx.subscription_id) {
      await this.hooks.onSubscriptionTransactionCompleted?.(tx);
      return;
    }

    const occurredAt = parseDate(event.occurred_at)!;
    const userId = await this.resolveUserId(tx.custom_data, tx.customer_id);
    await this.store.upsertPurchase({
      transactionId: tx.id,
      userId,
      paddleCustomerId: tx.customer_id,
      status: "completed",
      priceIds: tx.items.map((i) => i.price.id),
      productIds: tx.items.map((i) => i.price.product_id),
      customData: tx.custom_data,
      completedAt: occurredAt,
      lastEventOccurredAt: occurredAt,
    });
    await this.hooks.onPurchaseCompleted?.(tx, userId);
  }
}
