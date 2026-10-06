# Recipe 02 — One-time purchase (lifetime licence, download, add-on, credit pack)

Goal: a customer pays once; the app unlocks the item after Paddle confirms the payment. No subscription is created.

Prerequisites: recipe 01 prerequisites, steps 3–5 (store, webhook, entitlement route) and step 6.1 (default payment link). The webhook handler already fulfils one-time purchases; this recipe adds the catalog entry, the button and the access check.

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

For a cart with several one-time items or a server-controlled amount, create the transaction server side (`createCheckoutTransaction` with `claimKey: "order:" + orderId` when the app has orders, otherwise `checkoutClaimKey(userId, items)`) and open it with `openTransactionCheckout`. For a quote or a negotiated amount (not for standard products), pass `createCheckoutTransaction` an item `{ customPrice: { description, productId, amount, currencyCode }, quantity }` with `claimKey: "quote:" + quoteId`; Paddle creates a hidden custom price for that existing product (fields: `map/operations/transactions.md`). The product must have a `plan_catalog` row: the handler accepts custom prices of catalog products as this app's. Then open it with `openTransactionCheckout`.

## Step 3 — Fulfil on `transaction.completed`

Needs: webhook handler. Produces: a `paddle_purchases` row.

The handler writes the purchase only on `transaction.completed`, one line per one-time catalog item with its quantity and Paddle line item id: every item when the transaction has no subscription, and the one-time items (no billing cycle) when they were bought at checkout together with a subscription. Prices not in `plan_catalog` are not recorded, so add a `plan_catalog` row for each one-time price (tier key = what it unlocks). `transaction.paid` arrives earlier but is not final (Paddle has not finished processing; it may lack the invoice number). Hook `onPurchaseCompleted(purchase, tx)` (`purchase.items` holds only the one-time lines) to deliver the goods (send the download link, mint the licence key, add credits — recipe 03).

Access check: `hasPurchased(store, userId, "pro_…")`.

If the buyer was not signed in, `custom_data.user_id` is missing and `userId` is null: the row is still stored with `paddle_customer_id`. When that user signs in and `ensureCustomer` links them to the customer (verified email), it calls `store.assignUserToCustomerRows`, which gives them those rows. Prefer requiring sign-in before checkout.

## Step 4 — Receipt and invoice

Paddle emails the receipt and invoice. In the app, `getInvoiceUrl(transactionId)` returns the PDF URL (valid one hour) for `completed` transactions. A zero-value transaction has no invoice.

## Step 5 — Refund (later)

Recipe 05: `refundTransaction(store, txnId, reason)` (whole transaction) or with line items. When the refund is approved (on `adjustment.created` or `adjustment.updated`), the handler marks the whole lines it refunds (items of type `full`, or every line for a full refund) as refunded, so `hasPurchased` turns false for them; revoke anything else they gave in `onPurchaseRefunded`. A partial amount leaves the line in place.

## Checks

- A second click on the button after a successful purchase would create a second transaction: disable the button when `hasPurchased` is true; server-created transactions are claimed (`checkoutClaimKey`), so a double submit creates one.
- Do not deliver on the success page or on `checkout.completed`; wait for the webhook, as in recipe 01 step 6.
- Quantity-based packs: multiply by each line's `quantity` in `purchase.items` (from the webhook), not from the button. Give pack prices a `quantity` range in the seed file; the default 1–1 hides the picker.

## Done when

A sandbox purchase completes, `transaction.completed` writes the `paddle_purchases` row, and `hasPurchased` returns true for the buyer.
