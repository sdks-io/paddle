/**
 * Refunds and credits (Paddle "adjustments").
 *
 * As merchant of record, Paddle issues the refund and the credit note to the
 * customer. Your side: create the adjustment, then wait for adjustment.updated.
 *
 * Rules (Paddle docs):
 * - refund: transaction must be completed. On live, most refunds go to
 *   pending_approval and Paddle reviews them (auto-approved when the account is
 *   verified, the amount is ≤ ~$400 and within balance, and not a bank transfer).
 *   Sandbox auto-approves every 10 minutes.
 * - credit: only for manually-collected (invoice) transactions that are billed or past_due.
 * - type full adjusts the grand total; partial needs items with the transaction's
 *   line item ids (txnitm_...) from details.line_items[].id.
 * - A transaction with a pending refund cannot be adjusted again.
 * - Refunding does not cancel a subscription; cancel separately if wanted.
 */
import type { AdjustmentItemCreate } from "paddle-apimatic-sdk";
import { getPaddleClient } from "./client.js";

/** Full refund of a completed transaction. Returns the adjustment; status is usually pending_approval on live. */
export async function refundTransaction(transactionId: string, reason: string) {
  const res = await getPaddleClient().adjustments.createAdjustment({
    body: { action: "refund", type: "full", transactionId, reason },
  });
  return res.data;
}

/**
 * Partial refund: amounts per line item, in minor units as strings.
 * Get line item ids from getTransaction(...).data.details.lineItems[].id (txnitm_...).
 * Amounts are tax-inclusive by default (tax_mode internal); Paddle computes the tax part.
 */
export async function refundLineItems(
  transactionId: string,
  reason: string,
  items: { lineItemId: string; amount?: string; full?: boolean }[],
) {
  const adjustmentItems: AdjustmentItemCreate[] = items.map((i) =>
    i.full ? { itemId: i.lineItemId, type: "full" } : { itemId: i.lineItemId, type: "partial", amount: i.amount },
  );
  const res = await getPaddleClient().adjustments.createAdjustment({
    body: { action: "refund", type: "partial", transactionId, reason, items: adjustmentItems },
  });
  return res.data;
}

/** Credit against a billed invoice (manual collection). Crediting the full value marks the invoice completed. */
export async function creditInvoice(transactionId: string, reason: string, items?: AdjustmentItemCreate[]) {
  const res = await getPaddleClient().adjustments.createAdjustment({
    body: items ? { action: "credit", type: "partial", transactionId, reason, items } : { action: "credit", type: "full", transactionId, reason },
  });
  return res.data;
}

/** Adjustments for a transaction or subscription (refund history for a billing page). per_page max is 50. */
export async function listAdjustments(filter: { transactionId?: string; subscriptionId?: string; customerId?: string }) {
  const res = await getPaddleClient().adjustments.listAdjustments({
    transactionId: filter.transactionId ? [filter.transactionId] : undefined,
    subscriptionId: filter.subscriptionId ? [filter.subscriptionId] : undefined,
    customerId: filter.customerId ? [filter.customerId] : undefined,
    perPage: 50,
  });
  return res.data;
}

/** Credit note PDF Paddle issued for an approved adjustment. The URL expires after one hour. */
export async function getCreditNoteUrl(adjustmentId: string, disposition: "inline" | "attachment" = "inline"): Promise<string> {
  const res = await getPaddleClient().adjustments.getAdjustmentCreditNote({ adjustmentId, disposition });
  return res.data.url;
}
