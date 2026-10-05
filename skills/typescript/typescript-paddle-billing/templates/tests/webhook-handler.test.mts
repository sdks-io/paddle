// Run: npx tsx tests/paddle/webhook-handler.test.mts   (no network; uses the in-memory store)
// Covers: verification, dedupe on event_id, out-of-order events, user mapping from custom_data,
// access by status, scheduled cancel, one-time purchase fulfilment on transaction.completed only.
import assert from "node:assert/strict";
import { PaddleWebhookHandler } from "../../server/paddle/webhooks/handler.js";
import { MemoryPaddleStore } from "../../server/paddle/store.memory.js";
import { signForTests } from "../../server/paddle/webhooks/verify.js";
import { getEntitlement, hasPurchased } from "../../server/paddle/entitlements.js";
import type { PaddleConfig } from "../../server/paddle/config.js";

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
const handler = new PaddleWebhookHandler(config, store);

let counter = 0;
function subscriptionEvent(status: string, occurredAt: string, extra: Record<string, unknown> = {}) {
  counter += 1;
  return {
    event_id: `evt_${counter}`,
    event_type: "subscription.updated",
    occurred_at: occurredAt,
    notification_id: "ntf_1",
    data: {
      id: "sub_1",
      status,
      customer_id: "ctm_1",
      address_id: "add_1",
      business_id: null,
      currency_code: "USD",
      collection_mode: "automatic",
      items: [
        {
          status: "active",
          quantity: 3,
          recurring: true,
          price: { id: "pri_pro_m", product_id: "pro_pro", billing_cycle: { interval: "month", frequency: 1 } },
          next_billed_at: null,
          previously_billed_at: null,
          trial_dates: null,
        },
      ],
      current_billing_period: { starts_at: "2026-10-01T00:00:00Z", ends_at: "2026-11-01T00:00:00Z" },
      next_billed_at: "2026-11-01T00:00:00Z",
      paused_at: null,
      canceled_at: null,
      scheduled_change: null,
      custom_data: { user_id: "user_42" },
      created_at: occurredAt,
      updated_at: occurredAt,
      ...extra,
    },
  };
}

function transactionEvent(eventType: string, subscriptionId: string | null) {
  return {
    event_id: `evt_${eventType}_${subscriptionId ?? "one"}`,
    event_type: eventType,
    occurred_at: "2026-10-04T14:00:00Z",
    notification_id: "ntf_2",
    data: {
      id: `txn_${subscriptionId ?? "one"}`,
      status: eventType === "transaction.completed" ? "completed" : "paid",
      customer_id: "ctm_1",
      address_id: "add_1",
      business_id: null,
      subscription_id: subscriptionId,
      origin: "web",
      collection_mode: "automatic",
      currency_code: "USD",
      invoice_number: null,
      items: [{ price: { id: "pri_credits", product_id: "pro_credits", billing_cycle: null }, quantity: 1 }],
      custom_data: { user_id: "user_42" },
      billed_at: null,
      created_at: "2026-10-04T14:00:00Z",
      updated_at: "2026-10-04T14:00:00Z",
    },
  };
}

async function deliver(envelope: object) {
  const body = JSON.stringify(envelope);
  const result = await handler.receive(body, signForTests(body, secret));
  assert.equal(result.status, 200);
  if (result.status === 200 && !result.duplicate) await handler.process(result.envelope);
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
await deliver(transactionEvent("transaction.paid", null));
assert.equal(await hasPurchased(store, "user_42", "pro_credits"), false);
await deliver(transactionEvent("transaction.completed", "sub_1"));
assert.equal(await hasPurchased(store, "user_42", "pro_credits"), false);
await deliver(transactionEvent("transaction.completed", null));
assert.equal(await hasPurchased(store, "user_42", "pro_credits"), true);

// 7. a bad signature is refused before anything is recorded
const bad = await handler.receive(JSON.stringify(subscriptionEvent("active", "2026-10-04T15:00:00Z")), "ts=1;h1=00");
assert.equal(bad.status, 401);

console.log("webhook-handler OK");
