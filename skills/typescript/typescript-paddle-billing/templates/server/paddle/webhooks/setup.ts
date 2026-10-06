/**
 * The app's webhook handler, built in one place. The webhook route (express.ts / nextjs.ts), the
 * reprocess job and scripts/paddle/paddle-jobs.ts all call createPaddleWebhookHandler, so an event
 * re-run by a job sends the same emails and grants the same credits as a live delivery.
 *
 * Put the app's reactions in the hooks below. They run inside webhook processing: keep them fast
 * (Paddle waits 5 seconds) and make them safe to run again for the same event (a failed event is
 * retried), e.g. ledger entries keyed by (transaction, reason, ref).
 */
import { getPaddleConfig } from "../client.js";
import type { PaddleStore } from "../store.js";
import { PaddleWebhookHandler, type WebhookHooks } from "./handler.js";

export function paddleWebhookHooks(store: PaddleStore): WebhookHooks {
  return {
    // Prepaid credit packs (recipe 03): plan_catalog.features.credits per unit, one ledger entry per line.
    async onPurchaseCompleted(purchase) {
      if (!purchase.userId) return;
      for (const item of purchase.items) {
        const credits = Number((await store.getPlanByPriceId(item.priceId))?.features["credits"] ?? 0);
        if (credits > 0) {
          await store.addCredits({ userId: purchase.userId, delta: credits * item.quantity, reason: "purchase", transactionId: purchase.transactionId, ref: item.lineItemId ?? item.priceId });
        }
      }
      // Deliver other one-time goods here (licence key, download link email).
    },
    async onPurchaseRefunded(purchase, refundedItems, adjustment) {
      if (!purchase.userId) return;
      for (const item of refundedItems) {
        const credits = Number((await store.getPlanByPriceId(item.priceId))?.features["credits"] ?? 0);
        if (credits > 0) {
          await store.addCredits({ userId: purchase.userId, delta: -credits * item.quantity, reason: "refund", transactionId: purchase.transactionId, ref: `${adjustment.id}:${item.lineItemId}` });
        }
      }
    },
    // Replace with the app's alerting (email to the owner, error tracker). Never ignore it.
    async onEventNeedsAttention(info) {
      console.error(`Paddle webhook needs attention: ${info.state} ${info.eventType} ${info.eventId}: ${info.error}`);
    },
  };
}

export function createPaddleWebhookHandler(
  store: PaddleStore,
  log: (msg: string, extra?: Record<string, unknown>) => void = (msg, extra) => console.warn(msg, extra ?? {}),
): PaddleWebhookHandler {
  return new PaddleWebhookHandler(getPaddleConfig(), store, paddleWebhookHooks(store), log);
}
