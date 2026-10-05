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
4. Checkout configuration mirrored from sandbox: payment methods, styling, Sales tax inclusive/exclusive, balance currency, taxable categories approved as needed.
5. Live API key with the same permissions as sandbox, stored by the owner as `PADDLE_API_KEY` in the production secret store (API key message in SKILL.md section 14, with the live dashboard `https://vendors.paddle.com` and prefix `pdl_live_apikey_`).
6. Payout details (bank transfer or Payoneer).

Agent, once the owner confirms 1–5:

7. Set production env: `PADDLE_ENV=production` and browser `environment: "production"`; against production, create the client-side token once with `client.clientTokens.createClientToken` (fields: `map/operations/client-tokens.md`) and set it as `PADDLE_CLIENT_TOKEN` (the live token starts with `live_`).
8. `npx tsx scripts/paddle/paddle-inspect.ts whoami` against production (prints `environment: production`).
9. Seed the live catalog with the same `paddle-catalog.json`: `paddle-seed-catalog.ts` → **new** price IDs. Update `plan_catalog` (and any env vars) with the live IDs; sandbox IDs (`pri_…`) will not exist in live.
10. Create the live destination the same way (SKILL.md section 7) with `destination: "https://app.example.com/api/paddle/webhook"` → the owner stores the secret from `paddle-webhook-secret.local` as `PADDLE_WEBHOOK_SECRET` in the production secret store (webhook-secret message, SKILL.md section 14); then delete the file. Allow live IPs if filtering (`getIpAddresses()` in production).
11. Deploy. Run a real purchase of the cheapest price with a real card; confirm the webhook row, the entitlement and the invoice email; then refund it (recipe 05; live refund may wait for approval).
12. Verify Paddle.js shows no Test Mode watermark and that `Paddle.Environment.set("sandbox")` / `environment: "sandbox"` is gone from production builds.

## What differs between environments

| | Sandbox | Live |
| --- | --- | --- |
| API base URL | `https://sandbox-api.paddle.com` | `https://api.paddle.com` |
| Dashboard | `sandbox-vendors.paddle.com` | `vendors.paddle.com` |
| API key prefix | `pdl_sdbx_apikey_` | `pdl_live_apikey_` |
| Client token prefix | `test_` | `live_` |
| Domain approval | none; `localhost` allowed | required per domain/subdomain |
| Payments | test cards only; watermark | real cards |
| Refunds | auto-approved every 10 minutes | Paddle review unless small and account verified |
| Webhook retries | 3 in 15 minutes | 60 over 3 days |
| Webhook IPs | sandbox list | live list |
| Retain | unavailable | available |
| Payouts | none | monthly |

## Rollback

Switch `PADDLE_ENV` back to `sandbox` with the sandbox secrets; the code is identical. Live subscriptions keep billing at Paddle while the app is in sandbox, so only roll back briefly and keep the live webhook destination active (events queue up to 3 days of retries; replay anything that failed).
