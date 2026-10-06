# Errors: what you will see, what to do, what people will report

Paddle's error body: `{ error: { type: "request_error" | "api_error", code, detail, documentation_url, errors?: [{ field, message }] }, meta: { request_id } }`. In the SDK: `paddleError(err)` (`templates/server/paddle/errors.ts`) → `{ status, code, detail, fieldErrors, requestId, documentationUrl }`. Branch on `code`. Log `request_id` and quote it to Paddle support. Each code has a page at `https://developer.paddle.com/errors/<group>/<code>`.

## Setup and credentials

| Code / symptom | Cause | Fix |
| --- | --- | --- |
| 403 `authentication_missing` / `authentication_malformed` | no or malformed `Authorization: Bearer` | `PADDLE_API_KEY` unset or `bearerAuth` not passed |
| 403 `invalid_token` | key wrong, expired, revoked, or sandbox key against live URL (or vice versa) | check `PADDLE_ENV` vs key prefix (`config.ts` refuses mismatches); create a new key; keys expire after 90 days by default |
| 403 `forbidden` | key lacks the permission (e.g. `transaction.write`) | create a key with the needed `entity.read/write` scopes; previews need `transaction.read` |
| 404 `not_available_in_sandbox` | endpoint live-only | test in live or skip |
| `transaction_default_checkout_url_not_set` | default payment link missing | add the domain under website approval, then set the link under Paddle > Checkout > Checkout settings (SKILL.md section 9, "Default payment link (sandbox)") |
| "Enter a valid URL" when saving the default payment link | the domain has not been added under website approval (seen in sandbox for `https://localhost`) | add the domain first; sandbox approves it at once |
| `transaction_checkout_url_domain_is_not_approved` | live `checkout.url` on an unapproved domain | submit the domain for approval; use an approved one |
| Paddle.js checkout does not open on the live site; `checkout_domain_domain_not_approved` from the Checkout domains API | domain not approved | domain approval (go-live.md) |
| Paddle.js: checkout does not open | `test_` token with `production`, or `live_` with `sandbox`; token revoked | match token to environment; both come from the same account |
| `url_notification_setting_incorrect` | webhook URL not public HTTPS | tunnel or deploy first |
| `notification_maximum_active_settings_reached` | 10 active destinations | deactivate unused ones |
| `product_tax_category_not_approved` | category other than `standard`/`saas` without approval | owner requests the category or use `saas`/`standard` |
| `customer_already_exists` | email already has a customer | `ensureCustomer` reuses by email; never create blindly |
| 429 `too_many_requests` (`Retry-After`) | > 240 req/min per IP, or preview limit | back off (SDK retries → `typescript-configuration-resilience`); cache catalog and previews |
| `concurrent_modification` | two requests changed the same entity at once | re-read the entity, then decide whether the change is still needed; do not repeat it blindly |
| `notification_setting_cannot_be_duplicate` | a destination for this URL exists | `paddle-setup.ts webhook` reuses it |

## Webhooks

| Symptom | Cause | Fix |
| --- | --- | --- |
| every delivery 401 `signature_mismatch` | body parsed before verification; wrong secret; secret from the other environment or another destination | raw body parser on the route, before `express.json()`; copy the secret from the destination actually posting |
| 401 `timestamp_out_of_tolerance` | server clock skew or slow queue before verification | sync clocks; verify before any queue; raise `PADDLE_WEBHOOK_TOLERANCE_SECONDS` modestly |
| nothing arrives | destination inactive, wrong URL, events not subscribed, firewall blocks Paddle IPs, simulation sent to a `platform`-only destination (simulated deliveries show under the simulation run's events, not in `/notifications`) | `paddle-inspect.ts webhooks` shows destinations and recent notification statuses; `client.notificationLogs.listNotificationLogs` shows the response your endpoint gave |
| events processed twice | no `event_id` dedupe | `recordEvent` insert-if-absent |
| access reverts after an upgrade | older `subscription.updated` applied after a newer one | compare `occurred_at` (handler does) |
| `paddle_webhook_events.error` set, `final_state` empty | handler threw (DB down, a hook failed) | the reprocess job retries it; fix the cause if it keeps failing |
| `final_state = 'gave_up'` | the event failed 10 times | fix the cause, then `paddle-jobs.ts reopen gave_up` |
| `final_state = 'undecodable'` | the body does not match the SDK's model for its event type | upgrade the SDK (or fix the model), then `paddle-jobs.ts reopen undecodable` |
| events recorded with error "ignored: prices not in plan_catalog" | another app on the same Paddle account, or a price missing from `plan_catalog` | add the price to `plan_catalog` if the app sells it, then `paddle-jobs.ts reopen ignored` (a replayed notification has the same `event_id` and is skipped as already processed) |

## Subscriptions and transactions

| Code | Meaning | Fix |
| --- | --- | --- |
| `subscription_items_update_missing_proration_billing_mode` | items/date changed without the mode | always send `prorationBillingMode` |
| `subscription_locked_renewal` / `subscription_locked_processing` | within 30 minutes of renewal or while processing | retry after renewal; tell the customer |
| `subscription_update_when_past_due` | unpaid renewal | customer updates payment method first |
| `subscription_update_when_trialing` / `subscription_trialing_items_update_invalid_options` | only items and `next_billed_at` with `do_not_bill` during trial | use `do_not_bill` |
| `subscription_incorrect_proration_on_paused_subscription` | paused accepts only `do_not_bill` | use `do_not_bill` or resume first |
| `subscription_next_billed_at_too_soon` | < 30 minutes ahead | pick a later time |
| `subscription_all_items_removed` / `subscription_no_recurring_items_remain` | `items` omitted the base plan | send the complete list |
| `subscription_immediate_charge_hour_limit_exceeded` / `_24_hour_limit_exceeded` | > 20/h or > 100/day one-off charges | batch usage charges |
| `subscription_missing_payment_method_cannot_*` | cardless trial or deleted method | collect a payment method (update-payment-method transaction) |
| `subscription_is_canceled_action_invalid` / `subscription_update_when_canceled` | canceled is final | new checkout |
| `subscription_scheduled_change_invalid_update` | tried to set `scheduled_change` to a value | only `null` is allowed (undo) |
| `transaction_immutable` / `transaction_invalid_status_change` | billed/completed transactions cannot change | create a new transaction or an adjustment |
| `transaction_price_different_billing_cycle` | mixed intervals in one checkout | split or align |
| `transaction_balance_less_than_charge_limit` | amount under ~70 US cents | raise the price / avoid tiny prorations |
| 400 `invalid_field` on `address_id` | `addressId` without `customerId` | pass both |
| `invalid_field` (400) with `errors[]` | validation | read `fieldErrors`; check the field and its enum values in the SDK map |
| `adjustment_transaction_invalid_status_for_refund` | transaction not `completed` | wait for completion |
| `adjustment_pending_refund_request` | refund already pending | wait for `adjustment.updated` |
| `adjustment_amount_above_remaining_allowed` | over the remaining refundable amount | read `details.lineItems[].totals` |
| `discount_code_conflict`, `discount_usage_limit_exceeded`, `discount_expired` | code state | choose another code / raise limit / new code |
| `report_not_ready`, `concurrent_report_generation_not_allowed`, `report_creation_limit_exceeded` | report lifecycle | poll; one at a time; 100/day |

## SDK-level failures (not Paddle answers)

How the SDK reports transport, decode and configuration failures → `typescript-error-handling`. Paddle-specific: `writeOutcome(err)` (`errors.ts`) sorts a failed write into refused (4xx: nothing changed), unknown (connection lost, timeout, 5xx, or a 2xx body that could not be read: re-read before anything else) and not sent (no re-read). `claimedWrite` (`writes.ts`) does this for every create; a write still unknown after the re-read raises `OutcomeUnknownError`, answered as "outcome unknown", never "failed".

## What the app answers its own callers

`toHttpAnswer(err)` (`errors.ts`), as the routing skill's table 1b.4 requires: a 4xx other than 401/403/429 keeps its status and returns Paddle's `code` and field messages (`fields`), so the caller learns what to change; Paddle's free-text `detail` goes to the log with the `request_id`. 401/403 → 502 and 429 → 503 with fixed messages (our credentials, our quota); 5xx → 502; an unknown outcome on a write → 502 with `outcome: "unknown"`.

## What owners and buyers will report, and what to say

| They say | Likely cause | Check / answer |
| --- | --- | --- |
| "I paid but nothing unlocked" | webhook not received or failed; price missing from `plan_catalog`; user not mapped (no `custom_data.user_id`, different email) | `paddle-inspect.ts customer <email>` shows the subscription; `paddle-inspect.ts webhooks` shows delivery; check `paddle_webhook_events` for the event and its `error`. Not received: replay the notification. Ignored: add the price, `paddle-jobs.ts reopen ignored`. Unmapped: the row has no user; `ensureCustomer` assigns it at the user's next sign-in |
| "My card was charged twice" | two transactions created (double click without a claim), or a renewal plus an upgrade proration | `paddle-inspect.ts customer`: two `completed` transactions? refund one (recipe 05); create checkouts through `createCheckoutTransaction` with `checkoutClaimKey` |
| "The price shows in the wrong currency / with tax added" | `tax_mode`, localization by IP, country override | explain Paddle localizes by location; set overrides or `tax_mode` (recipe 08) |
| "I cancelled but I'm still being charged" | cancel scheduled for period end and renewal happened before? or portal cancel on a different subscription | check `scheduled_change` and `canceled_at`; refund if the policy says so |
| "I cancelled and lost access immediately" | immediate cancel used | default to `next_billing_period`; restore via new checkout only |
| "Customer says they never got an invoice" | Paddle emails the customer's checkout email; spam; zero-value transaction has none | portal → invoices; `getInvoiceUrl` |
| "The refund is still 'pending'" | live refunds are reviewed by Paddle unless small and the account is verified | normal; `adjustment.updated` will arrive |
| "Checkout says domain not approved" (live) | subdomain not submitted | approve each domain/subdomain |
| "Checkout does not open on my phone's in-app browser" | third-party frames blocked | open in the system browser or use `checkout.url` |
| "Payments stopped working today" | API key expired (90 days) or revoked after exposure | `api_key.expired`/`api_key_exposure.created`; new key, redeploy |
| "Where do I see my money?" | — | the live dashboard's payouts and transactions areas; monthly payouts; fees in `payout_totals` |
