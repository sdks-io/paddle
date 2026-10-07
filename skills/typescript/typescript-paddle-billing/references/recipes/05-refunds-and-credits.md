# Recipe 05 — Refunds, credits, chargebacks

Goal: the owner can refund a transaction in full or in part, or credit an invoice; Paddle pays the customer and issues the credit note, and the app removes access or credits when the refund is approved or a chargeback arrives.

Paddle is the merchant of record: it pays the refund, issues the credit note, and handles the chargeback dispute. The app creates the adjustment and reacts to `adjustment.*` webhooks. Functions: `templates/server/paddle/adjustments.ts`.

Ask before refunding on live. Refunds are money leaving the owner's balance.

## Full refund of a payment

Needs: `txn_…` of a `completed` transaction (from `paddle_purchases`, the subscription's transactions, or `paddle-inspect.ts customer <email>`), a reason. Produces: `adj_…` with status `pending_approval` (live) or `approved` (sandbox, within ~10 minutes).

```ts
const { adjustment } = await refundTransaction(store, transactionId, "Customer request within 14 days");
```

A second call for the same transaction and scope returns the first refund instead of refunding again (claim `refund:<txn>:<scope>`); an unknown outcome is looked up before anything is reported.

Then:

- `adjustment.created` arrives with the status above.
- When the refund is approved — `adjustment.updated` with `status: "approved"`, or already `adjustment.created` with `approved` (live refunds that qualify for automatic approval never pass through `pending_approval`) — the handler marks the purchase lines it covers as refunded (`hasPurchased` turns false) and calls `onPurchaseRefunded` (credits: negative ledger entry). For a subscription, decide with the user whether to also cancel — refunding does **not** cancel the subscription.
- `status: "rejected"` → tell the owner; to learn why, they contact Paddle seller support.
- Paddle emails the customer a credit note; `getCreditNoteUrl(adjustmentId)` gives the PDF (one-hour URL) for the app's billing page.

Live auto-approval happens only when the account is verified, the amount is at most about $400, the balance covers it, and the payment was not a bank transfer; everything else waits for Paddle's review.

## Partial refund

Needs: the transaction's line items from `client.transactions.getTransaction` (`data.details.lineItems[]`, each with an `id` `txnitm_…` and `totals`). Produces: `adj_…`.

`refundTransaction` with a list of lines calls `client.adjustments.createAdjustment` with one entry per line item, each `type: "partial"` (with an amount) or `type: "full"` (fields: `map/operations/adjustments.md`). The purchase rows keep each line's `lineItemId`. When approved, a `full` line is marked refunded (its item is revoked); a `partial` amount leaves the line and what it gave in place — handle it in `onAdjustment` if the app pro-rates (for example a partial credit-pack refund).

```ts
await refundTransaction(store, transactionId, "Refund 1 of 3 seats", [{ lineItemId: "txnitm_…", amount: "1900" }]);
// or a whole line: [{ lineItemId: "txnitm_…", full: true }]
```

Amounts are tax-inclusive strings in minor units (`tax_mode: "internal"` default). You cannot refund more than the remaining amount of a line (`adjustment_amount_above_remaining_allowed`), and not while another refund is pending (`adjustment_pending_refund_request`).

## Refund after an immediate cancel

Recipe 04 immediate cancel issues no refund. If the policy is "pro-rata refund on cancel": refund the last renewal transaction, fully or partially; the partial amount is the owner's decision, since Paddle documents no automatic pro-rata refund.

## Credits (invoices only)

`creditInvoice(store, transactionId, reason)` applies to manually-collected (`collection_mode: "manual"`) transactions that are `billed` or `past_due`. Paddle takes a credit only as line items, so the default `"full"` credits every line in full; pass lines to credit part of the invoice. Sandbox approves a credit at once. After a full credit the invoice's `details.totals.balance` is 0 and the customer owes nothing; in testing the status stayed `billed`, so read the balance, not the status. Not for card payments.

## Goodwill credit for a card subscription

Paddle offers no credit for automatically-collected (card) transactions, and the app cannot add to a customer's credit balance: Paddle fills it only from prorations ("You can't add to a credit balance yourself"). Two documented ways remain; offer them to the owner:

- **Money back now:** a partial refund of the subscription's last completed transaction (`refundTransaction` with a line and an amount). The customer gets a credit note.
- **Less to pay next time:** `grantGoodwillDiscount(store, { subscriptionId, amount: "500", currencyCode: "USD", description: "Sorry for the outage", ref: "ticket-4711" })` creates a flat discount (not usable at checkout, recurring for one billing period: Paddle refuses a one-off discount on a subscription with `subscription_one_off_discount_not_valid`) and applies it from the next billing period. A subscription holds one discount at a time, so it refuses (`SubscriptionHasDiscountError`) when one is already applied: replacing it would end the customer's existing promotion. Use the refund then. The same `ref` grants once.

Both are owner actions: expose them behind admin authorization only.

## Chargebacks

Paddle creates `adjustment.created` with `action: "chargeback"` (and later `chargeback_reverse` if won). The handler treats a chargeback like an approved refund (the lines are marked, `onPurchaseRefunded` runs); a reversed chargeback is left to the owner (`onAdjustment`). Do not create adjustments with these actions yourself. Chargeback fees appear in `payout_totals`.

## Showing refund history

`listAdjustments({ customerId })` or `{ transactionId }` (per page max 50). Fields: `action`, `status`, `totals.total`, `currencyCode`, `createdAt`.

## Checks

- Only `completed` transactions can be refunded (`adjustment_transaction_invalid_status_for_refund`).
- Refund approval can take time on live; show "refund requested" until `approved`.
- Idempotency: Paddle refuses a second refund only while the first is pending (`adjustment_pending_refund_request`); after approval another call refunds again if any amount remains. `refundTransaction` claims each refund (transaction and scope; a rejected one can be asked again), and the purchase lines carry `refundedAt`; check it before offering a refund.

## Done when

The adjustment exists in Paddle, `adjustment.updated` with `approved` (sandbox: within about 10 minutes) has been handled, and access or credits were revoked accordingly.
