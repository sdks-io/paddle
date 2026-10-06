// Run: npx tsx tests/paddle/webhook-handler.test.mts   (no network; uses the in-memory store)
// Port these cases to the project's test runner (typescript-testing) and run them against the real
// PaddleStore implementation too.
// Covers: verification, dedupe on event_id, redelivery after a failed process, out-of-order events,
// user mapping from custom_data, access by status and catalog tier, scheduled cancel, customer links
// that never move, one-time purchases per line, partial refunds and credits, other apps' events,
// undecodable bodies, the reprocess job.
// Fixtures: sandbox-*.json are real sandbox deliveries (Paddle leaves some keys out of real events);
// transaction-completed.json and subscription-updated.json are Paddle's published examples.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PaddleWebhookHandler, type WebhookHooks } from "../../server/paddle/webhooks/handler.js";
import { reprocessPendingEvents } from "../../server/paddle/webhooks/reprocess.js";
import { MemoryPaddleStore } from "../../server/paddle/store.memory.js";
import { signForTests } from "../../server/paddle/webhooks/verify.js";
import { getEntitlement, hasPurchased } from "../../server/paddle/entitlements.js";
import type { PaddleConfig } from "../../server/paddle/config.js";

type Json = Record<string, any>;
const fixture = (name: string): Json => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const secret = "pdl_ntfset_01_secret";
const config: PaddleConfig = {
  environment: "sandbox",
  apiKey: "pdl_sdbx_apikey_x",
  apiBaseUrl: "https://sandbox-api.paddle.com",
  apiUrlOverride: undefined,
  webhookSecret: secret,
  webhookToleranceSeconds: 5,
};
const store = new MemoryPaddleStore();
store.plans.set("pri_pro_m", { priceId: "pri_pro_m", productId: "pro_pro", tierKey: "pro", displayOrder: 1, features: { seats: 5 }, active: true });
store.plans.set("pri_credits", { priceId: "pri_credits", productId: "pro_credits", tierKey: "credits-100", displayOrder: 2, features: { credits: 100 }, active: true });
store.plans.set("pri_lifetime", { priceId: "pri_lifetime", productId: "pro_lifetime", tierKey: "lifetime", displayOrder: 3, features: {}, active: true });

const attention: { eventId: string; state: string }[] = [];
const hooks: WebhookHooks = {
  // Credit packs: credits × quantity per line; the ledger ref is the line, so a redelivery adds nothing.
  async onPurchaseCompleted(purchase) {
    for (const item of purchase.items) {
      const credits = Number((await store.getPlanByPriceId(item.priceId))?.features["credits"] ?? 0);
      if (purchase.userId && credits > 0) {
        await store.addCredits({ userId: purchase.userId, delta: credits * item.quantity, reason: "purchase", transactionId: purchase.transactionId, ref: item.lineItemId ?? item.priceId });
      }
    }
  },
  async onPurchaseRefunded(purchase, refundedItems, adjustment) {
    for (const item of refundedItems) {
      const credits = Number((await store.getPlanByPriceId(item.priceId))?.features["credits"] ?? 0);
      if (purchase.userId && credits > 0) {
        await store.addCredits({ userId: purchase.userId, delta: -credits * item.quantity, reason: "refund", transactionId: purchase.transactionId, ref: `${adjustment.id}:${item.lineItemId}` });
      }
    }
  },
  async onEventNeedsAttention(info) {
    attention.push({ eventId: info.eventId, state: info.state });
  },
};
// Paddle lookups the handler makes (a refund that arrives before its purchase) are stubbed: no network.
const paddleTransactions = new Map<string, { origin: string; items: { priceId: string; productId: string; recurring: boolean }[] }>();
const options = { lookupTransaction: async (id: string) => paddleTransactions.get(id) };
const handler = new PaddleWebhookHandler(config, store, hooks, undefined, options);

let counter = 0;
/** subscription.updated for sub_1 / ctm_1 / user_42 with one seat-based item on pri_pro_m, from a real sandbox delivery. */
function subscriptionEvent(status: string, occurredAt: string, data: Json = {}, userId = "user_42", priceId = "pri_pro_m") {
  counter += 1;
  const e = fixture("sandbox-subscription-created");
  e.event_id = `evt_sub_${counter}`;
  e.event_type = "subscription.updated";
  e.occurred_at = occurredAt;
  const item = e.data.items[0];
  item.quantity = 3;
  item.price.id = priceId;
  item.price.product_id = "pro_pro";
  Object.assign(e.data, {
    id: "sub_1",
    status,
    customer_id: "ctm_1",
    items: [item],
    current_billing_period: { starts_at: "2026-10-01T00:00:00Z", ends_at: "2026-11-01T00:00:00Z" },
    next_billed_at: "2026-11-01T00:00:00Z",
    scheduled_change: null,
    custom_data: { user_id: userId },
    ...data,
  });
  return e;
}

/** A real one-time checkout with two lines, mapped to pri_credits (quantity 2) and pri_lifetime. */
function oneTimeEvent(eventType: string, opts: { id: string; userId?: string; prices?: [string, string] }) {
  counter += 1;
  const e = fixture("sandbox-transaction-completed");
  e.event_id = `evt_txn_${counter}`;
  e.event_type = eventType;
  const [first, second] = opts.prices ?? ["pri_credits", "pri_lifetime"];
  const products: Record<string, string> = { pri_credits: "pro_credits", pri_lifetime: "pro_lifetime" };
  e.data.items.forEach((item: Json, i: number) => {
    item.price.id = i === 0 ? first : second;
    item.price.product_id = products[item.price.id] ?? "pro_other";
  });
  e.data.items[0].quantity = 2;
  e.data.details.line_items.forEach((line: Json, i: number) => {
    line.id = `txnitm_${opts.id}_${i}`;
    line.price_id = i === 0 ? first : second;
  });
  Object.assign(e.data, { id: opts.id, customer_id: "ctm_1", subscription_id: null, origin: "web", custom_data: { user_id: opts.userId ?? "user_42" } });
  return e;
}

/** Paddle's published example: a subscription checkout that also bought a one-time item. */
function mixedEvent(opts: { subscriptionId: string; origin: string; userId: string }) {
  counter += 1;
  const e = fixture("transaction-completed");
  e.event_id = `evt_mixed_${counter}`;
  for (const item of e.data.items as Json[]) {
    if (item.price.billing_cycle === null) {
      item.price.id = "pri_credits";
      item.price.product_id = "pro_credits";
    } else {
      item.price.id = "pri_pro_m";
    }
  }
  Object.assign(e.data, { id: `txn_mixed_${counter}`, customer_id: "ctm_9", subscription_id: opts.subscriptionId, origin: opts.origin, custom_data: { user_id: opts.userId } });
  return e;
}

function adjustmentEvent(opts: { transactionId: string; status: string; action?: string; lineItemIds: string[] | "full"; itemType?: string }) {
  counter += 1;
  const at = "2026-10-05T10:00:00Z";
  const full = opts.lineItemIds === "full";
  return {
    event_id: `evt_adj_${counter}`,
    event_type: "adjustment.updated",
    occurred_at: at,
    notification_id: `ntf_adj_${counter}`,
    data: {
      id: `adj_${counter}`,
      action: opts.action ?? "refund",
      type: full ? "full" : "partial",
      transaction_id: opts.transactionId,
      subscription_id: null,
      customer_id: "ctm_1",
      reason: "test",
      currency_code: "USD",
      status: opts.status,
      items: full ? [] : (opts.lineItemIds as string[]).map((id, i) => ({ id: `adjitm_${counter}_${i}`, item_id: id, type: opts.itemType ?? "full", amount: "1000", totals: { subtotal: "1000", tax: "0", total: "1000" } })),
      totals: { subtotal: "1000", tax: "0", total: "1000", fee: "0", earnings: "0", currency_code: "USD" },
      created_at: at,
      updated_at: at,
    },
  };
}

async function deliver(event: object, h: PaddleWebhookHandler = handler) {
  const body = JSON.stringify(event);
  const result = await h.receive(body, signForTests(body, secret));
  assert.equal(result.status, 200);
  if (result.status === 200 && !result.duplicate && !result.parked) await h.process(result.payload);
  return result;
}

// 1. subscription.updated (a real sandbox payload) grants access and maps the user from custom_data.user_id
await deliver(subscriptionEvent("active", "2026-10-04T10:00:00Z"));
let ent = await getEntitlement(store, "user_42");
assert.equal(ent.hasAccess, true);
assert.equal(ent.tier, "pro");
assert.equal(ent.quantity, 3);
assert.equal(await store.getCustomerIdForUser("user_42"), "ctm_1");

// 2. an older event delivered later is ignored
await deliver(subscriptionEvent("paused", "2026-10-04T09:00:00Z"));
assert.equal((await store.getSubscription("sub_1"))!.status, "active");

// 3. the same event_id is processed once
const cancelEvent = subscriptionEvent("canceled", "2026-10-04T11:00:00Z");
const first = await deliver(cancelEvent);
const second = await deliver(cancelEvent);
assert.equal(first.status === 200 && first.duplicate, false);
assert.equal(second.status === 200 && second.duplicate, true);
ent = await getEntitlement(store, "user_42");
assert.equal(ent.hasAccess, false);

// 4. a scheduled cancel keeps access until effective_at
await deliver(
  subscriptionEvent("active", "2026-10-04T12:00:00Z", {
    scheduled_change: { action: "cancel", effective_at: "2026-11-01T00:00:00Z", resume_at: null },
    next_billed_at: null,
  }),
);
ent = await getEntitlement(store, "user_42");
assert.equal(ent.hasAccess, true);
assert.equal(ent.endsAt?.toISOString(), "2026-11-01T00:00:00.000Z");

// 5. past_due keeps access and flags the payment problem
await deliver(subscriptionEvent("past_due", "2026-10-04T13:00:00Z"));
ent = await getEntitlement(store, "user_42");
assert.equal(ent.hasAccess, true);
assert.equal(ent.paymentPastDue, true);

// 6. one-time purchases: paid does nothing; completed records each line with its quantity; credits per line
await deliver(oneTimeEvent("transaction.paid", { id: "txn_a" }));
assert.equal(await hasPurchased(store, "user_42", "pro_credits"), false);
const completed = oneTimeEvent("transaction.completed", { id: "txn_a" });
await deliver(completed);
const purchase = await store.getPurchase("txn_a");
assert.deepEqual(purchase?.items.map((i) => [i.priceId, i.quantity, i.lineItemId]), [["pri_credits", 2, "txnitm_txn_a_0"], ["pri_lifetime", 1, "txnitm_txn_a_1"]]);
assert.equal(await hasPurchased(store, "user_42", "pro_credits"), true);
assert.equal(await hasPurchased(store, "user_42", "pro_lifetime"), true);
assert.equal(await store.getCreditBalance("user_42"), 200);
// a renewal transaction of a subscription is not a purchase
const renewal = mixedEvent({ subscriptionId: "sub_1", origin: "subscription_recurring", userId: "user_42" });
await deliver(renewal);
assert.equal(await store.getPurchase(renewal.data.id), undefined);

// 7. a subscription checkout that also bought a one-time item records only that item
const mixed = mixedEvent({ subscriptionId: "sub_2", origin: "web", userId: "user_43" });
await deliver(mixed);
assert.deepEqual((await store.getPurchase(mixed.data.id))?.items.map((i) => i.priceId), ["pri_credits"]);
assert.equal(await hasPurchased(store, "user_43", "pro_credits"), true);

// 8. a failed process is not lost: the redelivery is processed, the delivery after that is a duplicate
let failOnce = true;
const flaky = new PaddleWebhookHandler(config, store, {
  async onSubscriptionChanged() {
    if (failOnce) {
      failOnce = false;
      throw new Error("database unavailable");
    }
  },
}, undefined, options);
const retried = subscriptionEvent("active", "2026-10-04T14:00:00Z", { id: "sub_3" });
await assert.rejects(deliver(retried, flaky), /database unavailable/);
const failedRow = store.events.get(retried.event_id)!;
assert.equal(failedRow.processedAt, undefined);
assert.equal(failedRow.attempts, 1);
assert.equal(failedRow.error, "database unavailable");
const redelivery = await deliver(retried, flaky);
assert.equal(redelivery.status === 200 && redelivery.duplicate, false);
assert.ok(store.events.get(retried.event_id)!.processedAt);
const third = await deliver(retried, flaky);
assert.equal(third.status === 200 && third.duplicate, true);

// 9. a Paddle customer already linked to one user is never moved to another
await deliver(subscriptionEvent("active", "2026-10-04T15:00:00Z", { id: "sub_4" }, "user_99"));
assert.equal(await store.getUserIdForCustomer("ctm_1"), "user_42");
assert.equal(await store.getCustomerIdForUser("user_99"), undefined);

// 10. a body that does not match the SDK model is parked, answered 200, reported, and not applied
const broken = subscriptionEvent("active", "2026-10-04T16:00:00Z", { id: "sub_5" });
delete broken.data.items;
const brokenResult = await deliver(broken);
assert.equal(brokenResult.status, 200);
assert.equal(store.events.get(broken.event_id)!.finalState, "undecodable");
assert.equal(await store.getSubscription("sub_5"), undefined);
assert.deepEqual(attention.at(-1), { eventId: broken.event_id, state: "undecodable" });
// an envelope that cannot be read is parked at receive time
const noEnvelope = subscriptionEvent("active", "2026-10-04T16:30:00Z", { id: "sub_6" });
delete noEnvelope.notification_id;
noEnvelope.occurred_at = "not a date";
const parked = await deliver(noEnvelope);
assert.equal(parked.status === 200 && parked.parked, true);
assert.equal(store.events.get(noEnvelope.event_id)!.finalState, "undecodable");

// 11. a bad signature is refused before anything is recorded
const unsigned = subscriptionEvent("active", "2026-10-04T17:00:00Z");
const bad = await handler.receive(JSON.stringify(unsigned), "ts=1;h1=00");
assert.equal(bad.status, 401);
assert.equal(store.events.has(unsigned.event_id), false);

// 12. another app's events on the same Paddle account are recorded and ignored
const foreignSub = subscriptionEvent("active", "2026-10-04T18:00:00Z", { id: "sub_other" }, "user_42", "pri_other");
foreignSub.data.items[0].price.product_id = "pro_other";
await deliver(foreignSub);
assert.equal(await store.getSubscription("sub_other"), undefined);
assert.ok(store.events.get(foreignSub.event_id)!.processedAt);
assert.match(store.events.get(foreignSub.event_id)!.error ?? "", /not in plan_catalog/);
const foreignTxn = oneTimeEvent("transaction.completed", { id: "txn_other", prices: ["pri_other_a", "pri_other_b"] });
await deliver(foreignTxn);
assert.equal(await store.getPurchase("txn_other"), undefined);

// 13. access needs a catalog tier: a mirrored subscription on a price the app does not sell grants nothing
await store.upsertSubscription({ ...(await store.getSubscription("sub_1"))!, id: "sub_unlisted", userId: "user_77", priceIds: ["pri_unlisted"], status: "active" });
assert.equal((await getEntitlement(store, "user_77")).hasAccess, false);

// 14. an approved refund of a whole line revokes only that line; credits come back once; redelivery changes nothing
await deliver(adjustmentEvent({ transactionId: "txn_a", status: "pending_approval", lineItemIds: ["txnitm_txn_a_0"] }));
assert.equal(await hasPurchased(store, "user_42", "pro_credits"), true);
// a refund of part of a line's amount leaves the line and its credits in place
await deliver(adjustmentEvent({ transactionId: "txn_a", status: "approved", lineItemIds: ["txnitm_txn_a_0"], itemType: "partial" }));
assert.equal(await hasPurchased(store, "user_42", "pro_credits"), true);
assert.equal(await store.getCreditBalance("user_42"), 200);
const approved = adjustmentEvent({ transactionId: "txn_a", status: "approved", lineItemIds: ["txnitm_txn_a_0"] });
await deliver(approved);
assert.equal(await hasPurchased(store, "user_42", "pro_credits"), false);
assert.equal(await hasPurchased(store, "user_42", "pro_lifetime"), true);
assert.equal(await store.getCreditBalance("user_42"), 0);
await deliver({ ...approved, event_id: `${approved.event_id}_again` });
assert.equal(await store.getCreditBalance("user_42"), 0);
// a redelivered transaction.completed keeps the refund mark and adds no credits
await deliver({ ...completed, event_id: `${completed.event_id}_again` });
assert.equal(await hasPurchased(store, "user_42", "pro_credits"), false);
assert.equal(await store.getCreditBalance("user_42"), 0);
// a chargeback on the whole transaction revokes the rest
await deliver(adjustmentEvent({ transactionId: "txn_a", status: "approved", action: "chargeback", lineItemIds: "full" }));
assert.equal(await hasPurchased(store, "user_42", "pro_lifetime"), false);
// an adjustment for a transaction this app does not know is ignored
const foreignAdj = adjustmentEvent({ transactionId: "txn_unknown", status: "approved", lineItemIds: "full" });
await deliver(foreignAdj);
assert.match(store.events.get(foreignAdj.event_id)!.error ?? "", /not known/);
// a refund that arrives before its purchase is recorded is retried, not dropped
paddleTransactions.set("txn_late", { origin: "web", items: [{ priceId: "pri_lifetime", productId: "pro_lifetime", recurring: false }] });
const early = adjustmentEvent({ transactionId: "txn_late", status: "approved", lineItemIds: "full" });
await assert.rejects(deliver(early), /not recorded yet/);
assert.equal(store.events.get(early.event_id)!.processedAt, undefined);
await deliver(oneTimeEvent("transaction.completed", { id: "txn_late" }));
assert.equal(await hasPurchased(store, "user_42", "pro_lifetime"), true);
await deliver(early); // Paddle's retry, now that the purchase exists
assert.deepEqual((await store.getPurchase("txn_late"))?.items.map((i) => i.refundedAt !== null), [true, true]);
// a refund of a renewal (no purchase will ever be recorded) is not retried
paddleTransactions.set("txn_renewal", { origin: "subscription_recurring", items: [{ priceId: "pri_pro_m", productId: "pro_pro", recurring: true }] });
const renewalRefund = adjustmentEvent({ transactionId: "txn_renewal", status: "approved", lineItemIds: "full" });
await deliver(renewalRefund);
assert.ok(store.events.get(renewalRefund.event_id)!.processedAt);
// a custom price (a quote) for a catalog product is this app's purchase
const quote = oneTimeEvent("transaction.completed", { id: "txn_quote", prices: ["pri_hidden_quote", "pri_other_x"] });
quote.data.items[0].price.product_id = "pro_lifetime";
await deliver(quote);
assert.deepEqual((await store.getPurchase("txn_quote"))?.items.map((i) => i.productId), ["pro_lifetime"]);

// 15. the reprocess job retries failed events, parks them after maxAttempts, and runs them again once reopened
let broken15 = true;
const jobHandler = new PaddleWebhookHandler(config, store, {
  ...hooks,
  async onSubscriptionChanged() {
    if (broken15) throw new Error("hook bug");
  },
}, undefined, options);
const stuck = subscriptionEvent("active", "2026-10-04T19:00:00Z", { id: "sub_7" });
await assert.rejects(deliver(stuck, jobHandler));
let report = await reprocessPendingEvents(jobHandler, store, { maxAttempts: 3, leaseMs: 0 });
assert.equal(report.failed, 1);
report = await reprocessPendingEvents(jobHandler, store, { maxAttempts: 3, leaseMs: 0 });
assert.equal(report.gaveUp, 1);
assert.equal(store.events.get(stuck.event_id)!.finalState, "gave_up");
assert.deepEqual(attention.at(-1), { eventId: stuck.event_id, state: "gave_up" });
report = await reprocessPendingEvents(jobHandler, store, { maxAttempts: 3, leaseMs: 0 });
assert.equal(report.failed + report.applied, 0); // parked: not retried
broken15 = false;
assert.equal(await store.reopenEvents("gave_up"), 1);
report = await reprocessPendingEvents(jobHandler, store, { maxAttempts: 3, leaseMs: 0 });
assert.equal(report.applied, 1);
assert.ok(store.events.get(stuck.event_id)!.processedAt);

// 16. rows stored before the user was known are given to the user once the customer is linked
const anonymous = oneTimeEvent("transaction.completed", { id: "txn_anon" });
anonymous.data.customer_id = "ctm_anon";
anonymous.data.custom_data = null;
await deliver(anonymous);
assert.equal((await store.getPurchase("txn_anon"))?.userId, null);
await store.linkCustomer("user_55", "ctm_anon", "buyer@example.test");
assert.equal(await store.assignUserToCustomerRows("user_55", "ctm_anon"), 1);
assert.equal(await hasPurchased(store, "user_55", "pro_lifetime"), true);

console.log("webhook-handler OK");
