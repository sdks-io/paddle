/**
 * Subscription changes, server side. Every function here changes money or
 * access, so each is called from an authenticated route that has checked the
 * subscription belongs to the signed-in user (compare paddle_subscriptions.user_id).
 *
 * The mirror in the database is NOT written here. Paddle sends
 * subscription.updated after each change and the webhook handler updates the
 * row; the UI should re-read the entitlement after the webhook lands (poll or
 * push), not assume the change from the API response.
 *
 * Paddle rules that apply (see recipes for the full list):
 * - Changing items or next_billed_at requires proration_billing_mode.
 * - items is the COMPLETE desired list; anything omitted is removed.
 * - No changes within 30 minutes of the next billing, none while past_due.
 * - Paused subscriptions accept only do_not_bill.
 * - Cancel defaults to the end of the period (scheduled_change); immediate cancel does not refund.
 * - Canceled subscriptions cannot be reinstated; the customer buys again.
 */
import type { ProrationBillingMode, SubscriptionUpdateItems, SubscriptionChargeItems } from "paddle-apimatic-sdk";
import { getPaddleClient } from "./client.js";

/** Current subscription from Paddle, with the next transaction (upcoming renewal) and recurring totals. */
export async function getSubscriptionWithNext(subscriptionId: string) {
  const res = await getPaddleClient().subscriptions.getSubscription({
    subscriptionId,
    include: ["next_transaction", "recurring_transaction_details"],
  });
  return res.data;
}

/**
 * Plan change (upgrade/downgrade) or seat change. Previews first so the UI can
 * show the immediate charge or credit, then applies.
 *
 * mode:
 *  - "prorated_immediately": charge/credit the difference now (typical upgrade).
 *  - "prorated_next_billing_period": apply now, settle the difference on the next invoice (typical downgrade).
 *  - "full_immediately" / "full_next_billing_period": no proration, full new price.
 *  - "do_not_bill": change items without charging (required while trialing or paused).
 * Credits that exceed the charge land on the customer's credit balance and are used on future invoices.
 */
export async function changePlan(
  subscriptionId: string,
  items: { priceId: string; quantity?: number }[],
  mode: ProrationBillingMode,
  options: { preview?: boolean; applyEvenIfPaymentFails?: boolean } = {},
) {
  const client = getPaddleClient();
  const body = {
    items: items.map((i): SubscriptionUpdateItems => (i.quantity === undefined ? { priceId: i.priceId } : { priceId: i.priceId, quantity: i.quantity })),
    prorationBillingMode: mode,
    // prevent_change (default): if the immediate charge fails, Paddle leaves the subscription as it was.
    onPaymentFailure: options.applyEvenIfPaymentFails ? "apply_change" : "prevent_change",
  } as const;

  if (options.preview) {
    const preview = await client.subscriptions.previewSubscriptionUpdate({ subscriptionId, body });
    return { preview: preview.data };
  }
  const updated = await client.subscriptions.updateSubscription({ subscriptionId, body });
  return { subscription: updated.data };
}

/** Seats: same price, new quantity. The price's quantity.minimum/maximum bound what Paddle accepts. */
export async function setSeats(subscriptionId: string, priceId: string, seats: number, mode: ProrationBillingMode = "prorated_immediately") {
  return changePlan(subscriptionId, [{ priceId, quantity: seats }], mode);
}

/**
 * Cancel. Default: at the end of the current period — status stays active,
 * scheduled_change = { action: "cancel", effective_at }, next_billed_at becomes null.
 * immediately: status canceled now, no automatic refund (use adjustments.ts).
 */
export async function cancelSubscription(subscriptionId: string, when: "next_billing_period" | "immediately" = "next_billing_period") {
  const res = await getPaddleClient().subscriptions.cancelSubscription({ subscriptionId, body: { effectiveFrom: when } });
  return res.data;
}

/** Undo a scheduled cancel or pause before it takes effect. */
export async function removeScheduledChange(subscriptionId: string) {
  const res = await getPaddleClient().subscriptions.updateSubscription({ subscriptionId, body: { scheduledChange: null } });
  return res.data;
}

/**
 * Pause. Default effective at the next billing period (scheduled_change.action = "pause").
 * resumeAt schedules an automatic resume. onResume "start_new_billing_period" (default) bills on resume;
 * "continue_existing_billing_period" resumes the paused period without a new charge.
 */
export async function pauseSubscription(
  subscriptionId: string,
  options: { when?: "next_billing_period" | "immediately"; resumeAt?: Date; onResume?: "start_new_billing_period" | "continue_existing_billing_period" } = {},
) {
  const res = await getPaddleClient().subscriptions.pauseSubscription({
    subscriptionId,
    body: { effectiveFrom: options.when, resumeAt: options.resumeAt, onResume: options.onResume },
  });
  return res.data;
}

/** Resume a paused subscription now, or at a date. Bills immediately when a new billing period starts. */
export async function resumeSubscription(subscriptionId: string, at: "immediately" | Date = "immediately") {
  const res = await getPaddleClient().subscriptions.resumeSubscription({
    subscriptionId,
    body: at === "immediately" ? { effectiveFrom: "immediately" } : { effectiveFrom: at },
  });
  return res.data;
}

/** Convert a trialing subscription to active now (charges the stored payment method). Automatic collection only. */
export async function activateTrialNow(subscriptionId: string) {
  const res = await getPaddleClient().subscriptions.activateSubscription({ subscriptionId });
  return res.data;
}

/** Extend a trial or move the renewal date. Must be at least 30 minutes in the future; while trialing, items/dates use do_not_bill. */
export async function setNextBilledAt(subscriptionId: string, nextBilledAt: Date) {
  const res = await getPaddleClient().subscriptions.updateSubscription({
    subscriptionId,
    body: { nextBilledAt, prorationBillingMode: "do_not_bill" },
  });
  return res.data;
}

/**
 * One-off charge on a subscription (usage, overage, add-on purchase).
 * Items must be ONE-TIME prices (billing_cycle null) — catalog or inline.
 * when "immediately": a transaction is created and charged now (limit: 20/hour, 100/day per subscription).
 * when "next_billing_period": the charge is added to the next renewal invoice.
 * Charges do not appear in subscription.items; find them on the transaction (origin subscription_charge).
 */
export async function chargeOneOff(
  subscriptionId: string,
  items: ({ priceId: string; quantity: number } | { description: string; productId: string; amount: string; currencyCode: string; quantity: number })[],
  when: "immediately" | "next_billing_period",
  options: { preview?: boolean } = {},
) {
  const client = getPaddleClient();
  const body = {
    effectiveFrom: when,
    items: items.map((i): SubscriptionChargeItems =>
      "priceId" in i
        ? { priceId: i.priceId, quantity: i.quantity }
        : {
            quantity: i.quantity,
            price: {
              description: i.description,
              productId: i.productId,
              // amount in minor units as a string, e.g. "1250" = $12.50
              unitPrice: { amount: i.amount, currencyCode: i.currencyCode as SubscriptionChargeInlineCurrency },
            },
          },
    ),
  };
  if (options.preview) {
    const preview = await client.subscriptions.previewSubscriptionCharge({ subscriptionId, body });
    return { preview: preview.data };
  }
  const res = await client.subscriptions.createSubscriptionCharge({ subscriptionId, body });
  return { subscription: res.data };
}
type SubscriptionChargeInlineCurrency = Extract<SubscriptionChargeItems, { price: unknown }>["price"]["unitPrice"]["currencyCode"];

/**
 * Let the customer update their payment method inside your app: Paddle returns a
 * transaction (zero-value for active subscriptions; the failed one for past_due).
 * Open it with Paddle.Checkout.open({ transactionId }) or send checkout.url.
 * Alternative without code: the customer portal's update-payment-method link.
 */
export async function getUpdatePaymentMethodTransaction(subscriptionId: string) {
  const res = await getPaddleClient().subscriptions.getSubscriptionUpdatePaymentMethodTransaction({ subscriptionId });
  return { transactionId: res.data.id, checkoutUrl: res.data.checkout?.url ?? null };
}
