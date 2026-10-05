# Recipe 02 — One-time purchase (lifetime licence, download, add-on, credit pack)

Goal: a customer pays once; the app unlocks the item after Paddle confirms the payment. No subscription is created.

Prerequisites: recipe 01 steps 3–5 (store, webhook, entitlement route). The webhook handler already fulfils one-time purchases; this recipe adds the catalog entry, the button and the access check.

## Step 1 — Price without a billing cycle

Needs: product name, amount, currency, tax category (`standard` for most digital goods, `saas` for software access). Produces: `pri_…`.

In `paddle-catalog.json`, a one-time price is `"billingCycle": null` (the seed script omits `billing_cycle`):

```json
{ "key": "lifetime", "name": "Lifetime licence", "taxCategory": "saas",
  "prices": [ { "key": "lifetime", "description": "Lifetime licence", "amount": "9900", "currencyCode": "USD", "billingCycle": null } ] }
```

Run the seed script. Record the product ID (`pro_…`) as well: one-time access checks are by **product**, because a price may be replaced later while the entitlement must survive.

## Step 2 — Button

Needs: `pri_…`, client token. Produces: a completed sandbox transaction.

`openCheckout(config, { items: [{ priceId, quantity: 1 }], userId, customer: { email } })`. Quantity can be above 1 for packs; the price's `quantity.maximum` bounds it.

For a cart with several one-time items or a server-controlled amount, create the transaction server side (`createCheckoutTransaction` with a `claimKey` such as `order:<orderId>`) and open it with `openTransactionCheckout`. `createCheckoutTransaction` takes catalog price IDs only. For a quote or a negotiated amount (not for standard products), call `client.transactions.createTransaction` directly with an item `{ quantity, price: { description, productId, unitPrice: { amount, currencyCode } } }`, which creates a hidden custom price for an existing product, then open it with `openTransactionCheckout`.

## Step 3 — Fulfil on `transaction.completed`

Needs: webhook handler. Produces: a `paddle_purchases` row.

The handler writes the row only when `event_type === "transaction.completed"` and `subscription_id` is null. `transaction.paid` arrives earlier but is not final (Paddle has not finished processing; it may lack the invoice number). Hook `onPurchaseCompleted(tx, userId)` to deliver the goods (send the download link, mint the licence key, add credits — recipe 03).

Access check: `hasPurchased(store, userId, "pro_…")`.

If the buyer was not signed in, `custom_data.user_id` is missing and `userId` is null: the row is still stored with `paddle_customer_id`; on the next sign-in match by email (`ensureCustomer` links user → customer) and re-run `getUserIdForCustomer`. Prefer requiring sign-in before checkout.

## Step 4 — Receipt and invoice

Paddle emails the receipt and invoice. In the app, `getInvoiceUrl(transactionId)` returns the PDF URL (valid one hour) for `completed` transactions. A zero-value transaction has no invoice.

## Step 5 — Refund (later)

Recipe 05: `refundTransaction(txnId, reason)`. On `adjustment.updated` with `status: "approved"` and `action: "refund"`, revoke the item (delete the purchase row or mark it refunded) in `onAdjustment`.

## Checks

- A second click on the button after a successful purchase would create a second transaction: disable the button when `hasPurchased` is true, and use a claim key for server-created transactions.
- Do not deliver on the success page or on `checkout.completed`; wait for the webhook, as in recipe 01 step 6.
- Quantity-based packs: multiply by `items[0].quantity` from the webhook, not from the button.
