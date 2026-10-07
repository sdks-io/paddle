# Webhooks: events, rules, handling

Code: `templates/server/paddle/webhooks/*`. Destination: created or reused by the agent with `scripts/paddle-setup.ts webhook <url>` (SKILL.md section 7).

## Rules (from Paddle's webhook documentation)

1. **Verify first.** Header `Paddle-Signature: ts=<unix seconds>;h1=<hex>` (several `h1` during secret rotation). Signed payload is `${ts}:${rawBody}`; HMAC-SHA256 with the destination's `endpoint_secret_key` (`pdl_ntfset_…`), hex, constant-time compare. The body must be the raw bytes. Reject when `|now − ts|` exceeds the tolerance (Paddle's SDKs use 5 seconds; `PADDLE_WEBHOOK_TOLERANCE_SECONDS` to loosen when a queue runs before the handler).
2. **Answer within 5 seconds.** The adapters process, then answer; keep hooks fast. A non-2xx or a timeout makes Paddle retry: live 60 attempts over 3 days (20 in the first hour), sandbox 3 attempts in 15 minutes; then the notification is `failed` and can be replayed with `replayNotification`. Paddle stops either way, so the reprocess job (`webhooks/reprocess.ts`, `paddle-jobs.ts reprocess`) re-runs every event still unprocessed in the app's table.
3. **At-least-once.** The same `event_id` can arrive twice (and per destination each delivery has its own `notification_id`). Insert `event_id` into `paddle_webhook_events` first; a conflict with a processed row means skip. A row whose processing failed is processed again on the redelivery or by the reprocess job.
3a. **Undecodable bodies are final.** A body that does not match the SDK model for its event type cannot succeed on a retry. The handler parks it (`final_state = 'undecodable'`, raw payload kept), answers 200 and calls `onEventNeedsAttention`; after an SDK upgrade, `paddle-jobs.ts reopen undecodable` applies the parked events.
4. **Unordered.** Compare `occurred_at` with the row's `last_event_occurred_at`; ignore older events. Never infer state from arrival order or from the event name alone — read `data.status`.
5. **Full entity in `data`.** Every event carries the whole entity as it was at `occurred_at`. The handler decodes it with the SDK's model for that event type (`webhooks/types.ts`). Subscription payloads omit `management_urls` (they are temporary).
6. **Source IPs** (if you filter): sandbox `34.194.127.46, 54.234.237.108, 3.208.120.145, 44.226.236.210, 44.241.183.62, 100.20.172.113`; live `34.232.58.13, 34.195.105.136, 34.237.3.244, 35.155.119.135, 52.11.166.252, 34.212.5.7`; or `client.ipAddresses.getIpAddresses()` per environment. Let the webhook path bypass WAF bot checks.
7. **Destinations**: `type: "url"`, HTTPS, one per URL, max 10 active; `trafficSource: "all"` to receive simulations too; events list is replaced on update (send the complete list); `apiVersion: 1`. The secret is readable on GET of the destination; rotation is not offered by the API (create a new destination, switch, delete the old).
8. **Every destination receives every event on the account.** Destinations filter by event type only. Two apps (or a staging and a production deployment) on one Paddle account receive each other's subscriptions and purchases. The handler applies an event only when one of its prices is in `plan_catalog` (or it concerns a row the app already holds) and records the rest as ignored; `getEntitlement` grants access only for a listed tier. Prefer one Paddle account per app.

## Events to subscribe to and what to do

| Event | Fires when | Handler action |
| --- | --- | --- |
| `subscription.created` | first subscription for a checkout (or billed invoice) | upsert mirror; link user ↔ customer; grant access by status |
| `subscription.updated` | any change: renewal, upgrade, status change, scheduled change set/removed, consent changes | upsert mirror — this one event is sufficient for access |
| `subscription.activated` | status becomes `active` (e.g. trial end) | mirror upserted (the handler applies every `subscription.*` event); hook for a welcome email |
| `subscription.trialing` | created in trial | mirror upserted |
| `subscription.past_due` | a renewal payment failed | show banner, email customer; keep access |
| `subscription.paused` / `resumed` / `canceled` | status changes | mirror upserted from the event's `data`; hook for emails |
| `transaction.completed` | payment captured and processed | **fulfil one-time purchases**: one `paddle_purchase_items` row per one-time catalog line (every item when `subscriptionId` is null, and the one-time items of a subscription checkout); renewals and charges (origin `subscription_*`) also complete — ignore for access, use for receipts |
| `transaction.payment_failed` | a payment attempt failed (checkout or renewal) | `onPaymentFailed` hook: notify; Paddle retries renewals |
| `transaction.paid` | captured but not yet processed | do nothing (may lack `invoice_number`, `subscription_id`) |
| `transaction.billed` | invoice issued (manual collection) | B2B invoicing only |
| `adjustment.created` / `adjustment.updated` | refund/credit/chargeback created or changed status | an approved refund (on either event: refunds that qualify for automatic approval are created `approved` and never send `adjustment.updated` on live) or a chargeback marks the purchase lines it refunds whole (items of type `full`, every line for a full refund or a chargeback) as refunded; `onPurchaseRefunded` revokes what they gave (negative credit entry). A partial amount leaves the line; `onAdjustment` sees it. A refund that arrives before its purchase is recorded fails and is retried |
| `customer.created` / `updated`, `address.*`, `business.*` | buyer records | optional: refresh email/name cache |
| `price.*`, `product.*`, `discount.*` | catalog edits in the dashboard | optional: invalidate catalog cache |
| `payout.created` / `payout.paid` | Paddle paid the owner | owner notification only |
| `api_key.expiring` / `expired` / `revoked`, `api_key_exposure.created` | key lifecycle | alert the owner; rotate |
| `payment_method.saved` / `deleted` | saved methods | optional UI |
| `report.created` / `updated` | report generation | optional, recipe 07 |

Event list to pass as `subscribedEvents` when creating the destination: the subscription events, `transaction.completed`, `transaction.payment_failed`, `adjustment.created`, `adjustment.updated`. Add `api_key.expiring` when the owner wants the alert in-app.

## Typical sequences

- Checkout for a subscription: `transaction.created` → `customer.created` (+ `address.created`, `business.created`) → `transaction.paid` → `subscription.created` → `transaction.completed` → `subscription.updated` (Paddle fills fields). Order can differ.
- Renewal: `transaction.created` (origin `subscription_recurring`) → `transaction.paid` → `transaction.completed` → `subscription.updated` (new `current_billing_period`, `next_billed_at`).
- Failed renewal (typical, order not guaranteed): `transaction.payment_failed`, `transaction.past_due`, `subscription.past_due` + `subscription.updated`; later either `transaction.completed` + `subscription.updated` (recovered) or `subscription.canceled`.
- Scheduled cancel: `subscription.updated` with `scheduled_change.action = "cancel"`, `next_billed_at: null`; at `effective_at`: `subscription.canceled` + `subscription.updated` with `status: "canceled"`.
- Upgrade with proration: `transaction.created` (origin `subscription_update`) → `transaction.completed` → `subscription.updated`.

## Mapping an event to a user

Order of preference in `handler.ts`: `data.custom_data.user_id` (set by the app at checkout; Paddle copies it to the subscription and renewal transactions) → `paddle_customers` by `data.customer_id` → the row's existing `user_id`. If none resolves, the row is stored with `user_id` null; link on the user's next sign-in by email and re-run the resolution. Always pass `customData: { user_id }` at checkout to avoid this.

## Testing webhooks

- Simulator: `scripts/paddle-inspect.ts simulate <ntfset_…> subscription_creation|subscription_renewal|subscription_pause|subscription_resume|subscription_cancellation|<any event type>`. The destination must have `traffic_source` `simulation` or `all`. Simulated payloads use example IDs unless configured (and their `event_id`/`notification_id` start with `ntfsimevt_`/`ntfsimntf_`, not `evt_`/`ntf_`); the handler stores them like real ones, so use a dev database. Simulated deliveries do **not** appear in `client.notifications.listNotifications`; read them under the simulation run with `client.simulationRunEvents.listSimulationsEvents` (each event's `status`, `request.body`, `response.status_code`; fields: `map/operations/simulation-run-events.md`) or in Paddle > Events > Simulations.
- Local development: expose the dev server with a tunnel and create a separate destination for it; delete it when done.
- Unit tests: `templates/tests/webhook-verify.test.ts`, `templates/tests/webhook-handler.test.mts` (no network).
- Replays: `client.notifications.listNotifications` shows every delivery and its status; `client.notifications.replayNotification` resends a `delivered` or `failed` original (fields: `map/operations/notifications.md`).

## Fallback when webhooks are unavailable

If the endpoint cannot be public (some previews), poll instead: on the page after `checkout.completed`, call a server route that runs `client.transactions.getTransaction` and, when the transaction's `status` is `"completed"`, `client.subscriptions.getSubscription`, and writes the same rows the handler would. Keep the webhook as the source of truth once the app is deployed; polling misses renewals, cancellations and refunds.
