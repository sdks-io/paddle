# Recipe 06 — Discount codes and promotions

Goal: customers can enter a discount code at checkout, and the owner can offer promotions (percentage, flat or per-seat, once or recurring) on new or existing subscriptions.

Functions: `templates/server/paddle/backoffice.ts` (`createDiscountCode`, `findDiscountByCode`, `archiveDiscount`). The owner can also create discounts in Paddle > Catalog > Discounts with no code change; the app only needs to pass codes through.

## Create a code

Needs: type, amount, scope, limits from the owner. Produces: `dsc_…` and the code string.

```ts
await createDiscountCode({
  description: "Launch promo 20% off first 3 months",
  type: "percentage", amount: "20",          // percentage: "0.01".."100"
  code: "LAUNCH20",                           // letters/numbers, ≤ 32; omit to let Paddle generate
  recur: true, maximumRecurringIntervals: 3,  // default recur=false: first payment only
  usageLimit: 500,                            // total redemptions, not per customer
  restrictTo: ["pro_…"],                      // product or price IDs; omit for all
  expiresAt: new Date("2026-12-31T23:59:59Z"),
});
```

Flat discounts: `type: "flat"` or `"flat_per_seat"`, `amount` in minor units, `currencyCode` required and equal to the transaction currency. Discounts apply **after** a trial. Paddle cannot limit a code to one use per customer; enforce that in the app (check `paddle_subscriptions`/`paddle_purchases` before passing the code).

## Apply

- At checkout: `openCheckout(config, { …, discountCode: "LAUNCH20" })`, or let the customer type it (`showAddDiscounts` is on by default).
- On a server-created transaction: `discountId` in `createCheckoutTransaction`.
- On an existing subscription: `client.subscriptions.updateSubscription` with a `discount` that has the `dsc_…` ID and `effectiveFrom: "next_billing_period"` (fields: `map/operations/subscriptions.md`).
- One-off, non-catalog discount on a single transaction: the transaction create body accepts an inline `discount` object (`mode: "custom"`); these do not appear in discount lists.

## Monitor and stop

`findDiscountByCode(code)` finds active codes only (an archived code returns nothing) → `timesUsed`, `usageLimit`, `expiresAt`. Stop a code with `archiveDiscount(id)`; an archived entity stays related to existing subscriptions (Paddle's archive semantics), so current subscribers are not affected. Discounts cannot be deleted.

## Webhook

`discount.created/updated` exist; the app rarely needs them. The applied discount shows on the transaction (`discount_id`, `details.totals.discount`) and on the subscription (`discount { id, starts_at, ends_at }`).

## Errors

`discount_code_conflict` (code exists), `discount_usage_limit_exceeded`, `discount_expired`, `transaction_discount_not_eligible` (restricted to other items), `transaction_invalid_discount_currency`.

## Done when

The code applies at a sandbox checkout and `timesUsed` increments.
