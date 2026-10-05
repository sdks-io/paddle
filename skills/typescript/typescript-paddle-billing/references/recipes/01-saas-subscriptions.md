# Recipe 01 — SaaS subscriptions: plans, trial, checkout, access, portal

Goal: a web app charges a monthly or yearly subscription, optionally after a free trial; paying users get the paid tier; customers manage billing themselves.

Prerequisites (SKILL.md sections 6–7): sandbox account; `PADDLE_API_KEY` stored by the user (API key message, section 14) and `whoami` passing; `PADDLE_CLIENT_TOKEN` set by the agent (SKILL.md section 7: create the client-side token once with `client.clientTokens.createClientToken({ body: { name } })` and set it as `PADDLE_CLIENT_TOKEN`); database; HTTPS webhook URL.

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

Notes: `taxCategory` must be `saas` or `standard` unless the owner has had another category approved. Amounts are minor units as strings. A cardless trial is `"trialPeriod": { "interval": "day", "frequency": 14, "requiresPaymentMethod": false }`; a paid trial adds `"unitPrice": { "amount": "100", "currencyCode": "USD" }`. For seats add `"quantity": { "minimum": 1, "maximum": 500 }`.

## Step 2 — Create the catalog

Needs: `paddle-catalog.json`. Produces: price IDs.

```bash
npx tsx scripts/paddle/paddle-seed-catalog.ts ./paddle-catalog.json
```

Prints `{ "pro": "pro_…", "pro-monthly": "pri_…", "pro-yearly": "pri_…" }` and writes `paddle-catalog.ids.json`. Re-running updates instead of duplicating. Insert one `plan_catalog` row per price: `(price_id, product_id, tier_key='pro', display_order, features={...})`. The IDs may also go in env vars (`PADDLE_PRICE_PRO_MONTHLY`) for the pricing page, but the access check uses `plan_catalog`.

## Step 3 — Database and store

Needs: nothing from Paddle. Produces: a `PaddleStore` implementation.

Create the tables from `templates/db/schema.sql`. Implement `PaddleStore` (`templates/server/paddle/store.ts`) with the project's ORM. Keep: `recordEvent` = insert-if-absent on `event_id` (return false on conflict); `upsertSubscription`/`upsertPurchase` = write only when `lastEventOccurredAt` is newer; `claimTransaction` = insert under the unique key, catch the unique violation.

## Step 4 — Webhook endpoint

Needs: the store, a public HTTPS URL. Produces: `PADDLE_WEBHOOK_SECRET`, `ntfset_…`.

1. Copy `templates/server/paddle/webhooks/*`. Mount with the raw body (Express: `express.raw({ type: "application/json" })` on this route, before `express.json()`; Next.js: `req.text()` on the Node runtime).
2. With `destination: "https://<host>/api/paddle/webhook"`, create the destination once with `client.notificationSettings.createNotificationSetting({ body: { description, type: "url", destination, subscribedEvents, trafficSource: "all" } })` (first check `client.notificationSettings.listNotificationSettings({ perPage: 200 })` for one with the same `destination` and update its `subscribedEvents` instead of creating a second), and write `data.endpointSecretKey` straight to `paddle-webhook-secret.local` (git-ignored, owner-only permissions) without printing or logging it (SKILL.md section 7). Send the user the webhook-secret message (SKILL.md section 14); when they reply "done", delete the file and restart the server.
3. `npx tsx scripts/paddle/paddle-inspect.ts simulate <ntfset_…> subscription_creation` → expect rows in `paddle_webhook_events` with `processed_at` set and no `error`.

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

1. Paddle > Checkout > Checkout configuration > **Default payment link**: `https://localhost/pay` (sandbox accepts it) or your dev URL. Serve `templates/web/pay.html` at that path (used for `checkout.url` and Paddle's emails).
2. Frontend: copy `templates/web/paddle-browser.ts` (and `PaddleCheckoutButton.tsx`). Config `{ clientToken: <public env>, environment: "sandbox" }`. The button calls `openCheckout` with `items: [{ priceId }]`, `userId`, and `customer: { email }` (or `{ id: ctm_… }` once linked). `customData.user_id` is how the webhook maps the subscription to the user.
3. Optional server-created transaction when the server must fix items: `createCheckoutTransaction(store, { claimKey: "signup:" + userId + ":" + priceId, userId, customerId, items })` then `openTransactionCheckout(config, transactionId)`; `ensureCustomer` links the user first.
4. Test: card `4242 4242 4242 4242`, any future expiry, CVC `100`. Paddle posts `transaction.completed`, `subscription.created`, `subscription.updated`; the page polls `/api/billing/entitlement` until `hasAccess` is true.

With a card-required trial (free or paid) the checkout handles it: the subscription arrives as `trialing` with `next_billed_at` at trial end; Paddle charges then and sends `subscription.activated` + `subscription.updated`.

**Cardless trials do not go through checkout.** Paddle's checkout does not support them; the server creates the subscription:

1. The price has `trialPeriod.requiresPaymentMethod: false` (step 1).
2. `ensureCustomer(...)` then `client.addresses.createAddress({ customerId, body: { countryCode } })` (ask the user's country; postal code where tax needs it).
3. `client.transactions.createTransaction({ body: { items: [{ priceId, quantity: 1 }], customerId, addressId, currencyCode, status: "billed", customData: { user_id } } })` — create it with `status: "billed"`; Paddle completes it automatically because no payment is needed, and creates the subscription.
4. `transaction.completed` arrives with `subscription_id`; the subscription is `trialing` with `next_billed_at: null` (Paddle: cardless trials have no next billing date because there is no payment method) and no scheduled change.
5. Before the trial ends the customer must add a payment method: `getUpdatePaymentMethodTransaction(subscriptionId)` → `Paddle.Checkout.open({ transactionId, settings: { variant: "one-page" } })`. Paddle's docs state it does not email trial-ending reminders for cardless trials, so the app must remind the user (use `items[0].trial_dates.ends_at`).
6. If no payment method is added, Paddle cancels the subscription at trial end (`subscription.canceled`).

Cardless trials are in public early access (Paddle: dashboard support "coming soon"); automatic collection mode is required. Source: https://developer.paddle.com/build/trials/cardless-trials.

## Step 7 — Customer portal, invoices, account page

Needs: `ctm_` link (written by the webhook or `ensureCustomer`). Produces: billing page.

- `POST /api/billing/portal` → `createPortalSession(customerId, [subscriptionId])` → redirect to `overviewUrl` (invoices, payment method, cancel). New session per click; links are temporary; never iframe.
- `GET /api/billing/invoices/:txnId` → `getInvoiceUrl(txnId)` → redirect (URL valid one hour; only `completed` transactions). List the user's transactions with `client.transactions.listTransactions({ customerId: [ctm], perPage: 30 })`, filtered to statuses `completed`/`past_due`.
- Show status from the entitlement: trial end (`subscription.nextBilledAt` while `trialing`), renewal date, `paymentPastDue` banner with the update-payment-method link, `endsAt` when a cancel is scheduled with an "Undo" button (recipe 04).

## Step 8 — Done criteria and the message to send

Done when: sandbox checkout completes; `paddle_webhook_events` holds the events; entitlement is true for the buyer; portal opens; `templates/tests/*` pass. Then send the fixed wording from SKILL.md section 14 ("Paddle is connected in sandbox…").

## Variations

- **Several tiers**: one product per tier, monthly and yearly prices each; `tier_key` per price; `requireTier(..., tierOrder)` for ordering.
- **Seats**: one price with `quantity` bounds; the checkout lets the buyer choose quantity between min and max; `entitlement.quantity` is the seat count; change seats with recipe 04.
- **Localized prices**: add `unit_price_overrides` per country on the price (recipe 08) and let `PricePreview` show them.
- **Discount code at signup**: pass `discountCode` to `openCheckout` (recipe 06).
