// Run: npx tsx tests/paddle/writes.test.mts   (no network: the SDK client gets a fake fetch)
// The claim pattern (writes.ts) and the error answers (errors.ts): a double submit writes once, an
// unknown outcome is re-read before anything is reported, a refusal releases the claim, a write that
// was never sent is not re-read. These are the routing skill's 1b.1 and 1b.4 tests; port them to the
// project's test runner (typescript-testing).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PaddleApiClient, ServerEnvironment } from "paddle-apimatic-sdk";
import { createCheckoutTransaction, checkoutClaimKey } from "../../server/paddle/checkout.js";
import { createPaddleClient, usePaddleClientForTests } from "../../server/paddle/client.js";
import type { PaddleConfig } from "../../server/paddle/config.js";
import { OutcomeUnknownError, toHttpAnswer, writeOutcome } from "../../server/paddle/errors.js";
import { MemoryPaddleStore } from "../../server/paddle/store.memory.js";
import { applyDuePlanChanges, changePlan, chargeOneOff, currentSubscription, PLAN_CHANGE_WINDOW } from "../../server/paddle/subscriptions.js";
import { creditInvoice, grantGoodwillDiscount, refundTransaction } from "../../server/paddle/adjustments.js";
import { WriteInProgressError } from "../../server/paddle/writes.js";

type Json = Record<string, any>;
const fixture = (name: string): Json => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const meta = { request_id: "req_test" };

const config: PaddleConfig = { environment: "sandbox", apiKey: "pdl_sdbx_apikey_x", apiBaseUrl: "https://sandbox-api.paddle.com", apiUrlOverride: undefined, webhookSecret: undefined, webhookToleranceSeconds: 5 };

/** Requests the SDK sent, and the answer the test chose for each. */
const sent: { method: string; path: string; body: Json | undefined }[] = [];
let answer: (method: string, path: string, body: Json | undefined) => Response | "drop";
const fakeFetch: typeof fetch = async (input, init) => {
  const req = new Request(input as RequestInfo, init);
  const url = new URL(req.url);
  const text = req.method === "GET" ? "" : await req.text();
  const body = text ? (JSON.parse(text) as Json) : undefined;
  sent.push({ method: req.method, path: url.pathname, body });
  const res = answer(req.method, url.pathname, body);
  if (res === "drop") throw new TypeError("fetch failed: connection reset"); // the request may have reached Paddle
  return res;
};
usePaddleClientForTests(config, createPaddleClient(config, { fetch: fakeFetch }));
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const posts = (path: string) => sent.filter((r) => r.method === "POST" && r.path === path).length;

/** An API transaction built from a real sandbox delivery. */
function transaction(id: string, status: string, claimKey: string): Json {
  const t = fixture("sandbox-transaction-completed").data;
  return { ...t, id, status, custom_data: { user_id: "u1", claim_key: claimKey }, customer_id: "ctm_1", subscription_id: null };
}

const store = new MemoryPaddleStore();
const items = [{ priceId: "pri_1", quantity: 1 }];
const claimKey = checkoutClaimKey("u1", items);
const input = { claimKey, userId: "u1", customerId: "ctm_1", items };

// 1. a double submit creates one transaction; the second call reuses the open one
let txnStatus = "ready";
answer = (method, path) => {
  if (method === "POST" && path === "/transactions") return json(201, { data: transaction("txn_1", "ready", claimKey), meta });
  if (method === "GET" && path === "/transactions/txn_1") return json(200, { data: transaction("txn_1", txnStatus, claimKey), meta });
  return json(404, { error: { type: "request_error", documentation_url: "https://developer.paddle.com/errors", code: "not_found", detail: "x" }, meta });
};
// the claim is in the store before the request leaves
let claimSeenInFlight = false;
const inner = answer;
answer = (method, path, body) => {
  if (method === "POST") claimSeenInFlight = store.claims.has(claimKey);
  return inner(method, path, body);
};
const a = await createCheckoutTransaction(store, input);
const b = await createCheckoutTransaction(store, input);
assert.equal(a.transactionId, "txn_1");
assert.equal(b.reused, true);
assert.equal(posts("/transactions"), 1);
assert.equal(claimSeenInFlight, true);
// the claim's request body carried the reference the re-read searches by, and no field nothing requires
const firstPost = sent.find((r) => r.method === "POST")?.body ?? {};
assert.equal(firstPost["custom_data"]?.["claim_key"], claimKey);
// (collection_mode is a default the SDK adds itself; defaults the SDK sends need no row)
assert.deepEqual(Object.keys(firstPost).filter((k) => k !== "collection_mode").sort(), ["custom_data", "customer_id", "items"]);

// 2. once that transaction is paid, the same purchase gets a new transaction
txnStatus = "completed";
answer = (method, path) => {
  if (method === "GET" && path === "/transactions/txn_1") return json(200, { data: transaction("txn_1", "completed", claimKey), meta });
  if (method === "POST" && path === "/transactions") return json(201, { data: transaction("txn_2", "ready", claimKey), meta });
  return json(404, { error: { type: "request_error", documentation_url: "https://developer.paddle.com/errors", code: "not_found", detail: "x" }, meta });
};
assert.equal((await createCheckoutTransaction(store, input)).transactionId, "txn_2");
// two buyers clicking at once after the paid checkout: exactly one new transaction
txnStatus = "completed";
let n = 2;
answer = (method, path) => {
  if (method === "GET" && path.startsWith("/transactions/")) return json(200, { data: transaction(path.split("/")[2]!, "completed", claimKey), meta });
  if (method === "POST" && path === "/transactions") return json(201, { data: transaction(`txn_new_${++n}`, "ready", claimKey), meta });
  return json(404, { error: { type: "request_error", documentation_url: "https://developer.paddle.com/errors", code: "not_found", detail: "x" }, meta });
};
sent.length = 0;
const both = await Promise.allSettled([createCheckoutTransaction(store, input), createCheckoutTransaction(store, input)]);
assert.equal(posts("/transactions"), 1);
assert.equal(both.filter((r) => r.status === "fulfilled").length + both.filter((r) => r.status === "rejected" && r.reason instanceof WriteInProgressError).length, 2);

// 3. connection lost on the create: the write is re-read by its claim key and found
const key3 = checkoutClaimKey("u3", items);
answer = (method, path) => {
  if (method === "POST" && path === "/transactions") return "drop";
  if (method === "GET" && path === "/transactions") return json(200, { data: [transaction("txn_3", "ready", key3)], meta: { ...meta, pagination: { per_page: 30, next: "https://x/transactions?after=txn_3", has_more: false, estimated_total: 1 } } });
  return json(404, { error: { type: "request_error", documentation_url: "https://developer.paddle.com/errors", code: "not_found", detail: "x" }, meta });
};
sent.length = 0;
const c = await createCheckoutTransaction(store, { ...input, claimKey: key3, userId: "u3" });
assert.equal(c.transactionId, "txn_3");
assert.ok(sent.some((r) => r.method === "GET" && r.path === "/transactions"), "the re-read request was made");
assert.equal(store.claims.get(key3)?.resultId, "txn_3");

// 4. connection lost and nothing found: outcome unknown (never "failed"); the claim stays and blocks a second write
const key4 = checkoutClaimKey("u4", items);
answer = (method, path) => {
  if (method === "POST" && path === "/transactions") return "drop";
  if (method === "GET" && path === "/transactions") return json(200, { data: [], meta: { ...meta, pagination: { per_page: 30, next: "https://x/transactions", has_more: false, estimated_total: 0 } } });
  return json(404, { error: { type: "request_error", documentation_url: "https://developer.paddle.com/errors", code: "not_found", detail: "x" }, meta });
};
const unknown = await createCheckoutTransaction(store, { ...input, claimKey: key4, userId: "u4" }).catch((e: unknown) => e);
assert.ok(unknown instanceof OutcomeUnknownError);
assert.deepEqual(toHttpAnswer(unknown).body.outcome, "unknown");
assert.equal(toHttpAnswer(unknown).status, 502);
assert.ok(store.claims.has(key4));
sent.length = 0;
await assert.rejects(createCheckoutTransaction(store, { ...input, claimKey: key4, userId: "u4" }), WriteInProgressError);
assert.equal(posts("/transactions"), 0);

// 5. Paddle refuses (4xx): the claim is released; the caller gets Paddle's code and field messages, not its free-text detail
const key5 = checkoutClaimKey("u5", items);
answer = () =>
  json(400, { error: { type: "request_error", documentation_url: "https://developer.paddle.com/errors", code: "invalid_field", detail: "internal wording", errors: [{ field: "items[0].quantity", message: "must be at most 1" }] }, meta });
const refused = await createCheckoutTransaction(store, { ...input, claimKey: key5, userId: "u5" }).catch((e: unknown) => e);
assert.equal(writeOutcome(refused), "refused");
assert.equal(store.claims.has(key5), false);
const http = toHttpAnswer(refused);
assert.equal(http.status, 400);
assert.equal(http.body.code, "invalid_field");
assert.deepEqual(http.body.fields, [{ field: "items[0].quantity", message: "must be at most 1" }]);
assert.match(http.body.error, /must be at most 1/);
assert.doesNotMatch(JSON.stringify(http.body), /internal wording/);
// credentials and quota problems are ours: fixed messages
answer = () => json(403, { error: { type: "request_error", documentation_url: "https://developer.paddle.com/errors", code: "forbidden", detail: "x" }, meta });
const forbidden = toHttpAnswer(await createCheckoutTransaction(store, { ...input, claimKey: "k403", userId: "u7" }).catch((e: unknown) => e));
assert.equal(forbidden.status, 502);
assert.equal(forbidden.body.fields, undefined);

// 6. a write that never left (the credential could not be obtained) is not re-read and releases the claim
assert.equal(writeOutcome(new Error("bug")), "not_sent");
usePaddleClientForTests(config, new PaddleApiClient({ serverEnvironment: ServerEnvironment.Sandbox, fetch: fakeFetch, bearerAuth: async () => { throw new Error("vault unavailable"); } }));
sent.length = 0;
const key6 = checkoutClaimKey("u6", items);
const notSent = await createCheckoutTransaction(store, { ...input, claimKey: key6, userId: "u6" }).catch((e: unknown) => e);
assert.equal(writeOutcome(notSent), "not_sent");
assert.equal(sent.length, 0, "no request, no re-read");
assert.equal(store.claims.has(key6), false);
usePaddleClientForTests(config, createPaddleClient(config, { fetch: fakeFetch }));

// 7. the same refund asked twice is created once
const adjustment = (id: string) => ({
  id, action: "refund", type: "full", transaction_id: "txn_1", subscription_id: null, customer_id: "ctm_1", reason: "goodwill", currency_code: "USD",
  status: "pending_approval", items: [], tax_rates_used: [], totals: { subtotal: "100", tax: "0", total: "100", fee: "0", earnings: "0", currency_code: "USD" },
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
});
answer = (method, path) => {
  if (method === "POST" && path === "/adjustments") return json(201, { data: adjustment("adj_1"), meta });
  if (method === "GET" && path === "/adjustments") return json(200, { data: [adjustment("adj_1")], meta: { ...meta, pagination: { per_page: 50, next: "https://x/adjustments", has_more: false, estimated_total: 1 } } });
  return json(404, { error: { type: "request_error", documentation_url: "https://developer.paddle.com/errors", code: "not_found", detail: "x" }, meta });
};
sent.length = 0;
const r1 = await refundTransaction(store, "txn_1", "goodwill");
const r2 = await refundTransaction(store, "txn_1", "goodwill");
assert.equal(r1.adjustment.id, "adj_1");
assert.equal(r2.reused, true);
assert.equal(posts("/adjustments"), 1);

// 7b. a dropped partial refund is not settled by an earlier refund of the same line with another amount
const partial = (id: string, amount: string) => ({ ...adjustment(id), type: "partial", status: "approved", items: [{ id: `adjitm_${id}`, item_id: "txnitm_x", type: "partial", amount, totals: { subtotal: amount, tax: "0", total: amount } }] });
await store.claimWrite("refund:txn_1:txnitm_x=500", "refund", null);
await store.completeClaim("refund:txn_1:txnitm_x=500", "adj_500");
answer = (method, path) => {
  if (method === "POST" && path === "/adjustments") return "drop";
  if (method === "GET" && path === "/adjustments") return json(200, { data: [partial("adj_500", "500")], meta: { ...meta, pagination: { per_page: 50, next: "https://x/adjustments", has_more: false, estimated_total: 1 } } });
  return json(404, { error: { type: "request_error", documentation_url: "https://developer.paddle.com/errors", code: "not_found", detail: "x" }, meta });
};
const dropped = await refundTransaction(store, "txn_1", "goodwill", [{ lineItemId: "txnitm_x", amount: "300" }]).catch((e: unknown) => e);
assert.ok(dropped instanceof OutcomeUnknownError);
// ... while asking again for the same 500 returns the refund its claim already holds
const sameAmount = await refundTransaction(store, "txn_1", "goodwill", [{ lineItemId: "txnitm_x", amount: "500" }]);
assert.equal(sameAmount.reused, true);
assert.equal(sameAmount.adjustment.id, "adj_500");

// 8. a one-off charge with the same ref is made once
// API responses carry management_urls, which webhook payloads leave out.
const subscription = { ...fixture("sandbox-subscription-created").data, management_urls: { update_payment_method: null, cancel: "https://sandbox-buyer-portal.paddle.com/cancel" } };
answer = (method, path) =>
  method === "POST" && path.endsWith("/charge")
    ? json(200, { data: subscription, meta })
    : method === "GET" && path === `/subscriptions/${subscription.id}`
      ? json(200, { data: subscription, meta })
      : json(404, { error: { type: "request_error", documentation_url: "https://developer.paddle.com/errors", code: "not_found", detail: "x" }, meta });
sent.length = 0;
await chargeOneOff(store, subscription.id, [{ priceId: "pri_overage", quantity: 3 }], "next_billing_period", { ref: "usage:2026-10" });
const again = await chargeOneOff(store, subscription.id, [{ priceId: "pri_overage", quantity: 3 }], "next_billing_period", { ref: "usage:2026-10" });
assert.equal("reused" in again && again.reused, true);
assert.equal(sent.filter((r) => r.method === "POST").length, 1);
// 8b. a dropped immediate charge is not settled by an earlier charge of the same items
const chargeTxn = (id: string) => ({ ...transaction(id, "completed", "x"), subscription_id: subscription.id, origin: "subscription_charge", items: [{ ...fixture("sandbox-transaction-completed").data.items[0], price: { ...fixture("sandbox-transaction-completed").data.items[0].price, id: "pri_overage" } }] });
answer = (method, path) => {
  if (method === "POST" && path.endsWith("/charge")) return "drop";
  if (method === "GET" && path === "/transactions") return json(200, { data: [chargeTxn("txn_earlier")], meta: { ...meta, pagination: { per_page: 30, next: "https://x/transactions", has_more: false, estimated_total: 1 } } });
  return json(404, { error: { type: "request_error", documentation_url: "https://developer.paddle.com/errors", code: "not_found", detail: "x" }, meta });
};
const droppedCharge = await chargeOneOff(store, subscription.id, [{ priceId: "pri_overage", quantity: 3 }], "immediately", { ref: "order-B" }).catch((e: unknown) => e);
assert.ok(droppedCharge instanceof OutcomeUnknownError);
// the next attempt does not write again: the claim waits for a person (paddle-jobs.ts claims)
sent.length = 0;
await assert.rejects(chargeOneOff(store, subscription.id, [{ priceId: "pri_overage", quantity: 3 }], "immediately", { ref: "order-B" }), WriteInProgressError);
assert.equal(sent.filter((r) => r.method === "POST").length, 0);

// 9. a plan change whose answer was lost counts as done when the subscription already shows the new items
const target = [{ priceId: subscription.items[0].price.id as string, quantity: subscription.items[0].quantity as number }];
answer = (method) => (method === "PATCH" ? "drop" : json(200, { data: subscription, meta }));
const changed = await changePlan(subscription.id, target, "prorated_immediately");
assert.equal(changed.subscription?.id, subscription.id);
// ... and stays unknown when it does not
const unknownChange = await changePlan(subscription.id, [{ priceId: "pri_other", quantity: 1 }], "prorated_immediately").catch((e: unknown) => e);
assert.ok(unknownChange instanceof OutcomeUnknownError);
// no on_payment_failure is sent unless the caller asked for it
assert.equal(sent.filter((r) => r.method === "PATCH").every((r) => r.body?.["on_payment_failure"] === undefined), true);

// 10. a dropped immediate charge is not settled with a new charge another claim already recorded
const listPage = (data: unknown[]) => json(200, { data, meta: { ...meta, pagination: { per_page: 30, next: "https://x/transactions", has_more: false, estimated_total: data.length } } });
const freshCharge = (id: string) => ({ ...chargeTxn(id), created_at: new Date().toISOString() });
const notFound = () => json(404, { error: { type: "request_error", documentation_url: "https://developer.paddle.com/errors", code: "not_found", detail: "x" }, meta });
await store.claimWrite(`charge:${subscription.id}:order-A`, "charge", null);
await store.completeClaim(`charge:${subscription.id}:order-A`, "txn_charge_A");
let listCalls = 0;
answer = (method, path) => {
  if (method === "GET" && path === "/transactions") return listCalls++ === 0 ? listPage([]) : listPage([freshCharge("txn_charge_A")]);
  if (method === "POST" && path.endsWith("/charge")) return "drop";
  return notFound();
};
const notMine = await chargeOneOff(store, subscription.id, [{ priceId: "pri_overage", quantity: 3 }], "immediately", { ref: "order-C" }).catch((e: unknown) => e);
assert.ok(notMine instanceof OutcomeUnknownError, "another claim's charge must not settle this one");
// ... nor with a charge that already existed before the write (made in the dashboard, or before claims were kept)
answer = (method, path) => {
  if (method === "GET" && path === "/transactions") return listPage([freshCharge("txn_charge_old")]);
  if (method === "POST" && path.endsWith("/charge")) return "drop";
  return notFound();
};
const preExisting = await chargeOneOff(store, subscription.id, [{ priceId: "pri_overage", quantity: 3 }], "immediately", { ref: "order-F" }).catch((e: unknown) => e);
assert.ok(preExisting instanceof OutcomeUnknownError, "a charge from before the write must not settle it");
// ... while a dropped charge whose own new transaction appears is settled with that transaction
answer = (method, path) => {
  if (method === "GET" && path === "/transactions") return listCalls++ === 0 ? listPage([]) : listPage([freshCharge("txn_charge_E")]);
  if (method === "POST" && path.endsWith("/charge")) return "drop";
  return notFound();
};
listCalls = 0;
const chargeE = await chargeOneOff(store, subscription.id, [{ priceId: "pri_overage", quantity: 3 }], "immediately", { ref: "order-E" });
assert.equal(chargeE.subscriptionId, subscription.id);
assert.equal(store.claims.get(`charge:${subscription.id}:order-E`)?.resultId, "txn_charge_E");

// 11. a next-period charge records a result unique to it (its claim key), never the subscription id
const txnDetails = fixture("sandbox-transaction-completed").data.details;
const withNext = (lines: string[]) => ({
  ...subscription,
  next_transaction: {
    billing_period: { starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-12-01T00:00:00Z" },
    details: { ...txnDetails, line_items: lines.map((priceId, i) => ({ ...txnDetails.line_items[0], id: `txnitm_n${i}`, price_id: priceId })) },
  },
});
let nextCalls = 0;
answer = (method, path) => {
  if (method === "GET" && path === `/subscriptions/${subscription.id}`) return json(200, { data: nextCalls++ === 0 ? withNext(["pri_overage"]) : withNext(["pri_overage", "pri_overage"]), meta });
  if (method === "POST" && path.endsWith("/charge")) return "drop";
  return notFound();
};
await chargeOneOff(store, subscription.id, [{ priceId: "pri_overage", quantity: 1 }], "next_billing_period", { ref: "usage:2026-11" });
assert.equal(store.claims.get(`charge:${subscription.id}:usage:2026-11`)?.resultId, `charge:${subscription.id}:usage:2026-11`);
assert.equal(await store.isClaimResult(subscription.id), false);

// 12. the end-of-term job: a cycle change is applied with full_immediately; a change already in effect is only closed
const renewal = new Date(Date.now() + 60 * 60_000); // inside the window (2 h .. 35 min before)
const subWith = (priceId: string, interval: string) => ({
  ...subscription,
  status: "active",
  scheduled_change: null,
  next_billed_at: renewal.toISOString(),
  items: [{ ...subscription.items[0], status: "active", quantity: 1, price: { ...subscription.items[0].price, id: priceId, billing_cycle: { interval, frequency: 1 } } }],
});
const priceOf = (id: string, interval: string) => ({ ...subscription.items[0].price, id, billing_cycle: { interval, frequency: 1 } });
let current = subWith("pri_yearly", "year");
answer = (method, path, body) => {
  if (method === "GET" && path === `/subscriptions/${subscription.id}`) return json(200, { data: current, meta });
  if (method === "GET" && path === "/prices/pri_monthly") return json(200, { data: priceOf("pri_monthly", "month"), meta });
  if (method === "PATCH") {
    current = subWith((body?.["items"] as { price_id: string }[])[0]!.price_id, "month");
    return json(200, { data: current, meta });
  }
  return notFound();
};
await store.savePendingPlanChange({
  subscriptionId: subscription.id, userId: "u1", items: [{ priceId: "pri_monthly", quantity: 1 }], renewalAt: renewal,
  applyAfter: new Date(renewal.getTime() - PLAN_CHANGE_WINDOW.startBeforeRenewalMs), requestedAt: new Date(), appliedAt: null, canceledAt: null, note: null,
});
sent.length = 0;
const run1 = await applyDuePlanChanges(store);
assert.deepEqual(run1.applied, [subscription.id]);
assert.equal(sent.find((r) => r.method === "PATCH")?.body?.["proration_billing_mode"], "full_immediately");
assert.equal(store.planChanges.get(subscription.id)?.note, "applied with full_immediately");
// a change whose answer was lost: the next run finds it in effect and closes it without a second PATCH
await store.savePendingPlanChange({ ...store.planChanges.get(subscription.id)!, appliedAt: null, note: null });
sent.length = 0;
const run2 = await applyDuePlanChanges(store);
assert.deepEqual(run2.applied, [subscription.id]);
assert.equal(sent.filter((r) => r.method === "PATCH").length, 0);
assert.equal(store.planChanges.get(subscription.id)?.note, "already in effect");

// 13. goodwill: created and applied once; a repeat with the same ref does nothing
const goodwill = {
  id: "dsc_gw", status: "active", description: "Sorry", enabled_for_checkout: false, code: "GWX", type: "flat", mode: "standard", amount: "200",
  currency_code: "USD", recur: true, maximum_recurring_intervals: 1, usage_limit: null, restrict_to: null, expires_at: null, times_used: 0,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), custom_data: null, import_meta: null, discount_group_id: null,
};
let discountCreated = false;
let subDiscount: unknown = null;
answer = (method, path) => {
  if (method === "GET" && path === `/subscriptions/${subscription.id}`) return json(200, { data: { ...subscription, discount: subDiscount }, meta });
  if (method === "GET" && path === "/discounts") return listPage(discountCreated ? [goodwill] : []);
  if (method === "POST" && path === "/discounts") {
    discountCreated = true;
    return json(201, { data: goodwill, meta });
  }
  if (method === "PATCH") {
    subDiscount = { id: goodwill.id, starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-12-01T00:00:00Z", type: "recurring" };
    return json(200, { data: { ...subscription, discount: subDiscount }, meta });
  }
  return notFound();
};
sent.length = 0;
const g1 = await grantGoodwillDiscount(store, { subscriptionId: subscription.id, amount: "200", currencyCode: "USD", description: "Sorry", ref: "t-1" });
const g2 = await grantGoodwillDiscount(store, { subscriptionId: subscription.id, amount: "200", currencyCode: "USD", description: "Sorry", ref: "t-1" });
assert.equal(g1.alreadyGranted, false);
assert.equal(g2.alreadyGranted, true);
const createBody = sent.find((r) => r.method === "POST" && r.path === "/discounts")?.body;
assert.equal(sent.filter((r) => r.method === "POST" && r.path === "/discounts").length, 1);
assert.equal(sent.filter((r) => r.method === "PATCH").length, 1);
assert.deepEqual([createBody?.["recur"], createBody?.["maximum_recurring_intervals"]], [true, 1]);

// 14. a full credit of an invoice is sent as every line in full (Paddle takes a credit only as line items)
const invoice: Json = { ...transaction("txn_inv", "billed", "x"), collection_mode: "manual" };
const invoiceLines = (invoice["details"]["line_items"] as Json[]).map((l) => l["id"] as string);
answer = (method, path) => {
  if (method === "GET" && path === "/transactions/txn_inv") return json(200, { data: invoice, meta });
  if (method === "POST" && path === "/adjustments") return json(201, { data: { ...adjustment("adj_c"), action: "credit", type: "partial", transaction_id: "txn_inv", status: "approved" }, meta });
  return notFound();
};
sent.length = 0;
await creditInvoice(store, "txn_inv", "written off");
const creditBody = sent.find((r) => r.method === "POST" && r.path === "/adjustments")?.body;
assert.equal(creditBody?.["type"], "partial");
assert.deepEqual((creditBody?.["items"] as Json[]).map((i) => [i["item_id"], i["type"]]), invoiceLines.map((id) => [id, "full"]));

// 15. on a paused subscription, items set during the pause are inactive and still its items
const pausedSub = { ...subscription, status: "paused", items: (subscription.items as Json[]).map((i) => ({ ...i, status: "inactive" })) };
answer = (method) => (method === "PATCH" ? "drop" : json(200, { data: pausedSub, meta }));
const pausedNow = await currentSubscription(subscription.id);
assert.deepEqual([pausedNow.status, pausedNow.items], ["paused", target]);
// a change whose answer was lost counts as done when the paused subscription shows the new (inactive) items
const pausedChange = await changePlan(subscription.id, target, "do_not_bill");
assert.equal(pausedChange.subscription?.status, "paused");

console.log("writes OK");
