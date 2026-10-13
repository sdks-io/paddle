# Capabilities, limits and the domain model

## Capabilities and limits

Supported through the API and Paddle.js: products, prices (one-time, recurring, trials, per-seat quantity, localized overrides), customers/addresses/businesses, transactions (checkout, invoices, previews, revisions), subscriptions (update items, proration, pause/resume/cancel, one-off charges, payment method update), adjustments (refund, credit), discounts and discount groups, customer portal sessions, pricing previews, notification destinations, webhook simulations, events/notifications/logs, reports (CSV), metrics, client-side tokens, IP allowlist.

Not supported, with the correct alternative:

| Not available | Do this instead |
| --- | --- |
| Native usage metering, usage records, credit meters (Paddle says these are in development) | Seats as `quantity`; one-off charges for overage; add a one-time charge to the next renewal; sell prepaid credit packs and keep the balance in the app (recipe 03) |
| Deleting products, prices, customers, transactions, subscriptions, discounts | Archive (`status: "archived"`); only notification destinations, saved payment methods and checkout domains can be deleted |
| Creating a subscription directly via API | A completed checkout (Paddle.js or `checkout.url`), a billed manual invoice, or, for a cardless trial, a transaction created with `status: "billed"` (recipe 01) creates it |
| Reinstating a canceled subscription | The customer buys again; undo a *scheduled* cancel with `updateSubscription({ subscriptionId, body: { scheduledChange: null } })` before it takes effect |
| Changing a subscription while `past_due` or within 30 minutes of renewal | Wait for payment recovery or the renewal; show the user why |
| Mixed billing intervals on one subscription | Separate subscriptions, or align intervals |
| Refund without review on live | Expect `pending_approval`; sandbox auto-approves every 10 minutes |
| Idempotency key on POST | Paddle: "The Paddle API doesn't currently support client-supplied idempotency keys". Sending an `Idempotency-Key` header (the SDK adds one to every write) does not make a repeated Paddle write safe, so never add POST or PATCH to the SDK's retried methods. Creates use the claim pattern in `templates/server/paddle/writes.ts`; state-setting updates are re-read after an unknown outcome |
| Scheduling a plan or price change for the next renewal | `scheduled_change` only covers cancel, pause and resume. The app keeps the change and applies it shortly before the renewal (recipe 04, "Change at the end of the term") |
| Crediting a card (automatically-collected) transaction, or adding to a customer's credit balance | Credits apply only to invoices; Paddle fills credit balances only from prorations. Goodwill for a card subscription: a partial refund, or a one-cycle discount (`grantGoodwillDiscount`, recipe 05) |
| Locking the quantity in Paddle.js checkout | Set the price's `quantity` limits (the seed script defaults to 1–1), or open a server-created transaction; enforce seat counts in the app (recipe 01, "Seats") |

Limits that shape the build: 240 API requests/min per IP (429 with `Retry-After`); 1,000/min for pricing and transaction previews; 20 immediate subscription charges per hour and 100 per day per subscription; 10 active webhook destinations; `client.transactions.listTransactions` returns at most 30 per page, adjustments 50, other lists 200; 100 reports per 24 hours; API keys expire (default 90 days, max 1 year); customer emails must be unique; webhooks, events and notification logs are kept 90 days; invoice and credit-note PDF URLs expire after one hour, report CSV URLs after 3 minutes.

## Domain model

| Paddle term | Meaning |
| --- | --- |
| Product (`pro_`) | What you sell; carries the `tax_category` |
| Price (`pri_`) | An amount, currency, and optional `billing_cycle`/`trial_period` for a product; `quantity.minimum/maximum` bound seats |
| Customer (`ctm_`), Address (`add_`), Business (`biz_`) | The buyer; address decides tax; business adds a tax ID for B2B invoices |
| Transaction (`txn_`) | One billing event: a checkout, a renewal, an upgrade charge, an invoice. Statuses `draft → ready → billed → paid → completed`, or `canceled`/`past_due` |
| Subscription (`sub_`) | Recurring billing created by a completed checkout with recurring items. Statuses `trialing`, `active`, `past_due`, `paused`, `canceled` |
| Adjustment (`adj_`) | A refund or credit against a transaction; Paddle also records chargebacks here |
| Discount (`dsc_`) | Percentage, flat or flat-per-seat; optional code; may recur |
| Notification destination (`ntfset_`), Event (`evt_`), Notification (`ntf_`) | Webhook endpoint; a thing that happened; one delivery attempt of it |
| Client-side token (`test_`/`live_`) | Public token for Paddle.js; can only open checkouts and preview prices |
| API key (`pdl_sdbx_apikey_`/`pdl_live_apikey_`) | Server secret with granular permissions |
