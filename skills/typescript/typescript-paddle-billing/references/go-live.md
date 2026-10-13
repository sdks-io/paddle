# Go-live: sandbox → live

Sandbox and live are separate Paddle accounts. Nothing is shared: catalog, customers, API keys, client-side tokens, notification destinations, default payment link, checkout settings. Everything created in sandbox is recreated in live.

## When to raise each step

| Moment | Raise |
| --- | --- |
| The user names the production domain (any time) | Domain approval, because it is the step that takes longest (often automatic; otherwise 5–7 business days). Each domain and subdomain that opens a checkout must be approved separately; the site must show pricing, Terms & Conditions with the company name, Refund Policy, Privacy Policy, and use HTTPS |
| The sandbox flow passes (recipe 01 step 8) | Live account signup and business/identity verification (owner only); nothing else yet |
| The user says "go live" | The checklist below |
| First live purchase succeeded | Payout details, balance currency, tax settings review, Retain/dunning settings, `api_key.expiring` alerting |

If the user is not ready, keep `PADDLE_ENV=sandbox`, keep the Test Mode watermark, and say so in the final message. Do not put a live key in a development environment.

## Checklist

Owner, in the live dashboard (`vendors.paddle.com`):

1. Live account created; business verification and identity verification complete (the owner checks verification status in the live dashboard).
2. Website approval: every checkout domain approved.
3. Default payment link set to the real page (e.g. `https://app.example.com/pay`) on an approved domain.
4. Checkout settings mirrored from sandbox: payment methods, styling, Sales tax inclusive/exclusive, balance currency, taxable categories approved as needed.
5. Live API key with the same permissions as sandbox, stored by the owner as `PADDLE_API_KEY` in the production secret store (API key message in `references/user-messages.md`, with the live dashboard `https://vendors.paddle.com` and prefix `pdl_live_apikey_`).
6. Payout details (bank transfer or Payoneer).

Agent, once the owner confirms 1–5:

7. Set production env: `PADDLE_ENV=production` and browser `environment: "production"`; against production, run `paddle-setup.ts client-token --env-file .env.production` and set `PADDLE_CLIENT_TOKEN` (the live token starts with `live_`) in the production configuration.
8. `npx tsx scripts/paddle/paddle-inspect.ts whoami` against production (prints `environment: production`).
9. Seed the live catalog with the same `paddle-catalog.json`: `paddle-seed-catalog.ts` → **new** price IDs. Update `plan_catalog` (and any env vars) with the live IDs; sandbox IDs (`pri_…`) will not exist in live.
10. Check that the catalog holds live price IDs. List the app's price IDs (`SELECT price_id FROM plan_catalog`), run `paddle-inspect.ts catalog` against production, and confirm every ID is an active price in that output. An ID left over from sandbox, or a live price with no `plan_catalog` row, means its events are recorded as ignored and its buyers get no access (`getEntitlement` grants access only for a listed price). Check price IDs held in environment variables and in frontend config the same way.
11. Recreate discounts in live. Discounts and their codes are not shared with sandbox. Create each one again (`createDiscountCode` in `templates/server/paddle/backoffice.ts`, or Paddle > Catalog > Discounts), replace every `dsc_…` ID the app stores or passes to checkout (`discountId`), and confirm each code applies in the step 13 test purchase.
12. Create the live destination the same way (`references/credentials.md`): `paddle-setup.ts webhook https://app.example.com/api/paddle/webhook --env-file .env.production`. Put `PADDLE_WEBHOOK_SECRET` from that file into the production secret store without printing it (with the platform's secret tooling; where only the owner can set production secrets, ask them to copy it from the file), then delete the file. Allow live IPs if filtering (`getIpAddresses()` in production).
13. Deploy. Run a real purchase of the cheapest price with a real card; confirm the webhook row, the entitlement and the invoice email; then refund it (recipe 05; live refund may wait for approval).
14. Verify Paddle.js shows no Test Mode watermark and that `Paddle.Environment.set("sandbox")` / `environment: "sandbox"` is gone from production builds.

## What differs between environments

| | Sandbox | Live |
| --- | --- | --- |
| API base URL | `https://sandbox-api.paddle.com` | `https://api.paddle.com` |
| Dashboard | `sandbox-vendors.paddle.com` | `vendors.paddle.com` |
| API key prefix | `pdl_sdbx_apikey_` | `pdl_live_apikey_` |
| Client token prefix | `test_` | `live_` |
| Domain approval | add the domain; approved at once | required per domain/subdomain; Paddle reviews the site |
| Payments | test cards only; watermark | real cards |
| Refunds | auto-approved every 10 minutes | Paddle review unless small and account verified |
| Webhook retries | 3 in 15 minutes | 60 over 3 days |
| Webhook IPs | sandbox list | live list |
| Retain | unavailable | available |
| Payouts | none | monthly |

## Rollback to sandbox

Going back to sandbox is a configuration change, but the database does not record which environment a row belongs to (live and sandbox rows share every table), so check for live data first.

1. Switch the configuration together: `PADDLE_ENV=sandbox`, the sandbox API key, client-side token (`test_…`) and webhook secret, the sandbox webhook destination, and `environment: "sandbox"` in the browser.
2. Add the sandbox price IDs to `plan_catalog` next to the live rows. Do not delete or deactivate the live rows: `getEntitlement` grants access only for a listed price, so removing them locks out paying live subscribers. Price IDs differ between the two accounts, so the rows do not clash.
3. If no live purchase has happened, that is all. If live customers exist, expect this while the app runs in sandbox: live webhook deliveries fail verification (the secret differs), and Paddle retries them for up to 3 days and then stops, so the mirror of live subscriptions goes stale; server-created checkouts and portal sessions use the stored live customer ID (`ensureCustomer`) and fail for a user linked to a live customer, so test with new users; and sandbox test data lands in the same tables. If live customers must keep working, keep production on live and run sandbox as a separate deployment with its own database.
4. When you return to live, restore the live configuration and replay what was missed. A delivery that failed verification was never recorded here, so replay it from Paddle (`client.notifications.replayNotification`, or Paddle > Events > Notifications), then run `paddle-jobs.ts reprocess` for anything recorded but unprocessed.
