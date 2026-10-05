# Recipe 05 — Refunds, credits, chargebacks

Goal: the owner can refund a transaction in full or in part, or credit an invoice; Paddle pays the customer and issues the credit note, and the app removes access or credits when the refund is approved or a chargeback arrives.

Paddle is the merchant of record: it pays the refund, issues the credit note, and handles the chargeback dispute. The app creates the adjustment and reacts to `adjustment.*` webhooks. Functions: `templates/server/paddle/adjustments.ts`.

Ask before refunding on live. Refunds are money leaving the owner's balance.

## Full refund of a payment

Needs: `txn_…` of a `completed` transaction (from `paddle_purchases`, the subscription's transactions, or `paddle-inspect.ts customer <email>`), a reason. Produces: `adj_…` with status `pending_approval` (live) or `approved` (sandbox, within ~10 minutes).

```ts
const adj = await refundTransaction(transactionId, "Customer request within 14 days");
```

Then:

- `adjustment.created` arrives with the status above.
- `adjustment.updated` with `status: "approved"` → revoke what was bought (one-time: remove the purchase row or mark refunded; credits: negative ledger entry; subscription: decide with the user whether to also cancel — refunding does **not** cancel the subscription).
- `status: "rejected"` → tell the owner; to learn why, they contact Paddle seller support.
- Paddle emails the customer a credit note; `getCreditNoteUrl(adjustmentId)` gives the PDF (one-hour URL) for the app's billing page.

Live auto-approval happens only when the account is verified, the amount is at most about $400, the balance covers it, and the payment was not a bank transfer; everything else waits for Paddle's review.

## Partial refund

Needs: the transaction's line items: `client.transactions.getTransaction({ transactionId })` → `data.details.lineItems[]` with `id` (`txnitm_…`) and `totals`. Produces: `adj_…`.

```ts
await refundLineItems(transactionId, "Refund 1 of 3 seats", [{ lineItemId: "txnitm_…", amount: "1900" }]);
// or a whole line: [{ lineItemId: "txnitm_…", full: true }]
```

Amounts are tax-inclusive strings in minor units (`tax_mode: "internal"` default). You cannot refund more than the remaining amount of a line (`adjustment_amount_above_remaining_allowed`), and not while another refund is pending (`adjustment_pending_refund_request`).

## Refund after an immediate cancel

Recipe 04 immediate cancel issues no refund. If the policy is "pro-rata refund on cancel": refund the last renewal transaction, fully or partially; the partial amount is the owner's decision, since Paddle documents no automatic pro-rata refund.

## Credits (invoices only)

`creditInvoice(transactionId, reason)` applies to manually-collected (`collection_mode: "manual"`) transactions that are `billed` or `past_due`; crediting the full value marks the invoice `completed`. Not for card payments.

## Chargebacks

Paddle creates `adjustment.created` with `action: "chargeback"` (and later `chargeback_reverse` if won). Treat a chargeback like an approved refund for access; do not create adjustments with these actions yourself. Chargeback fees appear in `payout_totals`.

## Showing refund history

`listAdjustments({ customerId })` or `{ transactionId }` (per page max 50). Fields: `action`, `status`, `totals.total`, `currencyCode`, `createdAt`.

## Done when

The adjustment exists in Paddle, `adjustment.updated` with `approved` (sandbox: within about 10 minutes) has been handled, and access or credits were revoked accordingly.

## Checks

- Only `completed` transactions can be refunded (`adjustment_transaction_invalid_status_for_refund`).
- Refund approval can take time on live; show "refund requested" until `approved`.
- Idempotency: creating the same refund twice fails with `adjustment_pending_refund_request` while the first is pending, but an approved refund followed by another call refunds again if any amount remains — guard with your own "refunded" flag.
