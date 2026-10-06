# Recipe 04 — Upgrade, downgrade, trial handling, pause, cancel, payment method

Goal: a subscriber can upgrade, downgrade, change seats, end or extend a trial, pause, resume, cancel or undo a cancel, and update their payment method; the app's access follows each change once Paddle confirms it.

All functions are in `templates/server/paddle/subscriptions.ts`. Every route that calls them must first load the user's subscription row and check `row.userId === currentUser.id`. After each change wait for `subscription.updated`; do not update the mirror from the API response.

Paddle constraints that apply to every change: no change within 30 minutes of `next_billed_at` (`subscription_locked_renewal`), none while `past_due` (`subscription_update_when_past_due`), none on a canceled subscription, one billing interval per subscription, `items` is the complete list.

## Upgrade or downgrade (change plan)

Needs: `sub_…`, current items (from the row or `getSubscriptionWithNext`), target `pri_…`. Produces: a new plan, optional immediate transaction.

1. Decide the mode on the server: `mode = await chooseProrationMode({ status, priceId: currentPriceId, quantity }, { priceId: newPriceId, quantity })` applies the table below. Never take the mode from the browser.
2. Preview so the customer sees the money: `changePlan(subId, [{ priceId: newPriceId, quantity }], mode, { preview: true })`. Read `preview.immediateTransaction` (charge or credit now), `preview.nextTransaction` (next invoice), `preview.updateSummary`.
3. Apply with the same arguments without `preview`.

Choosing `mode` (`proration_billing_mode`):

| Situation | mode | Effect |
| --- | --- | --- |
| Upgrade (more expensive) | `prorated_immediately` | charge the difference for the rest of the period now |
| Downgrade (cheaper) | `prorated_next_billing_period` | switch now, credit the difference on the next invoice |
| Switch monthly ↔ yearly | `prorated_immediately` or `full_immediately` | billing-frequency changes allow only `prorated_immediately`, `full_immediately`, `do_not_bill` |
| Change during trial | `do_not_bill` | the only mode allowed while `trialing`; price takes effect at trial end |
| Change while paused | `do_not_bill` | the only mode allowed while `paused` |
| Free change (goodwill) | `do_not_bill` | no charge, no credit; the owner's decision, never from a customer request |
| Change at the end of the term (e.g. yearly → monthly, or a downgrade the customer keeps paying the higher tier for until renewal) | none now | `requestPlanChangeAtRenewal`; see "Change at the end of the term" |

Keep add-ons by listing them: `[{ priceId: newBase, quantity }, { priceId: addOn, quantity: 1 }]` (`routes.express.ts` reads the current items with `currentItems` and replaces only the base plan). Credits larger than the charge are added to the customer's credit balance (`client.customers.listCreditBalances`) and are used automatically on later invoices. If the immediate charge fails, Paddle's default (`on_payment_failure: "prevent_change"`) keeps the old plan; tell the customer to update the payment method. `changePlan` sends `on_payment_failure` only when called with `applyEvenIfPaymentFails`.

## Change at the end of the term

Paddle cannot schedule an item or price change: `scheduled_change` covers only cancel, pause and resume, and a billing-cycle change accepts only `prorated_immediately`, `full_immediately` or `do_not_bill`, all applied at once. Applying yearly → monthly now with `do_not_bill` ends the paid year early: in testing, Paddle moved the next bill from 2027-10-05 to 2026-11-05, so the customer lost the rest of the year they had paid for. So the app keeps the request and applies it shortly before the renewal.

Needs: `sub_…` (active, no scheduled cancel or pause), target `pri_…` from `plan_catalog`. Produces: a `paddle_pending_plan_changes` row, then the changed subscription at renewal.

1. `POST /api/billing/subscription/:id/change-at-renewal` → `requestPlanChangeAtRenewal(store, { subscriptionId, userId, items })` stores the complete item list and the renewal date (`next_billed_at`). Nothing changes in Paddle; the entitlement route shows `changeAtRenewal`. `DELETE` on the same path cancels it.
2. Schedule `paddle-jobs.ts plan-changes` (or `applyDuePlanChanges(store)`) at least every 15 minutes. Between 2 hours and 35 minutes before the renewal it applies the change:
    - same billing cycle (a downgrade): `do_not_bill`; the renewal then bills the new price;
    - different billing cycle (yearly ↔ monthly): `full_immediately`; the new price is charged at once and a new term starts then, at most two hours before the old one would have ended. Those minutes are not credited.
3. The job cancels the pending change when the subscription is no longer active or has a scheduled cancel or pause, and re-plans it when the renewal date moved (trial extended, date changed).
4. `subscription.updated` arrives as for any change; the mirror follows.

## Trials

- Extend: `setNextBilledAt(subId, newDate)` (≥ 30 minutes ahead; uses `do_not_bill`).
- Convert early: `activateTrialNow(subId)` charges now and sets `active` (automatic collection only).
- Change plan during trial: `changePlan(..., "do_not_bill")`.
- Cardless trial payment method: `getUpdatePaymentMethodTransaction(subId)` → `openPaymentMethodCheckout(config, transactionId)`, which sets the one-page variant Paddle requires for cardless trials.

## Cancel

Needs: `sub_…`, the user's choice. Produces: `scheduled_change.action = "cancel"` or status `canceled`.

- Default (recommended): `cancelSubscription(subId)` → stays `active`, `scheduled_change: { action: "cancel", effective_at }`, `next_billed_at: null`. The entitlement keeps access until `endsAt`. Offer "Undo cancellation": `removeScheduledChange(subId)`.
- Immediate: `cancelSubscription(subId, "immediately")` → `canceled` now, access ends now, **no automatic refund**; refund separately (recipe 05) if the policy says so. Ask the user before using this; it cannot be undone and a canceled subscription cannot be reinstated.
- Paused subscriptions cancel immediately whatever `effective_from` says.
- Alternative without code: the `cancelUrl` from `createPortalSession`. Retain's cancellation flows (live only) can run before this.

## Pause and resume

- `pauseSubscription(subId)` → scheduled at the end of the period (`scheduled_change.action = "pause"`); `{ when: "immediately" }` pauses now. Add `resumeAt` for an automatic resume. `onResume` decides whether resume starts a new billing period (default; charges on resume) or continues the paused one.
- `resumeSubscription(subId)` resumes now and charges when a new period starts; `resumeSubscription(subId, date)` schedules it. Resuming needs a payment method on file.
- Access while paused: none by default (entitlement), or read-only if the user prefers; `current_billing_period` is null while paused and canceled; read `next_billed_at` from the payload rather than assuming it.

## Payment method update and past_due

- Self-service: portal `updatePaymentMethodUrl`, or `POST /api/billing/subscription/:id/payment-method` → `openPaymentMethodCheckout(config, transactionId)` in the app. For an active subscription it is a zero-value transaction; for a `past_due` one it is the unpaid transaction, so completing it also pays the overdue amount.
- `past_due`: Paddle retries automatically (without Retain up to seven times over 30 days, then cancels; with Retain, configurable). `subscription.past_due` and `transaction.payment_failed` arrive; show the banner, keep access, email the customer. No API changes are possible until the subscription is active again.

## Change billing date

`setNextBilledAt(subId, date)` aligns renewals (for example all customers on the 1st). Only `prorated_immediately`, `prorated_next_billing_period`, `do_not_bill` are allowed for date changes; the template uses `do_not_bill`; pass another mode by calling `updateSubscription` directly when the user wants proration.

## Discounts on an existing subscription

`client.subscriptions.updateSubscription` with a `discount` that has the `dsc_…` ID and `effectiveFrom: "next_billing_period"` (fields: `map/operations/subscriptions.md`); remove it with `discount: null` (or in the dashboard). See recipe 06 for creating discounts.

## Checks

- Preview before any change that charges; show the amount and currency from the preview, not computed locally.
- Catch `subscription_locked_renewal` / `subscription_update_when_past_due` and show "try again after your renewal" / "update your payment method first".
- Never call these for a subscription the current user does not own.

## Done when

The change shows in the Paddle dashboard, `subscription.updated` has arrived and the mirror row reflects it, and the UI re-read the entitlement.
