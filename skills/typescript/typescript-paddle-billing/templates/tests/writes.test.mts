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
import { refundTransaction } from "../../server/paddle/adjustments.js";
import { MemoryPaddleStore } from "../../server/paddle/store.memory.js";
import { changePlan, chargeOneOff } from "../../server/paddle/subscriptions.js";
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

console.log("writes OK");
