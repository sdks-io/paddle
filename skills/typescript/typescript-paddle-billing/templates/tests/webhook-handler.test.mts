// Run: npx tsx tests/paddle/webhook-handler.test.mts   (no network; uses the in-memory store)
// Covers: verification, dedupe on event_id, redelivery after a failed process, out-of-order events,
// user mapping from custom_data, access by status, scheduled cancel, customer links that never move,
// one-time purchase fulfilment on transaction.completed only, one-time items bought with a subscription.
// Fixtures are Paddle's published example payloads (developer.paddle.com/webhooks), decoded by the SDK models.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PaddleWebhookHandler, type WebhookHooks } from "../../server/paddle/webhooks/handler.js";
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
  webhookSecret: secret,
  webhookToleranceSeconds: 5,
};
const store = new MemoryPaddleStore();
store.plans.set("pri_pro_m", { priceId: "pri_pro_m", productId: "pro_pro", tierKey: "pro", displayOrder: 1, features: { seats: 5 }, active: true });
const purchased: { userId: string | null; priceIds: string[] }[] = [];
const hooks: WebhookHooks = {
  async onPurchaseCompleted(_tx, userId, items) {
    purchased.push({ userId, priceIds: items.map((i) => i.price.id) });
  },
};
const handler = new PaddleWebhookHandler(config, store, hooks);

let counter = 0;
/** subscription.updated for sub_1 / ctm_1 / user_42 with one seat-based item on pri_pro_m. */
function subscriptionEvent(status: string, occurredAt: string, data: Json = {}, userId = "user_42") {
  counter += 1;
  const e = fixture("subscription-updated");
  e.event_id = `evt_sub_${counter}`;
  e.occurred_at = occurredAt;
  const item = e.data.items[0];
  item.quantity = 3;
  item.price.id = "pri_pro_m";
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

/** transaction.* for ctm_1 / user_42. `oneTimeOnly` keeps just the fixture's one-time item. */
function transactionEvent(eventType: string, opts: { subscriptionId: string | null; origin: string; oneTimeOnly: boolean; userId?: string }) {
  counter += 1;
  const e = fixture("transaction-completed");
  e.event_id = `evt_txn_${counter}`;
  e.event_type = eventType;
  const items = e.data.items as Json[];
  const oneTime = items.find((i) => i.price.billing_cycle === null)!;
  oneTime.price.id = "pri_credits";
  oneTime.price.product_id = "pro_credits";
  Object.assign(e.data, {
    id: `txn_${counter}`,
    customer_id: "ctm_1",
    subscription_id: opts.subscriptionId,
    origin: opts.origin,
    items: opts.oneTimeOnly ? [oneTime] : items,
    custom_data: { user_id: opts.userId ?? "user_42" },
  });
  return e;
}

async function deliver(event: object, h: PaddleWebhookHandler = handler) {
  const body = JSON.stringify(event);
  const result = await h.receive(body, signForTests(body, secret));
  assert.equal(result.status, 200);
  if (result.status === 200 && !result.duplicate) await h.process(result.payload);
  return result;
}

// 1. subscription.updated grants access and maps the user from custom_data.user_id
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

// 6. one-time purchases: paid does nothing, a renewal does nothing, completed fulfils
await deliver(transactionEvent("transaction.paid", { subscriptionId: null, origin: "web", oneTimeOnly: true }));
assert.equal(await hasPurchased(store, "user_42", "pro_credits"), false);
await deliver(transactionEvent("transaction.completed", { subscriptionId: "sub_1", origin: "subscription_recurring", oneTimeOnly: false }));
assert.equal(await hasPurchased(store, "user_42", "pro_credits"), false);
await deliver(transactionEvent("transaction.completed", { subscriptionId: null, origin: "web", oneTimeOnly: true }));
assert.equal(await hasPurchased(store, "user_42", "pro_credits"), true);
assert.deepEqual(purchased.at(-1), { userId: "user_42", priceIds: ["pri_credits"] });

// 7. a subscription checkout that also bought a one-time item records that item as a purchase
await deliver(transactionEvent("transaction.completed", { subscriptionId: "sub_2", origin: "web", oneTimeOnly: false, userId: "user_43" }));
assert.equal(await hasPurchased(store, "user_43", "pro_credits"), true);
assert.deepEqual(purchased.at(-1), { userId: "user_43", priceIds: ["pri_credits"] });

// 8. a failed process is not lost: the redelivery is processed, the delivery after that is a duplicate
let failOnce = true;
const flaky = new PaddleWebhookHandler(config, store, {
  async onSubscriptionChanged() {
    if (failOnce) {
      failOnce = false;
      throw new Error("database unavailable");
    }
  },
});
const retried = subscriptionEvent("active", "2026-10-04T14:00:00Z", { id: "sub_3" });
await assert.rejects(deliver(retried, flaky), /database unavailable/);
const failedRow = store.events.get(retried.event_id)!;
assert.equal(failedRow.processedAt, undefined);
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

// 10. a body that does not match the SDK model is recorded as failed, not applied
const broken = subscriptionEvent("active", "2026-10-04T16:00:00Z", { id: "sub_5" });
delete broken.data.items;
await assert.rejects(deliver(broken));
assert.equal(store.events.get(broken.event_id)!.processedAt, undefined);
assert.equal(await store.getSubscription("sub_5"), undefined);

// 11. a bad signature is refused before anything is recorded
const unsigned = subscriptionEvent("active", "2026-10-04T17:00:00Z");
const bad = await handler.receive(JSON.stringify(unsigned), "ts=1;h1=00");
assert.equal(bad.status, 401);
assert.equal(store.events.has(unsigned.event_id), false);

console.log("webhook-handler OK");
