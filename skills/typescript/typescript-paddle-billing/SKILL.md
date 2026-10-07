---
name: "typescript-paddle-billing"
description: "End-to-end flows for putting Paddle Billing into a Node/TypeScript app with the paddle-apimatic-sdk: SaaS subscriptions (plans, trials, upgrades, seats, pause, cancel, customer portal), one-time purchases, usage and credit billing, refunds and credits, discount codes, reports and metrics, and the merchant-of-record parts (tax handled by Paddle, Paddle-issued invoices and credit notes, localized prices). Load this when a user wants to sell, charge, subscribe, monetize, paywall, or refund through Paddle, or asks how Paddle checkout, webhooks or entitlements should be wired. It gives the order of work, the files to create, the webhook and access-control rules, sandbox→live steps, and ready templates. It does not replace typescript-integrate-paddle-api (the SDK workflow) or the typescript-* companions (how to call the SDK); it tells you WHAT to build and in which order."
---

# Paddle Billing: integration flows for a Node/TypeScript app

This skill is the use-case layer for Paddle. `typescript-integrate-paddle-api` stays the entry point for any SDK work and its rules (plan file, contract sheet, lookups in the SDK map) still apply. Load `typescript-getting-started` for signatures and the other `typescript-*` skills at the steps they govern. Every SDK call in this skill's templates was type-checked against `paddle-apimatic-sdk` 0.0.4 (sdk-map 0.0.4) with `strict`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` and `noUncheckedIndexedAccess`, and webhook payloads are decoded with that SDK's webhook models; after a version bump, re-check the names in `map/operations/*.md` before trusting a template.

Paddle Billing only. Paddle Classic (vendor IDs, `vendors.paddle.com/api/2.0`) is a different product and is not covered.

## 1. What this skill builds

User goals it serves, in business terms:

| Goal | Recipe | Default or on request |
| --- | --- | --- |
| Charge a monthly or yearly subscription for a web app, with or without a free trial; let customers upgrade, downgrade, change seats, pause and cancel; show invoices | `references/recipes/01-saas-subscriptions.md`, `04-subscription-changes.md` | Default when the user wants recurring revenue |
| Sell something once: a lifetime licence, a download, an add-on | `references/recipes/02-one-time-purchase.md` | On request |
| Bill for usage: seats, metered overage, prepaid credit packs | `references/recipes/03-usage-and-credits.md` | On request. Paddle has no native metering (see section 4); only the patterns listed there are correct |
| Refund or credit a customer, issue a credit note | `references/recipes/05-refunds-and-credits.md` | On request, usually after launch |
| Offer discount codes and promotions | `references/recipes/06-discounts.md` | On request |
| Export sales data, show MRR and subscriber counts to the owner | `references/recipes/07-reports-and-metrics.md` | On request |
| Sell worldwide with tax handled by Paddle, show tax-inclusive localized prices, give customers Paddle's invoices | `references/recipes/08-merchant-of-record.md` | Always part of setup: Paddle is the seller of record for every sale |

Pricing models Paddle supports and this skill sets up: one-time prices; recurring prices with `billing_cycle` of day, week, month or year at any frequency; free trials (card captured, no charge), paid trials, cardless trials; per-seat quantity on a price; localized price overrides per country; tax-inclusive or tax-exclusive display. All recurring items on one subscription must share one billing interval (no yearly plan plus a monthly add-on on the same subscription).

What Paddle does and what the app builds:

- **Paddle does:** hosted checkout (overlay or inline via Paddle.js), payment methods and 3-D Secure, tax calculation and remittance worldwide, invoices, receipts and credit notes by email, the customer portal (invoices, payment method update, cancel), dunning retries, refunds and chargebacks, payouts to the owner.
- **The app builds:** the pricing page and buy buttons, the server route that creates a transaction or portal session, the webhook endpoint, the entitlement check, and the few tables that mirror subscription status.

App contexts: a web app (any Node/TS backend, any frontend); a Next.js app (route handlers; a Node runtime for the webhook); an app on a hosting platform that supplies the secret store, database and domain (per-platform notes: `references/adapters.md`). Native mobile in-app purchases are not a Paddle use case; iOS "link-out" to a web checkout exists but is out of this skill's scope.

## 2. When to use Paddle, and when not

Use Paddle when the user wants to sell software, SaaS, digital goods or AI usage online and does not want to register for VAT/sales tax in each country, or when they explicitly ask for Paddle or for a merchant of record. Alternatives: a payment processor such as Stripe when the owner wants to be the seller of record, handle tax themselves, run a marketplace with payouts to third parties, or sell physical goods; App Store / Google Play billing (or a mobile subscription platform) for native in-app purchases; another merchant of record (Polar, Lemon Squeezy and similar) only when the user already uses it. Do not use Paddle for physical goods with shipping, for marketplaces that pay out to third-party sellers, or for native in-app purchases. If the user names another provider, or the project already contains that provider's keys, follow that provider. If your platform has a payment-provider router skill, let it decide first; this skill does not reopen that choice.

Out of scope here: Paddle Classic, Paddle Retain configuration beyond pointing at it, B2B pay-by-invoice (manual collection) flows, mobile link-out, migrating subscriptions from another provider. When the user asks for one of these, say that this skill does not cover it, give the Paddle docs section that does, and ask before building.

## 3. How to work (read before step 1)

- **Fetch yourself:** price and product IDs (`scripts/paddle-inspect.ts catalog` or the seed script output), the client-side token and the webhook destination (`scripts/paddle-setup.ts`, which reuses what exists), event names (`client.eventTypes.listEventTypes()`), the account's environment. Never ask the user to paste an ID the API can give you.
- **Credentials are the exception: the user provides them, never through chat.** The user creates the API key in the Paddle dashboard and puts it, and the webhook secret, into the platform's secret store (section 7). Never ask the user to paste a key or secret into the conversation; if they do, tell them to revoke that key and create a new one.
- **Ask the user:** which plans to sell, names, amounts, currency, billing period, trial length, whether yearly exists, what paid tier unlocks, the refund policy wording for the website, and where the app is deployed (for the webhook URL and domain approval). Ask these in one message before creating anything. When the request names no prices, ask for them before seeding; do not pick prices yourself. If nobody can answer (an unattended run), seed sandbox only with the suggestions in section 13, label them as placeholders in `paddle-api-plan.md`, and list them first in the final message so the user confirms or replaces them before anything goes live.
- **Stop and ask before:** creating anything in a live account, charging a real card, refunding, cancelling a subscription immediately, deleting a notification destination, or archiving a product that has subscriptions.
- **Track the work** in `paddle-api-plan.md`, the one plan `typescript-integrate-paddle-api` has you write, in the order of section 9. Do not skip the webhook step to "do it later": without it nobody gets access.
- **Before the plan exists** (the routing skill's gate: no project files yet), only read-only work runs, and it runs from your scratchpad: copy `templates/server/paddle/{config,client,errors,pagination}.ts` to `<scratchpad>/server/paddle/` and `scripts/paddle-inspect.ts` to `<scratchpad>/scripts/paddle/`, install `paddle-apimatic-sdk` there, and run `npx tsx --env-file=<project>/.env scripts/paddle/paddle-inspect.ts whoami` (and `catalog`) from `<scratchpad>`. Everything that writes (the seed script, `paddle-setup.ts`, any project file) waits until the plan's contract sheet is complete.
- **Read references at the step that needs them,** not all at once. Each step below names its file.
- **Stop only the processes you started** (the dev server, a tunnel), by their PID. Never kill every Node process on the machine: other apps, tunnels and tools on it may run on Node.
- **If something does not match** (an ID prefix differs, a call returns a status this skill does not list, a webhook arrives with fields you do not expect), stop, show the user the raw response with the `request_id`, and do not improvise a workaround.
- **A stage is done when:** (setup) the sandbox checkout completes with a test card, the webhook row appears in `paddle_webhook_events`, and the entitlement endpoint returns `hasAccess: true` for that user; (go-live) the live checklist in `references/go-live.md` is complete.
- **A request Paddle cannot fulfil** (for example native metering, deleting a product, reinstating a canceled subscription): say so, give the closest supported pattern from section 4, and let the user choose. Do not silently substitute.

## 4. Capabilities and limits

Supported through the API and Paddle.js: products, prices (one-time, recurring, trials, per-seat quantity, localized overrides), customers/addresses/businesses, transactions (checkout, invoices, previews, revisions), subscriptions (update items, proration, pause/resume/cancel, one-off charges, payment method update), adjustments (refund, credit), discounts and discount groups, customer portal sessions, pricing previews, notification destinations, webhook simulations, events/notifications/logs, reports (CSV), metrics, client-side tokens, IP allowlist.

Not supported, with the correct alternative:

| Not available | Do this instead |
| --- | --- |
| Native usage metering, usage records, credit meters (Paddle says these are in development) | Seats as `quantity`; one-off charges for overage; add a one-time charge to the next renewal; sell prepaid credit packs and keep the balance in the app (recipe 03) |
| Deleting products, prices, customers, transactions, subscriptions, discounts | Archive (`status: "archived"`); only notification destinations, saved payment methods and checkout domains can be deleted |
| Creating a subscription directly via API | A completed checkout (Paddle.js or `checkout.url`), a billed manual invoice, or, for a cardless trial, a transaction created with `status: "billed"` (recipe 01) creates it |
| Reinstating a canceled subscription | The customer buys again; undo a *scheduled* cancel with `updateSubscription({ subscriptionId, body: { scheduledChange: null } })` before it takes effect |
| Changing a subscription while `past_due` or within 30 minutes of renewal | Wait for payment recovery or the renewal; show the user why |
| Mixed billing intervals on one subscription | Separate subscriptions, or align intervals |
| Refund without review on live | Expect `pending_approval`; sandbox auto-approves every 10 minutes |
| Idempotency key on POST | Paddle: "The Paddle API doesn't currently support client-supplied idempotency keys". Sending an `Idempotency-Key` header (the SDK adds one to every write) does not make a repeated Paddle write safe, so never add POST or PATCH to the SDK's retried methods. Creates use the claim pattern in `templates/server/paddle/writes.ts`; state-setting updates are re-read after an unknown outcome |
| Scheduling a plan or price change for the next renewal | `scheduled_change` only covers cancel, pause and resume. The app keeps the change and applies it shortly before the renewal (recipe 04, "Change at the end of the term") |
| Crediting a card (automatically-collected) transaction, or adding to a customer's credit balance | Credits apply only to invoices; Paddle fills credit balances only from prorations. Goodwill for a card subscription: a partial refund, or a one-cycle discount (`grantGoodwillDiscount`, recipe 05) |
| Locking the quantity in Paddle.js checkout | Set the price's `quantity` limits (the seed script defaults to 1–1), or open a server-created transaction; enforce seat counts in the app (recipe 01, "Seats") |

Limits that shape the build: 240 API requests/min per IP (429 with `Retry-After`); 1,000/min for pricing and transaction previews; 20 immediate subscription charges per hour and 100 per day per subscription; 10 active webhook destinations; `client.transactions.listTransactions` returns at most 30 per page, adjustments 50, other lists 200; 100 reports per 24 hours; API keys expire (default 90 days, max 1 year); customer emails must be unique; webhooks, events and notification logs are kept 90 days; invoice and credit-note PDF URLs expire after one hour, report CSV URLs after 3 minutes.

## 5. Domain model

| Paddle term | Meaning |
| --- | --- |
| Product (`pro_`) | What you sell; carries the `tax_category` |
| Price (`pri_`) | An amount, currency, and optional `billing_cycle`/`trial_period` for a product; `quantity.minimum/maximum` bound seats |
| Customer (`ctm_`), Address (`add_`), Business (`biz_`) | The buyer; address decides tax; business adds a tax ID for B2B invoices |
| Transaction (`txn_`) | One billing event: a checkout, a renewal, an upgrade charge, an invoice. Statuses `draft → ready → billed → paid → completed`, or `canceled`/`past_due` |
| Subscription (`sub_`) | Recurring billing created by a completed checkout with recurring items. Statuses `trialing`, `active`, `past_due`, `paused`, `canceled` |
| Adjustment (`adj_`) | A refund or credit against a transaction; Paddle also records chargebacks here |
| Discount (`dsc_`) | Percentage, flat or flat-per-seat; optional code; may recur |
| Notification destination (`ntfset_`), Event (`evt_`), Notification (`ntf_`) | Webhook endpoint; a thing that happened; one delivery attempt of it |
| Client-side token (`test_`/`live_`) | Public token for Paddle.js; can only open checkouts and preview prices |
| API key (`pdl_sdbx_apikey_`/`pdl_live_apikey_`) | Server secret with granular permissions |

Purchase → access: the browser opens a checkout for a price → Paddle creates a transaction (and, for recurring items, a subscription) → Paddle posts `transaction.completed` and `subscription.created`/`subscription.updated` to your webhook → the webhook handler writes `paddle_subscriptions` / `paddle_purchases` → every paid route checks those rows (`entitlements.ts`). Nothing in the browser grants access.

## 6. Prerequisites and packages

Install, in the package that runs the server (for a monorepo: the API server package, not the root):

```bash
npm install paddle-apimatic-sdk@^0.0.4   # server: Paddle API and webhook models
npm install pg && npm install -D @types/pg   # server: store.pg.ts (skip if the project's ORM implements PaddleStore)
npm install @paddle/paddle-js            # browser: Paddle.js loader with types (frontend package in a monorepo)
npm install -D tsx                       # to run the scripts in scripts/paddle/
```

The hosting platform supplies: a secret store for the env vars, a PostgreSQL (or other) database, HTTPS, and a stable deployment URL for the webhook; the agent does not build these. Also required before step 1: a Paddle **sandbox** account (`sandbox-vendors.paddle.com`); a database (the tables in `templates/db/schema.sql`); an HTTPS URL for the webhook (a tunnel such as ngrok for local development). Do not write app code until these exist; a webhook you cannot receive leaves the integration incomplete.

## 7. Credentials and environment

Four values connect the app to Paddle. Who creates each one, and where it goes:

| Credential | Created by | Stored as | Stored by |
| --- | --- | --- | --- |
| API key (`pdl_sdbx_apikey_…`) | **The user**, in the Paddle dashboard. Paddle has no API that creates API keys, and the agent has no key before this step. | `PADDLE_API_KEY` in the platform's secret store | **The user** |
| Client-side token (`test_…`) | **The agent**, once the API key works: `paddle-setup.ts client-token` reuses or creates it (`client.clientTokens`; fields: `map/operations/client-tokens.md`) | `PADDLE_CLIENT_TOKEN` in `.env`, plus the frontend's public name (`--public-var`) | **The agent** (the script). The token is public by design: it can only open checkouts and preview prices |
| Webhook secret (`pdl_ntfset_…`) | **The agent**, once the webhook URL is public: `paddle-setup.ts webhook <url>` reuses the destination for that URL or creates it, with `trafficSource: "all"` and the event list in `references/webhooks.md` (`client.notificationSettings`; fields: `map/operations/notification-settings.md`) | `PADDLE_WEBHOOK_SECRET` in `.env` (git-ignored, owner-only permissions). On a platform that reads secrets only from its own store, move it there (`references/adapters.md`) | **The agent** (the script). The script writes the secret and never prints it; never echo, `cat` or log `.env`, and never paste the secret into chat |
| Environment (`sandbox` / `production`) | **The agent** | `PADDLE_ENV`, a plain env var | **The agent**. Starts as `sandbox` |

Order: (1) send the user the API key message from section 14 and wait for "done"; (2) run `paddle-inspect.ts whoami`, which proves the key works without the agent ever seeing it; (3) run `paddle-setup.ts client-token`; (4) once the webhook URL exists (section 9 step 4), run `paddle-setup.ts webhook <url>` and restart the server so it reads the secret.

API key permissions (the user ticks these when creating the key; write includes read):

| Permission | Needed for |
| --- | --- |
| `product.write`, `price.write` | the seed script creates and updates the catalog |
| `customer.write`, `address.write` | `ensureCustomer`, addresses for invoices and cardless trials |
| `transaction.write` | server-created checkouts, invoice PDFs, previews |
| `subscription.write` | plan changes, cancel, pause, one-off charges |
| `customer_portal_session.write`, `customer_auth_token.write` | portal links, saved payment methods at checkout |
| `client_token.write` | the agent creates the client-side token |
| `notification_setting.write`, `notification.read`, `notification_simulation.write` | webhook destination, delivery checks, simulations |
| `adjustment.write` (refunds), `discount.write` (discount codes), `report.write` and `metrics.read` (back-office) | only when those recipes are in scope |

A missing permission returns 403 `forbidden`; the fix is a new key with that permission, created by the user.

Server env vars (names are fixed; `templates/server/paddle/config.ts` reads them and fails fast on a mismatch; wiring the base URL into the client → `typescript-configuration-resilience`, failing on a missing key → `typescript-authentication`):

| Var | Value |
| --- | --- |
| `PADDLE_ENV` | `sandbox` or `production`; `client.ts` maps it to `ServerEnvironment.Sandbox` (`https://sandbox-api.paddle.com`) or `ServerEnvironment.Production` (`https://api.paddle.com`) |
| `PADDLE_API_KEY` | `pdl_sdbx_apikey_…` in sandbox, `pdl_live_apikey_…` in production; a key from the other environment is refused at startup |
| `PADDLE_WEBHOOK_SECRET` | `pdl_ntfset_…` of the destination for this deployment |
| `PADDLE_API_URL` | optional override of the base URL of the selected environment |
| `PADDLE_WEBHOOK_TOLERANCE_SECONDS` | optional; maximum age of a webhook signature (default 5) |
| `DATABASE_URL` | the PostgreSQL database `store.pg.ts` and `paddle-jobs.ts` use (or the project's own connection setting) |

Browser var (public, with the framework's public prefix): `PADDLE_CLIENT_TOKEN` = `test_…` or `live_…`, plus `PADDLE_ENV` for `initializePaddle({ environment })`.

Rules: secrets are read from the environment or the platform's secret store at runtime, never written in source, config files, chat messages or logs; the API key never reaches the browser bundle (Paddle also blocks API calls from browsers); sandbox and live are separate accounts with separate keys, tokens, catalog and destinations; API keys expire, so subscribe to `api_key.expiring` or put a calendar reminder, and rotate by creating the new key, deploying it, then revoking the old one.

## 8. Agent-side tooling

Copy `scripts/` to `scripts/paddle/` in the project and run with `npx tsx --env-file=.env scripts/paddle/<name>.ts` (drop `--env-file` where the platform sets the env vars itself). They read the same env vars as the app, so credentials never pass through chat; the one secret a script produces (the webhook endpoint secret) is written to `.env`, never printed.

| Script | Use |
| --- | --- |
| `paddle-inspect.ts whoami` | confirm key, environment and reachability (lists event types) |
| `paddle-setup.ts client-token [--public-var <NAME>]` | reuse or create the client-side token; writes `PADDLE_CLIENT_TOKEN` to `.env` |
| `paddle-setup.ts webhook <https url>` | reuse or create the webhook destination for that URL; writes `PADDLE_WEBHOOK_SECRET` to `.env` without printing it |
| `paddle-jobs.ts reprocess \| reopen undecodable\|gave_up\|ignored \| plan-changes` | the scheduled jobs, once: re-run unprocessed webhook events; reopen parked ones (after an SDK upgrade or a fix) or ignored ones (after adding a price to `plan_catalog`); apply end-of-term plan changes now due |
| `paddle-jobs.ts claims \| settle-claim <key> <id> \| release-claim <key>` | writes whose outcome stayed unknown: list them, then, after checking Paddle (`paddle-inspect.ts`), record what exists or release the claim so a retry may write |
| `paddle-seed-catalog.ts <catalog.json>` | create or update products and prices idempotently (`custom_data.seed_key`); prints `{ products: { key: pro_… }, prices: { key: pri_… } }` |
| `paddle-inspect.ts catalog \| customer \| subscription \| transaction \| webhooks` | read-only lookups during setup and support |
| `paddle-inspect.ts simulate <ntfset_id> <event or scenario>` | send a simulated webhook to the destination |

Read the usage block at the top of a script before running it (arguments, side effects). All scripts exit non-zero and print Paddle's `code`, `detail` and `request_id` on failure; never treat a script that printed an error as having worked. For any Paddle call the scripts do not cover, look the operation up in the SDK map before calling it.

## 9. Build: project structure, order and files

Abstract names used by the templates and recipes:

| Name | Default path | Notes |
| --- | --- | --- |
| server module directory | `server/paddle/` (Next.js: `lib/paddle/`; monorepo: `apps/api/src/paddle/`) | all files from `templates/server/paddle/` |
| scripts directory | `scripts/paddle/` | from `scripts/`; imports `../../server/paddle/*` — adjust the relative path if you place them elsewhere |
| web directory | wherever frontend code lives | `templates/web/*` |
| tests directory | `tests/paddle/` | `templates/tests/*`; imports `../../server/paddle/*` |
| run a script | `npx tsx <file>` | or the project's own runner |

Templates import each other with `.js` extensions; keep that or adjust to the project's module settings (→ `typescript-client-initialization`); do not rename exports.

Build in this order. Each step names what it needs from the previous one.

1. **Config and client** — copy `config.ts`, `client.ts`, `errors.ts`, `pagination.ts`, `writes.ts`. Set the env vars. Run `paddle-inspect.ts whoami`. Done when it prints the environment and an event-type count.
2. **Catalog** — ask the user for plans (section 3), write `paddle-catalog.json`, run the seed script. Done when it prints price IDs. Prices and names are never copied into code or tables; only the IDs are.
3. **Database** — run `templates/db/schema.sql` (idempotent) with the project's migration tool and copy `store.ts` and `store.pg.ts` (PostgreSQL with `pg`). With an ORM, port `store.pg.ts` to it and keep the semantics in `store.ts`; never ship `store.memory.ts`. Then insert one `plan_catalog` row for **every price the app sells**, recurring and one-time, with the tier key and features the app needs: webhook events whose prices are not listed there (and whose products are not those rows' products) are treated as another app's and ignored. Do not share a product with another app on the same Paddle account.
4. **Webhook endpoint** — copy `webhooks/*` (verification is written by hand: "Inbound webhooks" in `typescript-client-initialization`). Put the app's reactions (emails, credits, licence keys, the owner alert in `onEventNeedsAttention`) in the hooks of `webhooks/setup.ts`, and build the handler only with `createPaddleWebhookHandler(store)`, in the route and in the jobs alike, so a re-run event behaves like a live one. Mount it with `webhooks/express.ts` or `webhooks/nextjs.ts` using the RAW body. Expose it over HTTPS, run `paddle-setup.ts webhook https://<host>/api/paddle/webhook`, restart the server. Schedule the reprocess job: `startReprocessLoop(handler, store)` in the server process, or `paddle-jobs.ts reprocess` every 5 minutes from the platform's scheduler. Done when `paddle-inspect.ts simulate <ntfset_id> subscription_creation` produces rows in `paddle_webhook_events` with `processed_at` set and no `final_state`. Read `references/webhooks.md` for the event rules.
5. **Entitlements and routes** — copy `entitlements.ts` and `routes.express.ts` (or port its handlers to the project's router; Next.js: one route handler per path). It gives `/api/billing/entitlement`, `/catalog`, `/checkout`, `/portal`, `/invoices/:id`, `/subscription/:id/change|change-at-renewal|cancel|undo-scheduled-change|payment-method`, each with an ownership check and the write-to-Paddle / read-from-mirror split. Guard paid routes with `requireTier`. Done when an unpaid user gets `hasAccess: false`.
6. **Checkout** — copy `checkout.ts` (server) and `templates/web/paddle-browser.ts` (+ `PaddleCheckoutButton.tsx` for React). Set the **default payment link** (sandbox: see "Default payment link" below) and serve `templates/web/pay.html` at that path; transactions cannot be created without it, and inline checkout needs it. Done when a sandbox checkout with card `4242 4242 4242 4242`, any future expiry, CVC `100` completes and the entitlement changes to true once the webhook is processed.
7. **Customer portal and invoices** — the routes from step 5; link "Manage billing" (`/portal` → `overviewUrl`) and "Invoices" in the account page. Done when the portal opens for a test customer.
8. **Subscription changes (if asked)** — `subscriptions.ts` and recipe 04 (schedule `paddle-jobs.ts plan-changes` every 15 minutes when changes at the end of the term are offered). **Refunds, discounts, reports (if asked)** — `adjustments.ts`, `backoffice.ts`, recipes 05–07.
9. **Tests** — copy `templates/tests/*` (they run without network: the handler, the store contract, the write paths with a fake `fetch`, signature verification) and port them to the project's test runner (→ `typescript-testing`). Run `store.test.mts` against the real store implementation (`DATABASE_URL` for `store.pg.ts`).
10. **Go-live** — only when the user says the app is ready: `references/go-live.md`.

**Default payment link (sandbox).** Paddle's docs say sandbox accepts `https://localhost/` and needs no website approval. In testing (October 2026) the sandbox dashboard refused `https://localhost` and `https://localhost/pay` ("Enter a valid URL") until a domain had been added under website approval; sandbox approval was instant. So: (1) add the domain the app runs on (a tunnel or dev host, or a placeholder such as `example.com` while testing locally) under website approval (**Paddle > Checkout > Website approval**; some dashboards show it under **My account > Settings**); (2) set the link under **Paddle > Checkout > Checkout settings** (Paddle's docs call this screen "Checkout configuration"; **Hosted checkouts** is a different screen) to the page that serves `pay.html`, for example `https://<host>/pay`. Both are dashboard-only: send the user the default-payment-link message from section 14.

Startup order inside the app: load config (fails fast on bad env) → connect the database and run migrations → register the webhook route with the raw-body parser **before** `express.json()` → register other routes → start listening. Wrong order: `express.json()` first makes every webhook fail signature verification with `signature_mismatch` even though the secret is right. Do not create Paddle entities at startup; the seed script and the one-time client-token and destination calls are run by the agent, once, on purpose.

Client wrapper (`client.ts`): construction and lifetime → `typescript-client-initialization`; retries → `typescript-configuration-resilience`; errors → `typescript-error-handling`. Paddle-specific: the client is server-only; Paddle documents no idempotency key, so a repeated POST is a second write. If the project has an OpenAPI contract or a typed client for its own routes, add the billing routes (`/api/billing/entitlement`, `/api/billing/checkout`, `/api/billing/portal`, `/api/paddle/webhook`) there and regenerate, as the project does for its other routes.

## 10. Data ownership and storage

Paddle is the source of truth for products, prices, customers, transactions, subscriptions, adjustments and discounts. The app stores: the user → `ctm_` link; the subscription mirror needed for access decisions (id, status, price/product IDs, quantity, period dates, scheduled change, `occurred_at` of the last applied event); completed one-time purchases, one row per purchased line with its refund mark; every webhook `event_id` with its processing state; claims for provider writes; pending end-of-term plan changes; its own attributes for every price it sells (`plan_catalog`: tier key, features, display order) keyed by `pri_`. Mirror rows change only through webhooks. Reads for display (amounts, names, next invoice) come from Paddle, cached for minutes.

A notification destination receives every event of the Paddle account, not only this app's: several apps (or a staging and a production deployment) on one account each receive all of them. `plan_catalog` is how the handler tells them apart: events whose prices are not listed are recorded and ignored, and access needs a listed tier. Prefer one Paddle account per app; a staging copy should use its own sandbox account.

Wrong: a `plans` table with `price_cents`, `interval`, `name` copied from Paddle, read by the pricing page and the access check. Right: `plan_catalog(price_id, tier_key, features)` plus `listCatalog()` / Paddle.js `PricePreview` for what to display. Small flags can live in Paddle `custom_data` on the price or product instead; it is copied from checkout → transaction → subscription → renewal transactions, so `custom_data.user_id` set at checkout is how a webhook finds your user.

## 11. Frontend wiring

- A **buy button** calls `openCheckout` (Paddle.js overlay) with the price ID, `customData.user_id`, and the customer's `id` (when linked) or `email`. No server round-trip is needed for a plain price. Use a server-created transaction (`createCheckoutTransaction` → `openTransactionCheckout`) when the server must fix items, seats or custom data.
- **After payment**, `checkout.completed` fires in the page: show "setting up your account" and poll `/api/billing/entitlement` until `hasAccess` is true (`PaddleCheckoutButton.tsx`). Never unlock from the event or from `successUrl`.
- **Pricing page** amounts come from `PricePreview` (localized, tax-aware) or `listCatalog()`; never typed into JSX. `PricePreview` shows the recurring price even when the price has a trial; a transaction preview of a trial price totals 0 unless `ignoreTrials: true`.
- **Manage subscription**: link to the portal session's `overviewUrl`; for in-app cancel/upgrade call your own routes that use `subscriptions.ts`. Payment method update (and adding a card to a cardless trial): portal link, or `POST /api/billing/subscription/:id/payment-method` → `openPaymentMethodCheckout(config, transactionId)`, which uses the one-page checkout Paddle requires for cardless trials.
- **Caveats**: Paddle.js must load from `https://cdn.paddle.com` (the npm wrapper does this; do not bundle it); `Paddle.Initialize` runs once per page (`getPaddle` is idempotent); inline checkout renders only the payment form, so draw the order summary yourself from `checkout.loaded`/`checkout.updated`; a token from the other environment will not open checkouts (`test_` belongs with `sandbox`, `live_` with `production`); preview iframes and some in-app browsers block third-party checkout frames, so test in a real browser tab.

## 12. Operate: access control, reliability, errors, data shapes

**Access control** is `entitlements.ts`, server side, per request or cached for seconds: `active`, `trialing`, `past_due` grant access; `paused`, `canceled` do not; a scheduled cancel keeps access until `effective_at`. Check the tier (`requireTier(store, userId, "pro", ["starter","pro"])`), not merely "has a subscription". One-time purchases: `hasPurchased(store, userId, productId)`. Nothing from the browser is proof of payment.

**Reliability**: SDK retries, timeouts and safe writes → `typescript-configuration-resilience`. Paddle-specific: every create goes through `claimedWrite` (`writes.ts`): a claim under a key every caller computes the same, then the SDK call; a refusal releases the claim, an unknown outcome is re-read by the reference the write carried and is reported as "unknown", never "failed". State-setting updates (change items, cancel, pause, remove a scheduled change) are re-read after an unknown outcome. Cache `listCatalog` and price previews for a few minutes per (price, country). Paddle documents no bulk endpoints: one entity per call, back off on 429; batch usage into few one-off charges (20 immediate charges per hour, 100 per day per subscription). Allow Paddle's webhook IPs if you filter inbound traffic (`client.ipAddresses.getIpAddresses`).

**Webhook delivery**: at-least-once and unordered: dedupe on `event_id`, apply by `occurred_at`. The adapters process before answering (keep hooks well under Paddle's 5-second wait), so a failure answers 500 and Paddle retries (live 60 times over 3 days, sandbox 3 times in 15 minutes, then it stops). The reprocess job re-runs what is still unprocessed, parks an event after 10 failed attempts ("gave_up") and reports it. A body that does not match the SDK model is parked at once ("undecodable"), answered 200 so Paddle does not retry it, and reported through `onEventNeedsAttention`; after an SDK upgrade, `paddle-jobs.ts reopen undecodable` applies them.

**Errors**: SDK error handling → `typescript-error-handling`. Paddle error codes and fixes → `references/errors.md`. Log `request_id` with every failure. If the key is revoked or expired, stop calling Paddle, tell the owner "payment provider credentials need renewal", and never fall back to granting access.

**Data shapes**: SDK shapes → the SDK map (`typescript-getting-started`) and `typescript-models`. Paddle-specific: money is a string in minor units (`"1900"` = $19.00; JPY, KRW, CLP, VND have none); webhook bodies are decoded with the SDK's webhook models (`subscriptionUpdatedRequestSchema` and the others; `webhooks/types.ts`), so handler code reads camelCase fields and `Date` values; `items` on update calls is the complete desired list (omitted items are removed); discount `amount` is a string even for percentages (`"10"` = 10%); `transaction.paid` is not `completed`; `scheduled_change`, `next_billed_at`, `current_billing_period`, `paused_at`, `business_id`, `discount` and a transaction's `checkout.url` are `null` when not applicable.

## 13. Lifecycle: day-2, testing, go-live, compliance, pricing

**Day-2**: the owner changes prices, names, trials and discount codes in Paddle > Catalog with no deploy; the app picks them up because it reads Paddle. A new plan needs one `plan_catalog` row (events and access for prices not listed there are ignored) — code only if the feature set changes. After adding a row for a price that already sold, run `paddle-jobs.ts reopen ignored` so its earlier events are applied. For later changes the agent runs `paddle-inspect.ts` to look IDs up and writes a fresh small script; it never reuses the seed file or IDs quoted in earlier chat. Revenue, customers, transactions, payouts, refunds and tax reports are in the Paddle dashboard (`vendors.paddle.com` / `sandbox-vendors.paddle.com`); `backoffice.ts` fetches metrics and CSV reports if the app must show them. Further operations: `sdk-map.md` → `map/operations/*.md`.

**Testing**: sandbox only until go-live. Test cards: `4242 4242 4242 4242` (no 3DS), `4000 0038 0000 0446` (3DS challenge), `4000 0000 0000 0002` (declined), any future expiry, CVC `100`. Checkout shows a "Test Mode" watermark. Sandbox differences: website approval is instant (but the domain must be added; see "Default payment link (sandbox)", section 9), refunds are approved automatically every 10 minutes, webhook retries 3× in 15 minutes, Retain unavailable, and the Metrics API is not available (404 `not_available_in_sandbox`). Transaction previews of a price with a trial return 0 unless `ignoreTrials: true` (the first charge is at trial end). Use `paddle-inspect.ts simulate` for webhook scenarios (`subscription_creation`, `subscription_renewal`, `subscription_cancellation`, …). Automated tests: `templates/tests/*` plus your store tests; integration tests → `typescript-testing`.

**Go-live** (`references/go-live.md`): separate live account; owner completes business and identity verification and **domain approval** for every domain and subdomain that opens a checkout (auto-approved often, otherwise 5–7 business days; the site must show pricing, terms, refund policy, privacy policy, company name, over HTTPS); recreate catalog, API key, client token, destination and default payment link in live; set `PADDLE_ENV=production` and live secrets; re-run `whoami` and a real small purchase, then refund it. Raise domain approval as soon as the user names the production domain, since it is the step that takes longest; raise payout details and tax settings after the first live checkout works. If the user is not ready, stay in sandbox with the watermark and say so in the final message.

**Compliance and limits**: only the account owner does verification, payout details, tax category approval, domain submission, Retain and dunning settings; the agent links to the pages. The app never sees or stores card numbers, bank details or Paddle's API responses containing personal data beyond what the schema holds; `include_sensitive_fields` stays false. The website needs visible pricing, Terms, Refund Policy and Privacy Policy; products must meet Paddle's Acceptable Use Policy (Paddle reviews them at domain approval). Keep Paddle's footer in inline checkout. Korean consent requirements and California negative-option rules are handled by Paddle's checkout; do not build around them.

**Pricing and business advice**: Paddle's fee is 5% + $0.50 per transaction (bespoke pricing for sub-$10 products and high volume); a charge below about 70 US cents is rejected (`transaction_balance_less_than_charge_limit`), so avoid very low prices and tiny prorations. When the user has no prices, you may suggest: a monthly plan and a yearly plan at roughly 10× monthly, a 14-day free trial that captures a card (or a cardless trial when they want no card up front), seat pricing with `quantity.minimum: 1`. Suggest; do not create prices the user has not confirmed. Tax-inclusive display suits consumer markets (EU, UK, AU); tax-exclusive suits US B2B; `taxMode: "location"` on the price lets Paddle decide per country.

## 14. Fixed wording for the user

Send these verbatim at the moment named.

- **Before any Paddle call (API key):** "To connect Paddle I need an API key. Please create it yourself; don't paste it here.
  1. Sign in to the Paddle **sandbox** dashboard at https://sandbox-vendors.paddle.com (create a free sandbox account there if you don't have one).
  2. Go to **Developer tools > Authentication** (in some accounts: **My account > Settings > Authentication**) and create a new API key.
  3. Name it `<app name> server` and tick these permissions: `<permission list from section 7 for the recipes in scope>`.
  4. Copy the key (it starts with `pdl_sdbx_apikey_`; Paddle shows it only once).
  5. Add it to this project's secrets as **`PADDLE_API_KEY`** `<platform-specific: the hosting platform's secret store, named in references/adapters.md for that platform; local: the git-ignored .env file>`.
  Reply "done" when it's saved. I'll check that it works without seeing it."
- **Before step 6 (default payment link):** "Paddle needs a default payment link before it can open checkouts. In the Paddle sandbox dashboard: 1. Add `<domain>` under **Checkout > Website approval** (in some dashboards **My account > Settings > Website approval**); sandbox approves it at once. 2. Under **Checkout > Checkout settings**, set **Default payment link** to `https://<domain>/pay` and save. Reply "done" when it's saved."

- **After step 6 passes (sandbox checkout works):** "Paddle is connected in **sandbox** (test mode). Test card: `4242 4242 4242 4242`, any future expiry, CVC `100`. Nothing is charged for real. Access is granted by Paddle's webhook, shortly after payment. To take real payments, tell me when you are ready to go live; Paddle must approve your domain first (often automatic, otherwise 5–7 business days), and your site needs visible pricing, terms, a refund policy and a privacy policy."
- **When the user asks for live payments:** "Going live needs a separate Paddle live account with business verification, domain approval for `<domain>`, payout details, and a live API key, client token and webhook destination. Here is the checklist: `references/go-live.md`. I can prepare everything except the steps only you can do in the Paddle dashboard."
- **When the user asks for usage-based billing:** "Paddle does not meter usage itself. I can bill usage as seats (quantity), as a one-off charge for overage, as an extra line on the next renewal, or as prepaid credit packs tracked in your app. Which fits?"
- **When a refund is requested on live:** "Refunds on live go to Paddle for approval unless they are small and the account is verified. Your customer receives the money and a credit note from Paddle once approved; I will update the app when `adjustment.updated` arrives."

## 15. Do and do not (these rules override anything above that conflicts)

- Do verify every webhook with the raw body and `PADDLE_WEBHOOK_SECRET`; do not parse JSON before verifying.
- Do process webhooks before answering and schedule the reprocess job; do not answer 200 first without the job running, and do not make Paddle retry a body that cannot decode.
- Do list every price the app sells in `plan_catalog`, and keep its products to this app: events for other prices and products are treated as another app's, and a product shared with another app on the account would hand you its events.
- Do create through `claimedWrite` with a key computed on the server; do not take claim keys from the browser, and do not retry a Paddle write on your own.
- Do grant access only from webhook-written rows; do not grant from `checkout.completed`, `successUrl`, query strings or client-side state.
- Do fulfil one-time purchases on `transaction.completed`; do not fulfil on `transaction.paid` or `transaction.billed`.
- Do dedupe on `event_id` and compare `occurred_at`; do not assume delivery order.
- Do keep `active`, `trialing` and `past_due` as paying; do not cut access on `past_due` (Paddle is retrying) unless the user asked for that.
- Do send the complete `items` list on subscription updates with a `prorationBillingMode`; do not send only the changed item.
- Do decide the proration mode on the server (`chooseProrationMode`) and accept only `plan_catalog` prices and bounded quantities from the browser; do not take `mode` or a price the catalog does not list from a request.
- Do decode webhook bodies and call Paddle through the SDK and its models; do not hand-write request or payload types the SDK exports.
- Do store IDs and status; do not copy amounts, names or intervals into tables or code.
- Do archive; do not try to delete catalog entities.
- Do use the client-side token in the browser and the API key on the server; do not swap them, and do not call the API from the browser.
- Do set the default payment link before creating transactions; do not debug `transaction_default_checkout_url_not_set` elsewhere.
- Do stop and ask before any live write, refund, immediate cancel or destination deletion.
- Wrong: `if (req.query.success === "true") user.plan = "pro"`. Right: `const ent = await getEntitlement(store, userId); if (!ent.hasAccess) throw new PaywallError(...)`.
- Wrong: `updateSubscription({ subscriptionId, body: { items: [{ priceId: newPrice }] } })` to add an add-on (removes the base plan). Right: `updateSubscription({ subscriptionId, body: { items: [{ priceId: basePlan, quantity }, { priceId: addOn, quantity: 1 }], prorationBillingMode: "prorated_immediately" } })`.

## 16. Removal

To remove Paddle from the app: deactivate or delete the notification destination (`updateNotificationSetting({ notificationSettingId, body: { active: false } })` or the dashboard); remove the env vars; delete `server/paddle/`, `scripts/paddle/`, the web files and the routes; keep the tables until the data is exported (transactions and invoices stay in Paddle). Do not archive products or cancel subscriptions as part of code removal; those are business decisions the owner makes in the dashboard, and canceling is irreversible.

If Paddle access is lost outside the app (key revoked or expired, account suspended, destination deleted): webhooks stop, so the mirror goes stale. The app must fail closed for new purchases (hide buy buttons with a notice), keep existing entitlements as they are, alert the owner, and resume by creating a new key and destination (`paddle-setup.ts webhook`), then replaying missed notifications (`client.notifications.replayNotification`; the redelivered events are recorded and applied like new ones).

## References

- `references/recipes/01-saas-subscriptions.md` … `08-merchant-of-record.md` — step-by-step use cases, each step naming the output it hands to the next.
- `references/webhooks.md` — events to subscribe to, what each means, handling rules.
- `references/errors.md` — error codes with fixes; what owners and buyers will report.
- `references/go-live.md` — sandbox → live checklist with timing.
- `references/adapters.md` — framework and hosting-platform specifics.
- `templates/` and `scripts/` — the code; every file states where it goes and what it assumes. `templates/server/paddle/`: `config`, `client`, `errors`, `writes` (claim pattern), `pagination`, `store` (contract), `store.pg` (PostgreSQL), `store.memory` (tests), `checkout`, `subscriptions`, `adjustments`, `backoffice`, `entitlements`, `routes.express`, `webhooks/{types,verify,handler,setup,reprocess,express,nextjs}`. `scripts/`: `paddle-inspect`, `paddle-seed-catalog`, `paddle-setup`, `paddle-jobs`.
