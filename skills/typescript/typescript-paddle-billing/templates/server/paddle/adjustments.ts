/**
 * Refunds, credits and goodwill (Paddle "adjustments", plus a one-cycle discount for card subscriptions).
 *
 * As merchant of record, Paddle issues the refund and the credit note to the
 * customer. Your side: create the adjustment, then wait for adjustment.updated;
 * the webhook handler marks the refunded purchase lines.
 *
 * Rules (Paddle docs):
 * - refund: transaction must be completed. On live, most refunds go to
 *   pending_approval and Paddle reviews them (auto-approved when the account is
 *   verified, the amount is ≤ ~$400 and within balance, and not a bank transfer).
 *   Sandbox approves them automatically after a few minutes.
 * - credit: only for manually-collected (invoice) transactions that are billed or past_due.
 *   Card (automatically-collected) transactions cannot be credited, and the app cannot add to a
 *   customer's credit balance: Paddle fills it only from prorations. Goodwill for a card
 *   subscription is a refund of part of a paid transaction, or grantGoodwillDiscount below.
 * - type full adjusts the grand total; partial needs items with the transaction's
 *   line item ids (txnitm_...) from details.line_items[].id.
 * - A transaction with a pending refund cannot be adjusted again.
 * - Refunding does not cancel a subscription; cancel separately if wanted.
 *
 * Every create goes through claimedWrite (writes.ts): the same refund asked twice is made once.
 */
import { createHash } from "node:crypto";
import type { AdjustmentItemCreate } from "paddle-apimatic-sdk";
import { getPaddleClient } from "./client.js";
import type { PaddleStore } from "./store.js";
import { claimedWrite } from "./writes.js";

export type AdjustmentScope = "full" | { lineItemId: string; amount?: string; full?: boolean }[];

const scopeKey = (scope: AdjustmentScope) =>
  scope === "full" ? "full" : [...scope].map((i) => `${i.lineItemId}=${i.full ? "full" : i.amount ?? ""}`).sort().join(",");

async function adjust(
  store: PaddleStore,
  action: "refund" | "credit",
  transactionId: string,
  reason: string,
  scope: AdjustmentScope,
  userId: string | null,
) {
  const client = getPaddleClient();
  const items: AdjustmentItemCreate[] | undefined =
    scope === "full" ? undefined : scope.map((i) => (i.full ? { itemId: i.lineItemId, type: "full" } : { itemId: i.lineItemId, type: "partial", ...(i.amount ? { amount: i.amount } : {}) }));
  const sameLines = (adjItems: { itemId: string }[]) =>
    scope === "full" ? true : scope.every((i) => adjItems.some((a) => a.itemId === i.lineItemId)) && adjItems.length === scope.length;

  const { value, reused } = await claimedWrite(store, {
    claimKey: `${action}:${transactionId}:${scopeKey(scope)}`,
    kind: action,
    userId,
    operation: `createAdjustment (${action})`,
    // A refund Paddle rejected is used up: asking again makes a new one.
    reuse: async (adjustmentId) => {
      const res = await client.adjustments.listAdjustments({ id: [adjustmentId], perPage: 1 });
      const existing = res.data[0];
      return existing && existing.status !== "rejected" ? existing : undefined;
    },
    find: async (since) => {
      const res = await client.adjustments.listAdjustments({ transactionId: [transactionId], action: [action], perPage: 50 });
      const hit = res.data.find((a) => a.createdAt >= since && a.status !== "rejected" && a.reason === reason && sameLines(a.items));
      return hit ? { id: hit.id, value: hit } : undefined;
    },
    write: async () => {
      const res = await client.adjustments.createAdjustment({
        body: items ? { action, type: "partial", transactionId, reason, items } : { action, type: "full", transactionId, reason },
      });
      return { id: res.data.id, value: res.data };
    },
  });
  return { adjustment: value, reused };
}

/**
 * Refund of a completed transaction: "full", or per line item with amounts in minor units as strings
 * (tax-inclusive by default; Paddle computes the tax part). Line item ids: getTransaction(...).data.details.lineItems[].id.
 * Returns the adjustment; status is usually pending_approval on live. A repeat with the same scope returns the first refund.
 */
export async function refundTransaction(store: PaddleStore, transactionId: string, reason: string, scope: AdjustmentScope = "full", userId: string | null = null) {
  return adjust(store, "refund", transactionId, reason, scope, userId);
}

/** Credit against a billed invoice (manual collection only). Crediting the full value marks the invoice completed. */
export async function creditInvoice(store: PaddleStore, transactionId: string, reason: string, scope: AdjustmentScope = "full") {
  return adjust(store, "credit", transactionId, reason, scope, null);
}

/** Thrown when the subscription already has a discount: Paddle holds one discount per subscription. */
export class SubscriptionHasDiscountError extends Error {
  readonly status = 409;
  constructor(public readonly discountId: string) {
    super("the subscription already has a discount; give the goodwill as a partial refund of its last payment instead");
    this.name = "SubscriptionHasDiscountError";
  }
}

/**
 * Goodwill for a card subscription: a flat amount off the next renewal, as a one-cycle discount
 * applied to the subscription. A subscription holds one discount at a time, so this refuses when
 * one is present (offer a partial refund of the last payment with refundTransaction instead).
 * `ref` names the gesture ("ticket-4711"); a repeat with the same ref grants nothing more.
 * Owner-facing: expose behind admin authorization only.
 */
export async function grantGoodwillDiscount(
  store: PaddleStore,
  input: { subscriptionId: string; amount: string; currencyCode: string; description: string; ref: string },
) {
  const client = getPaddleClient();
  const sub = (await client.subscriptions.getSubscription({ subscriptionId: input.subscriptionId })).data;
  const claimKey = `goodwill:${input.subscriptionId}:${input.ref}`;
  // The code is the reference the discount is found by after an unknown outcome; every caller computes the same one.
  const code = `GW${createHash("sha256").update(claimKey).digest("hex").slice(0, 16).toUpperCase()}`;
  if (sub.discount && sub.discount.id) {
    const existing = (await client.discounts.listDiscounts({ id: [sub.discount.id], perPage: 1 })).data[0];
    if (existing?.code !== code) throw new SubscriptionHasDiscountError(sub.discount.id);
  }

  const { value: discountId, reused } = await claimedWrite(store, {
    claimKey,
    kind: "discount",
    userId: null,
    operation: "createDiscount (goodwill)",
    reuse: async (id) => id,
    find: async () => {
      const res = await client.discounts.listDiscounts({ code: [code], perPage: 1 });
      const hit = res.data[0];
      return hit ? { id: hit.id, value: hit.id } : undefined;
    },
    write: async () => {
      const res = await client.discounts.createDiscount({
        body: {
          description: input.description,
          type: "flat",
          amount: input.amount,
          currencyCode: input.currencyCode as NonNullable<Parameters<typeof client.discounts.createDiscount>[0]["body"]["currencyCode"]>,
          code,
          enabledForCheckout: false, // never usable at checkout; it exists only for this subscription
          recur: false, // applies to one billing period
          customData: { goodwill_ref: claimKey },
        },
      });
      return { id: res.data.id, value: res.data.id };
    },
  });

  if (reused) {
    // Granted before under this ref: apply it only if it was never used (a crash between the two calls).
    const discount = (await client.discounts.listDiscounts({ id: [discountId], perPage: 1 })).data[0];
    if (sub.discount?.id === discountId || (discount?.timesUsed ?? 0) > 0) return { discountId, subscription: sub, alreadyGranted: true };
  }
  // Setting the same discount again leaves the same state, so this update needs no claim.
  const updated = await client.subscriptions.updateSubscription({
    subscriptionId: input.subscriptionId,
    body: { discount: { id: discountId, effectiveFrom: "next_billing_period" } },
  });
  return { discountId, subscription: updated.data, alreadyGranted: false };
}

/** Adjustments for a transaction or subscription (refund history for a billing page). per_page max is 50. */
export async function listAdjustments(filter: { transactionId?: string; subscriptionId?: string; customerId?: string }) {
  const res = await getPaddleClient().adjustments.listAdjustments({
    perPage: 50,
    ...(filter.transactionId ? { transactionId: [filter.transactionId] } : {}),
    ...(filter.subscriptionId ? { subscriptionId: [filter.subscriptionId] } : {}),
    ...(filter.customerId ? { customerId: [filter.customerId] } : {}),
  });
  return res.data;
}

/** Credit note PDF Paddle issued for an approved adjustment. The URL expires after one hour. */
export async function getCreditNoteUrl(adjustmentId: string): Promise<string> {
  const res = await getPaddleClient().adjustments.getAdjustmentCreditNote({ adjustmentId });
  return res.data.url;
}
