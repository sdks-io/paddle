// Run: npx tsx tests/paddle/store.test.mts
// The PaddleStore contract (store.ts). Runs against the in-memory store, and against PostgreSQL
// (store.pg.ts) when DATABASE_URL is set: it creates a throwaway schema, applies schema.sql
// (path in PADDLE_SCHEMA_SQL, default db/schema.sql) and drops the schema afterwards.
// If the project implements PaddleStore with its ORM, run these cases against that implementation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { MemoryPaddleStore } from "../../server/paddle/store.memory.js";
import { PgPaddleStore } from "../../server/paddle/store.pg.js";
import type { PaddleStore, SubscriptionRow } from "../../server/paddle/store.js";

const t = (iso: string) => new Date(iso);

function subscription(over: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "sub_1", userId: "u1", paddleCustomerId: "ctm_1", status: "active", priceIds: ["pri_1"], productIds: ["pro_1"], quantity: 1,
    currentPeriodStartsAt: t("2026-10-01T00:00:00Z"), currentPeriodEndsAt: t("2026-11-01T00:00:00Z"), nextBilledAt: t("2026-11-01T00:00:00Z"),
    scheduledChangeAction: null, scheduledChangeEffectiveAt: null, collectionMode: "automatic", customData: { user_id: "u1" },
    lastEventOccurredAt: t("2026-10-01T10:00:00Z"), ...over,
  };
}

async function contract(name: string, store: PaddleStore): Promise<void> {
  // recordEvent: new → true; unprocessed → true again; processed → false
  const ev = { eventId: "evt_1", eventType: "subscription.updated", occurredAt: t("2026-10-01T10:00:00Z"), payload: { event_id: "evt_1" } };
  assert.equal(await store.recordEvent(ev), true);
  assert.equal(await store.recordEvent(ev), true);
  await store.markEventFailed("evt_1", "boom");
  assert.deepEqual((await store.listPendingEvents({ maxAttempts: 5, limit: 10 })).map((e) => [e.eventId, e.attempts]), [["evt_1", 1]]);
  assert.deepEqual(await store.listPendingEvents({ maxAttempts: 1, limit: 10 }), []); // attempts used up
  await store.markEventProcessed("evt_1");
  assert.equal(await store.recordEvent(ev), false);
  assert.deepEqual(await store.listPendingEvents({ maxAttempts: 5, limit: 10 }), []);

  // final states park an event until reopened; pending events come oldest first
  for (const [id, at] of [["evt_3", "2026-10-03T00:00:00Z"], ["evt_2", "2026-10-02T00:00:00Z"]] as const) {
    await store.recordEvent({ eventId: id, eventType: "x", occurredAt: t(at), payload: { event_id: id } });
  }
  assert.deepEqual((await store.listPendingEvents({ maxAttempts: 5, limit: 10 })).map((e) => e.eventId), ["evt_2", "evt_3"]);
  await store.markEventFinal("evt_2", "undecodable", "bad body");
  assert.deepEqual((await store.listPendingEvents({ maxAttempts: 5, limit: 10 })).map((e) => e.eventId), ["evt_3"]);
  assert.equal(await store.reopenEvents("undecodable"), 1);
  assert.deepEqual((await store.listPendingEvents({ maxAttempts: 5, limit: 10 })).map((e) => e.eventId), ["evt_2", "evt_3"]);
  assert.deepEqual((await store.listPendingEvents({ maxAttempts: 5, limit: 10 }))[0]?.payload, { event_id: "evt_2" });

  // subscriptions: newer wins
  await store.upsertSubscription(subscription());
  await store.upsertSubscription(subscription({ status: "paused", lastEventOccurredAt: t("2026-10-01T09:00:00Z") }));
  assert.equal((await store.getSubscription("sub_1"))?.status, "active");
  await store.upsertSubscription(subscription({ status: "past_due", quantity: 4, lastEventOccurredAt: t("2026-10-02T09:00:00Z") }));
  const sub = await store.getSubscription("sub_1");
  assert.equal(sub?.status, "past_due");
  assert.equal(sub?.quantity, 4);
  assert.deepEqual(sub?.priceIds, ["pri_1"]);
  assert.deepEqual(sub?.customData, { user_id: "u1" });
  assert.equal((await store.listSubscriptionsForUser("u1")).length, 1);

  // purchases per line; refunds mark lines and survive a re-upsert of the same event
  const purchase = {
    transactionId: "txn_1", userId: "u1", paddleCustomerId: "ctm_1", customData: null, completedAt: t("2026-10-01T10:00:00Z"), lastEventOccurredAt: t("2026-10-01T10:00:00Z"),
    items: [
      { lineItemId: "txnitm_a", priceId: "pri_a", productId: "pro_a", quantity: 2, refundedAt: null },
      { lineItemId: "txnitm_b", priceId: "pri_b", productId: "pro_b", quantity: 1, refundedAt: null },
    ],
  };
  await store.upsertPurchase(purchase);
  assert.deepEqual((await store.markPurchaseItemsRefunded("txn_1", ["txnitm_a"], t("2026-10-02T00:00:00Z"))).map((i) => i.lineItemId), ["txnitm_a"]);
  assert.deepEqual(await store.markPurchaseItemsRefunded("txn_1", ["txnitm_a"], t("2026-10-02T00:00:00Z")), []); // idempotent
  await store.upsertPurchase(purchase);
  const stored = await store.getPurchase("txn_1");
  assert.ok(stored?.items[0]?.refundedAt);
  assert.equal(stored?.items[1]?.refundedAt, null);
  assert.equal((await store.listPurchasesForUser("u1"))[0]?.items.length, 2);
  assert.equal((await store.markPurchaseItemsRefunded("txn_1", "all", t("2026-10-03T00:00:00Z"))).length, 1);

  // customers: one user per customer, never moved; rows without a user are assigned on link
  await store.linkCustomer("u1", "ctm_1", "a@example.test");
  await assert.rejects(store.linkCustomer("u2", "ctm_1", null));
  assert.equal(await store.getUserIdForCustomer("ctm_1"), "u1");
  await store.upsertSubscription(subscription({ id: "sub_2", userId: null, paddleCustomerId: "ctm_2" }));
  await store.linkCustomer("u2", "ctm_2", null);
  assert.equal(await store.assignUserToCustomerRows("u2", "ctm_2"), 1);
  assert.equal((await store.getSubscription("sub_2"))?.userId, "u2");

  // claims: the second claim is refused, the result is recorded, a released key can be claimed again
  assert.deepEqual(await store.claimWrite("checkout:u1:pri_1x1", "transaction", "u1"), { claimed: true });
  const again = await store.claimWrite("checkout:u1:pri_1x1", "transaction", "u1");
  assert.equal(again.claimed, false);
  await store.completeClaim("checkout:u1:pri_1x1", "txn_9");
  const done = await store.claimWrite("checkout:u1:pri_1x1", "transaction", "u1");
  assert.equal(!done.claimed && done.resultId, "txn_9");
  await store.releaseClaim("checkout:u1:pri_1x1");
  assert.deepEqual(await store.claimWrite("checkout:u1:pri_1x1", "transaction", "u1"), { claimed: true });
  // concurrent claims: exactly one wins
  const racers = await Promise.all([1, 2, 3, 4, 5].map(() => store.claimWrite("refund:txn_1:full", "refund", null)));
  assert.equal(racers.filter((r) => r.claimed).length, 1);

  // credits: idempotent on (transaction, reason, ref); several lines and refunds each count once
  await store.addCredits({ userId: "u1", delta: 100, reason: "purchase", transactionId: "txn_1", ref: "txnitm_a" });
  await store.addCredits({ userId: "u1", delta: 100, reason: "purchase", transactionId: "txn_1", ref: "txnitm_a" });
  await store.addCredits({ userId: "u1", delta: 50, reason: "purchase", transactionId: "txn_1", ref: "txnitm_b" });
  await store.addCredits({ userId: "u1", delta: -30, reason: "usage" });
  await store.addCredits({ userId: "u1", delta: -30, reason: "usage" });
  assert.equal(await store.getCreditBalance("u1"), 90);

  // plan catalog
  assert.equal(await store.getPlanByPriceId("pri_none"), undefined);

  // pending plan changes: one open per subscription, due by applyAfter, finished once
  const change = { subscriptionId: "sub_1", userId: "u1", items: [{ priceId: "pri_m", quantity: 1 }], renewalAt: t("2027-01-01T00:00:00Z"), applyAfter: t("2026-12-31T22:00:00Z"), requestedAt: t("2026-10-01T00:00:00Z"), appliedAt: null, canceledAt: null, note: null };
  await store.savePendingPlanChange(change);
  assert.deepEqual((await store.getPendingPlanChange("sub_1"))?.items, [{ priceId: "pri_m", quantity: 1 }]);
  assert.deepEqual(await store.listDuePendingPlanChanges(t("2026-12-31T21:00:00Z")), []);
  assert.equal((await store.listDuePendingPlanChanges(t("2026-12-31T22:30:00Z"))).length, 1);
  await store.finishPendingPlanChange("sub_1", "applied", t("2026-12-31T22:30:00Z"), "applied with do_not_bill");
  assert.equal(await store.getPendingPlanChange("sub_1"), undefined);
  assert.deepEqual(await store.listDuePendingPlanChanges(t("2027-02-01T00:00:00Z")), []);

  console.log(`store contract OK (${name})`);
}

await contract("memory", new MemoryPaddleStore());

const databaseUrl = process.env["DATABASE_URL"];
if (databaseUrl) {
  const schema = `paddle_store_test_${Date.now()}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await pool.query(readFileSync(process.env["PADDLE_SCHEMA_SQL"] ?? "db/schema.sql", "utf8"));
    await pool.query(readFileSync(process.env["PADDLE_SCHEMA_SQL"] ?? "db/schema.sql", "utf8")); // idempotent
    await contract("postgres", new PgPaddleStore(pool));
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
} else {
  console.log("store contract: DATABASE_URL not set, PostgreSQL store not checked");
}
