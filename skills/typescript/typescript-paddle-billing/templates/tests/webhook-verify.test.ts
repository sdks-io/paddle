// Run: npx tsx tests/paddle/webhook-verify.test.ts   (no network, no Paddle account needed)
import assert from "node:assert/strict";
import { signForTests, verifyPaddleSignature, parsePaddleSignature } from "../../server/paddle/webhooks/verify.js";

const secret = "pdl_ntfset_01gkpjp8bkm3tm53kdgkx6sms7_6h3qd3uFSi9YCD3OLYAShQI90XTI5vEI";
const body = JSON.stringify({ event_id: "evt_1", event_type: "subscription.updated", occurred_at: "2026-10-04T10:00:00Z", data: { id: "sub_1" } });
const now = 1_800_000_000;
const header = signForTests(body, secret, now);

assert.deepEqual(verifyPaddleSignature(body, header, secret, { nowSeconds: now }), { ok: true, ts: now });
assert.equal(verifyPaddleSignature(body + " ", header, secret, { nowSeconds: now }).ok, false, "any change to the raw body must fail");
assert.equal(reason(verifyPaddleSignature(body, header, secret, { nowSeconds: now + 6 })), "timestamp_out_of_tolerance");
assert.equal(reason(verifyPaddleSignature(body, header, "wrong", { nowSeconds: now })), "signature_mismatch");
assert.equal(reason(verifyPaddleSignature(body, undefined, secret)), "missing_signature");
assert.equal(reason(verifyPaddleSignature(body, "garbage", secret)), "malformed_signature");

// Secret rotation: several h1 values, any valid one passes.
const parsed = parsePaddleSignature(header)!;
assert.equal(verifyPaddleSignature(body, `ts=${now};h1=deadbeef;h1=${parsed.h1[0]}`, secret, { nowSeconds: now }).ok, true);

// The header format from Paddle's docs parses.
assert.deepEqual(parsePaddleSignature("ts=1671552777;h1=eb4d0dc8853be92b7f063b9f3ba5233eb920a09459b6e6b2c26705b4364db151"), {
  ts: 1671552777,
  h1: ["eb4d0dc8853be92b7f063b9f3ba5233eb920a09459b6e6b2c26705b4364db151"],
});

// A Buffer body (express.raw) verifies the same as the string.
assert.equal(verifyPaddleSignature(Buffer.from(body), header, secret, { nowSeconds: now }).ok, true);

console.log("webhook-verify OK");

function reason(r: ReturnType<typeof verifyPaddleSignature>): string | undefined {
  return r.ok ? undefined : r.reason;
}
