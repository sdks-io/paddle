# Recipe 03 — Usage-based and credit billing

Goal: customers pay for what they use (seats, overage, usage added to the next invoice, or prepaid credit packs) through one of the patterns Paddle supports, chosen with the owner.

Paddle Billing has no native metering: no usage-record endpoint, no meters, no credit balances for consumption (Paddle says these are "in development"; its "credit balance" is account credit from prorations, not usage credits). Four patterns are correct today. Pick with the user; do not promise metering.

| Pattern | Fits | Paddle mechanism |
| --- | --- | --- |
| A. Seats / units | per-user, per-project, per-site pricing | one recurring price, `quantity` on the subscription item |
| B. Overage charged now | pay-as-you-go beyond a plan, charged when it happens | `createSubscriptionCharge` with `effectiveFrom: "immediately"` and a one-time price |
| C. Usage added to the next renewal | metered usage settled monthly on the invoice | `createSubscriptionCharge` with `effectiveFrom: "next_billing_period"` |
| D. Prepaid credit packs | AI tokens, API calls, exports | one-time price per pack (recipe 02) + `credit_ledger` in the app |

Enterprise usage billed by invoice (manual collection) is possible with transactions in `collection_mode: "manual"`; it is outside this recipe.

Prerequisites: recipe 01 (an active subscription exists for patterns A–C).

## A. Seats

Needs: the recurring price with `quantity: { minimum, maximum }`; the user's `sub_…` and current `pri_…`. Produces: a subscription with the new quantity and a proration charge or credit.

1. Preview: `changePlan(subId, [{ priceId, quantity: newSeats }], "prorated_immediately", { preview: true })` → show `preview.immediateTransaction.details.totals` (charge now) or the credit.
2. Apply: `setSeats(subId, priceId, newSeats)`. Paddle bills the prorated difference now; a decrease creates credit on the customer's balance, used on future renewals.
3. Wait for `subscription.updated`; the entitlement's `quantity` changes; enforce the seat count server side.

Rules: `items` must list every item on the subscription (a single-item plan is the simple case); not within 30 minutes of renewal; not while `past_due`; while `trialing` use `"do_not_bill"`.

## B. Overage charged immediately

Needs: a one-time price for the unit (`billingCycle: null`, e.g. "1,000 extra API calls", amount per unit) or an inline price; the user's `sub_…`. Produces: a transaction with `origin: "subscription_charge"`.

```ts
await chargeOneOff(subId, [{ priceId: overagePriceId, quantity: units }], "immediately");
// or a computed amount without a catalog price:
await chargeOneOff(subId, [{ description: "Usage 2026-10", productId: usageProductId, amount: "1250", currencyCode: "USD", quantity: 1 }], "immediately");
```

Preview first with `{ preview: true }` when showing the amount to the customer. Limits: 20 immediate charges per hour and 100 per 24 hours per subscription, so batch usage (daily, or at a threshold) rather than per request. The charge uses the stored payment method; if the payment fails, `transaction.payment_failed` arrives and the default `on_payment_failure: "prevent_change"` leaves the subscription unchanged. Fulfilment: `transaction.completed` with `subscription_id` set and `origin: "subscription_charge"` — the handler passes it to the `onSubscriptionTransactionCompleted(tx)` hook; record overage payments there when `tx.origin === "subscription_charge"`.

## C. Usage settled on the next invoice

Needs: same as B. Produces: one or more one-time lines added to the next renewal transaction.

Once per period (a cron before the renewal, outside the 30-minute lock), compute usage and call `chargeOneOff(subId, items, "next_billing_period")`. The items are billed with the renewal; nothing is charged now. Repeated calls add further lines; keep a `(subscription_id, period)` record in the app so a retried job does not add usage twice (Paddle documents no idempotency key for this call). Check what will be billed with `getSubscriptionWithNext(subId).nextTransaction`.

A base plan may be a $0 recurring price so that the customer's renewal consists of usage only.

## D. Prepaid credit packs

Needs: one-time prices for the packs (recipe 02), `credit_ledger` table. Produces: an app-side balance.

1. Sell packs with checkout; on `transaction.completed` (one-time), `onPurchaseCompleted` adds `+credits × quantity` to `credit_ledger` with `transactionId` and reason `purchase`. The `UNIQUE(transaction_id, reason)` constraint makes a redelivered webhook harmless.
2. Deduct with `addCredits({ userId, delta: -n, reason: "usage" })` inside the request that consumes them; refuse when `getCreditBalance(userId) < n`.
3. On a refund (`adjustment.updated`, `status: "approved"`, `action: "refund"`), add a negative `refund` entry for that `transactionId`.
4. Show the balance and a "buy more" button; optionally auto-top-up with pattern B when a subscription exists.

Credits never expire unless the app enforces it; say so to the user, since some jurisdictions regulate expiring prepaid credits.

Done when: the chosen pattern is recorded in the plan, a sandbox test exercised it end to end (seat change, charge, or pack purchase), and the webhook/ledger reflects it.

## What to tell the user

Use the fixed wording in SKILL.md section 14 ("Paddle does not meter usage itself…"). Record the chosen pattern in the plan so later sessions do not switch it.
