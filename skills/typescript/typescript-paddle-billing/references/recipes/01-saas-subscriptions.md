# Recipe 01 — SaaS subscriptions: plans, trial, checkout, access, portal

Goal: a web app charges a monthly or yearly subscription, optionally after a free trial; paying users get the paid tier; customers manage billing themselves.

Prerequisites (SKILL.md sections 6–7): sandbox account; `PADDLE_API_KEY` stored by the user (API key message, section 14) and `whoami` passing; `PADDLE_CLIENT_TOKEN` set by the agent (`paddle-setup.ts client-token`, SKILL.md section 7); database; HTTPS webhook URL.

Each step lists **Needs** (from earlier steps) and **Produces** (used later).

## Step 1 — Business inputs (ask the user, one message)

Needs: nothing. Produces: `paddle-catalog.json`.

Ask: plan names; monthly and/or yearly amounts and currency; trial length and whether a card is required for it; seat-based or flat; what the paid tier unlocks (becomes `plan_catalog.features`); tax display preference (inclusive/exclusive/let Paddle decide); production domain.

Write the answers as the seed file. Example for "Pro, $19/month or $190/year, 14-day trial with card":

```json
{
  "products": [
    {
      "key": "pro", "name": "Pro", "taxCategory": "saas", "description": "Pro plan",
      "prices": [
        { "key": "pro-monthly", "description": "Pro monthly", "name": "Pro (monthly)", "amount": "1900", "currencyCode": "USD",
          "billingCycle": { "interval": "month", "frequency": 1 },
          "trialPeriod": { "interval": "day", "frequency": 14 } },
        { "key": "pro-yearly", "description": "Pro yearly", "name": "Pro (yearly)", "amount": "19000", "currencyCode": "USD",
          "billingCycle": { "interval": "year", "frequency": 1 },
          "trialPeriod": { "interval": "day", "frequency": 14 } }
      ]
    }
  ]
}
```

Notes: `taxCategory` must be `saas` or `standard` unless the owner has had another category approved. Amounts are minor units as strings. A cardless trial is `"trialPeriod": { "interval": "day", "frequency": 14, "requiresPaymentMethod": false }`; a paid trial adds `"unitPrice": { "amount": "100", "currencyCode": "USD" }` inside `trialPeriod`. The seed script gives a price without `quantity` the range 1–1, so checkout shows no quantity picker; for seats add `"quantity": { "minimum": 1, "maximum": 500 }`.

## Step 2 — Create the catalog

Needs: `paddle-catalog.json`. Produces: price IDs.

```bash
npx tsx scripts/paddle/paddle-seed-catalog.ts ./paddle-catalog.json
```

Prints `{ "products": { "pro": "pro_…" }, "prices": { "pro-monthly": "pri_…", "pro-yearly": "pri_…" } }` and writes `paddle-catalog.ids.json`. Re-running updates instead of duplicating. The IDs may also go in env vars (`PADDLE_PRICE_PRO_MONTHLY`) for the pricing page, but the access check uses `plan_catalog` (step 3).

## Step 3 — Database and store

Needs: price IDs from step 2. Produces: a `PaddleStore` implementation and the `plan_catalog` rows.

Run `templates/db/schema.sql` (idempotent) and use `store.pg.ts` (PostgreSQL), or port it to the project's ORM keeping the semantics in `store.ts`: `recordEvent` = insert on `event_id` that returns false only when the event was already processed; `markEventFailed` counts the attempt and leaves the event to be processed again; `upsertSubscription`/`upsertPurchase` = write only when `lastEventOccurredAt` is newer; `claimWrite` = insert under the unique key. Run `templates/tests/store.test.mts` against it.

Then insert one `plan_catalog` row per price from step 2, recurring and one-time: `(price_id, product_id, tier_key='pro', display_order, features={...})`. Webhook events whose prices are not listed there, and whose products are not those rows' products, are ignored as another app's; keep this app's products to itself.

## Step 4 — Webhook endpoint

Needs: the store, a public HTTPS URL. Produces: `PADDLE_WEBHOOK_SECRET`, `ntfset_…`.

1. Copy `templates/server/paddle/webhooks/*`. Mount with the raw body (Express: `express.raw({ type: "application/json" })` on this route, before `express.json()`; Next.js: `req.text()` on the Node runtime). Put the app's hooks (emails, credits, the owner alert in `onEventNeedsAttention`) in `webhooks/setup.ts` and build the handler with `createPaddleWebhookHandler(store)`.
2. `npx tsx --env-file=.env scripts/paddle/paddle-setup.ts webhook https://<host>/api/paddle/webhook --name "<app>"`: it reuses the destination for that URL or creates it with the events below, and writes `PADDLE_WEBHOOK_SECRET` to `.env` without printing it (a platform that reads only its own secret store: `references/adapters.md`). Restart the server.
3. Schedule the reprocess job: `startReprocessLoop(handler, store)` in the server, or `paddle-jobs.ts reprocess` every 5 minutes.
4. `npx tsx --env-file=.env scripts/paddle/paddle-inspect.ts simulate <ntfset_…> subscription_creation` → expect rows in `paddle_webhook_events`. Simulated payloads use Paddle's example price IDs, so the handler records them as ignored (`error` starts with "ignored"); that proves delivery, verification and recording. The real checkout in step 6 proves the mirror.

Events subscribed by default: `subscription.created/updated/activated/trialing/past_due/paused/resumed/canceled`, `transaction.completed`, `transaction.payment_failed`, `adjustment.created/updated`. The handler needs only `subscription.created` + `subscription.updated` for access; the others feed hooks (emails, banners). See `references/webhooks.md`.

## Step 5 — Entitlement route and guards

Needs: store, `plan_catalog`. Produces: `GET /api/billing/entitlement`.

```ts
// route handler (authenticated)
const ent = await getEntitlement(store, req.user.id);
res.json({ hasAccess: ent.hasAccess, tier: ent.tier, features: ent.features, quantity: ent.quantity, paymentPastDue: ent.paymentPastDue, endsAt: ent.endsAt });
```

Guard paid routes: `await requireTier(store, userId, "pro", ["pro"])`; map `PaywallError` to 402 or 403. Access rules: `active`, `trialing`, `past_due` have access; `paused`, `canceled` do not; a scheduled cancel keeps access until `endsAt`.

## Step 6 — Checkout

Needs: price IDs, client token, default payment link set. Produces: a working sandbox purchase.

1. Default payment link: send the user the message in SKILL.md section 14 (add the domain under website approval, then set the link under **Checkout > Checkout settings** to `https://<domain>/pay`; details in SKILL.md section 9, "Default payment link (sandbox)"). Serve `templates/web/pay.html` at that path (used for `checkout.url` and Paddle's emails).
2. Frontend: copy `templates/web/paddle-browser.ts` (and `PaddleCheckoutButton.tsx`). Config `{ clientToken: <public env>, environment: "sandbox" }`. The button calls `openCheckout` with `items: [{ priceId }]`, `userId`, and `customer: { email }` (or `{ id: ctm_… }` once linked). `customData.user_id` is how the webhook maps the subscription to the user.
3. Optional server-created transaction when the server must fix items: `createCheckoutTransaction(store, { claimKey: checkoutClaimKey(userId, items), userId, customerId, items })` then `openTransactionCheckout(config, transactionId)`; `ensureCustomer` links the user first. A double click returns the same open transaction; once it is paid, the next purchase gets a new one.
4. Test: card `4242 4242 4242 4242`, any future expiry, CVC `100`. Paddle posts `transaction.completed`, `subscription.created`, `subscription.updated`; the page polls `/api/billing/entitlement` until `hasAccess` is true.

With a card-required trial (free or paid) the checkout handles it: the subscription arrives as `trialing` with `next_billed_at` at trial end; Paddle charges then and sends `subscription.activated` + `subscription.updated`.

**Cardless trials do not go through checkout.** Paddle's checkout does not support them; the server creates the subscription:

1. The price has `trialPeriod.requiresPaymentMethod: false` (step 1).
2. `ensureCustomer(...)`, then `client.addresses.createAddress` for that customer (ask the user's country; postal code where tax needs it). Fields: `map/operations/addresses.md`.
3. `createCardlessTrial(store, { userId, customerId, addressId, priceId })` (`checkout.ts`): a billed, automatically-collected transaction with `customData.user_id`, created once per user and price. Paddle completes it because no payment is needed, and creates the subscription.
4. `transaction.completed` arrives with `subscription_id`; the subscription is `trialing` with `next_billed_at: null` (Paddle: cardless trials have no next billing date because there is no payment method) and no scheduled change.
5. Before the trial ends the customer must add a payment method: `POST /api/billing/subscription/:id/payment-method` (→ `getUpdatePaymentMethodTransaction`) and open the returned transaction with `openPaymentMethodCheckout(config, transactionId)` (`paddle-browser.ts`). It sets `variant: "one-page"`: Paddle.js refuses any other variant for a cardless trial ("Cardless trial subscriptions are only supported by one-page checkout variant"). While cardless trials are in early access, Paddle does not email trial-ending reminders for them, so the app must remind the user (use `items[0].trial_dates.ends_at`).
6. If no payment method is added, Paddle cancels the subscription at trial end (`subscription.canceled`).

Cardless trials are in public early access; during it, prices with a cardless trial can be created or updated only through the API. Source: https://developer.paddle.com/build/trials/cardless-trials.

## Step 7 — Customer portal, invoices, account page

Needs: `ctm_` link (written by the webhook or `ensureCustomer`). Produces: billing page.

- `POST /api/billing/portal` → `createPortalSession(customerId, [subscriptionId])` → redirect to `overviewUrl` (invoices, payment method, cancel). New session per click; links are temporary; never iframe.
- `GET /api/billing/invoices/:txnId` → `getInvoiceUrl(txnId)` → redirect (URL valid one hour; only `completed` transactions). List the user's transactions with `client.transactions.listTransactions`, filtered by the customer and by status `completed`/`past_due` (at most 30 per page; fields: `map/operations/transactions.md`).
- Show status from the entitlement: trial end (`subscription.nextBilledAt` while `trialing`), renewal date, `paymentPastDue` banner with the update-payment-method link, `endsAt` when a cancel is scheduled with an "Undo" button (recipe 04).

## Variations

- **Several tiers**: one product per tier, monthly and yearly prices each; `tier_key` per price; `requireTier(..., tierOrder)` for ordering.
- **Seats**: one price with `quantity` bounds. Paddle.js has no setting to lock the quantity, and passing a quantity does not lock it: the buyer can change it between the price's minimum and maximum, and Paddle bills what they choose. So treat `entitlement.quantity` (the subscription's quantity) as the paid seat count and enforce members ≤ that count in the app; change seats with recipe 04. To fix the count at checkout, open a server-created transaction with the quantity (`createCheckoutTransaction`) and still enforce the count, or set the price's minimum and maximum to the same value. Prices that are not seat-based keep the seed default 1–1, which hides the picker.
- **Localized prices**: add `unit_price_overrides` per country on the price (recipe 08) and let `PricePreview` show them.
- **Discount code at signup**: pass `discountCode` to `openCheckout` (recipe 06).

## Step 8 — Done criteria and the message to send

Done when: sandbox checkout completes; `paddle_webhook_events` holds the events; entitlement is true for the buyer; portal opens; `templates/tests/*` pass. Then send the fixed wording from SKILL.md section 14 ("Paddle is connected in sandbox…").
