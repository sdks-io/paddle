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
| Bill for usage: seats, metered overage, prepaid credit packs | `references/recipes/03-usage-and-credits.md` | On request. Paddle has no native metering (see `references/capabilities-and-limits.md`); only the patterns listed there are correct |
| Refund or credit a customer, issue a credit note | `references/recipes/05-refunds-and-credits.md` | On request, usually after launch |
| Offer discount codes and promotions | `references/recipes/06-discounts.md` | On request |
| Export sales data, show MRR and subscriber counts to the owner | `references/recipes/07-reports-and-metrics.md` | On request |
| Sell worldwide with tax handled by Paddle, show tax-inclusive localized prices, give customers Paddle's invoices | `references/recipes/08-merchant-of-record.md` | Read at step 2 for the tax category and tax mode, and when building a pricing page or invoice links |

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
- **Credentials are the exception: the user provides them, never through chat.** The user creates the API key in the Paddle dashboard and puts it, and the webhook secret, into the platform's secret store (`references/credentials.md`). Never ask the user to paste a key or secret into the conversation; if they do, tell them to revoke that key and create a new one.
- **Ask the user:** which plans to sell, names, amounts, currency, billing period, trial length, whether yearly exists, what paid tier unlocks, the refund policy wording for the website, and where the app is deployed (for the webhook URL and domain approval). Ask these in one message before creating anything. When the request names no prices, ask for them before seeding; do not pick prices yourself. If nobody can answer (an unattended run), seed sandbox only with the placeholder prices in `references/lifecycle.md`, label them as placeholders in `paddle-api-plan.md`, and list them first in the final message so the user confirms or replaces them before anything goes live.
- **Stop and ask before:** creating anything in a live account, charging a real card, refunding, cancelling a subscription immediately, deleting a notification destination, or archiving a product that has subscriptions.
- **Track the work** in `paddle-api-plan.md`, the one plan `typescript-integrate-paddle-api` has you write, in the order of section 9. Do not skip the webhook step to "do it later": without it nobody gets access.
- **Before the plan exists** (the routing skill's gate: no project files yet), only read-only work runs, and it runs from your scratchpad: copy `templates/server/paddle/{config,client,errors,pagination}.ts` to `<scratchpad>/server/paddle/` and `scripts/paddle-inspect.ts` to `<scratchpad>/scripts/paddle/`, install `paddle-apimatic-sdk` there, and run `npx tsx --env-file=<project>/.env scripts/paddle/paddle-inspect.ts whoami` (and `catalog`) from `<scratchpad>`. Everything that writes (the seed script, `paddle-setup.ts`, any project file) waits until the plan's contract sheet is complete.
- **Read references at the step that needs them,** not all at once. Each step below names its file.
- **Stop only the processes you started** (the dev server, a tunnel), by their PID. Never kill every Node process on the machine: other apps, tunnels and tools on it may run on Node.
- **If something does not match** (an ID prefix differs, a call returns a status this skill does not list, a webhook arrives with fields you do not expect), stop, show the user the raw response with the `request_id`, and do not improvise a workaround.
- **A stage is done when:** (setup) the sandbox checkout completes with a test card, the webhook row appears in `paddle_webhook_events`, and the entitlement endpoint returns `hasAccess: true` for that user; (go-live) the live checklist in `references/go-live.md` is complete.
- **A request Paddle cannot fulfil** (for example native metering, deleting a product, reinstating a canceled subscription): say so, give the closest supported pattern from `references/capabilities-and-limits.md`, and let the user choose. Do not silently substitute.

## 4. Capabilities and limits

Moved to `references/capabilities-and-limits.md`: what Paddle supports, what it does not (native metering, deleting, reinstating a canceled subscription, mixed billing intervals, a scheduled plan change, goodwill credit, locking a quantity) with the closest supported pattern, and the rate and size limits. **Read it when the request involves any of those, or when a Paddle call returns a status this skill does not list.**

## 5. Domain model

ID prefixes, entities and statuses are in `references/capabilities-and-limits.md`. The flow every integration follows:

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

Moved to `references/credentials.md`: who creates and stores each credential, the API key permissions, the environment variables and the secret rules. **Read it before the first Paddle call (build step 0).** The rules that always apply: the user creates the API key and stores it themselves, never through chat; the agent creates the client-side token and the webhook secret with `paddle-setup.ts` and never prints the secret; secrets never go in source, config files, chat messages or logs.

## 8. Agent-side tooling

Four scripts, copied to `scripts/paddle/` and run with `npx tsx --env-file=.env scripts/paddle/<name>.ts`: `paddle-inspect.ts` (read-only lookups, `whoami`, `simulate`), `paddle-setup.ts` (client-side token, webhook destination), `paddle-seed-catalog.ts` (products and prices) and `paddle-jobs.ts` (reprocess and claim jobs). **Read `references/scripts.md` and the usage block at the top of a script before running it.** A script that printed an error did not work.

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

0. **Credentials** — before any Paddle call, read `references/credentials.md` and send the user the API key message from `references/user-messages.md`; wait for "done".
1. **Config and client** — copy `config.ts`, `client.ts`, `errors.ts`, `pagination.ts`, `writes.ts`. Set the env vars. Run `paddle-inspect.ts whoami` (usage: `references/scripts.md`). Done when it prints the environment and an event-type count.
2. **Catalog** — ask the user for plans (section 3), write `paddle-catalog.json` (format: step 1 of `references/recipes/01-saas-subscriptions.md`), run the seed script. Done when it prints price IDs. Prices and names are never copied into code or tables; only the IDs are.
3. **Database** — run `templates/db/schema.sql` (idempotent) with the project's migration tool and copy `store.ts` and `store.pg.ts` (PostgreSQL with `pg`). With an ORM, port `store.pg.ts` to it and keep the semantics in `store.ts`; never ship `store.memory.ts`. Then insert one `plan_catalog` row for **every price the app sells**, recurring and one-time, with the tier key and features the app needs: webhook events whose prices are not listed there (and whose products are not those rows' products) are treated as another app's and ignored. Do not share a product with another app on the same Paddle account.
4. **Webhook endpoint** — copy `webhooks/*` (verification is written by hand: "Inbound webhooks" in `typescript-client-initialization`). Put the app's reactions (emails, credits, licence keys, the owner alert in `onEventNeedsAttention`) in the hooks of `webhooks/setup.ts`, and build the handler only with `createPaddleWebhookHandler(store)`, in the route and in the jobs alike, so a re-run event behaves like a live one. Mount it with `webhooks/express.ts` or `webhooks/nextjs.ts` using the RAW body. Expose it over HTTPS, run `paddle-setup.ts webhook https://<host>/api/paddle/webhook`, restart the server. Schedule the reprocess job: `startReprocessLoop(handler, store)` in the server process, or `paddle-jobs.ts reprocess` every 5 minutes from the platform's scheduler. Done when `paddle-inspect.ts simulate <ntfset_id> subscription_creation` produces rows in `paddle_webhook_events` with `processed_at` set and no `final_state`. Read `references/webhooks.md` for the event rules.
5. **Entitlements and routes** — copy `entitlements.ts` and `routes.express.ts` (or port its handlers to the project's router; Next.js: one route handler per path). It gives `/api/billing/entitlement`, `/catalog`, `/checkout`, `/portal`, `/invoices/:id`, `/subscription/:id/change|change-at-renewal|cancel|undo-scheduled-change|payment-method`, each with an ownership check and the write-to-Paddle / read-from-mirror split. Guard paid routes with `requireTier`. Done when an unpaid user gets `hasAccess: false`.
6. **Checkout** — copy `checkout.ts` (server) and `templates/web/paddle-browser.ts` (+ `PaddleCheckoutButton.tsx` for React). Set the **default payment link** (sandbox: see "Default payment link" below) and serve `templates/web/pay.html` at that path; transactions cannot be created without it, and inline checkout needs it. Read `references/frontend.md` for the buy button and the post-checkout wait. Done when a sandbox checkout with card `4242 4242 4242 4242`, any future expiry, CVC `100` completes and the entitlement changes to true once the webhook is processed. Then send the sandbox-connected message from `references/user-messages.md`.
7. **Customer portal and invoices** — the routes from step 5; link "Manage billing" (`/portal` → `overviewUrl`) and "Invoices" in the account page. Done when the portal opens for a test customer.
8. **Subscription changes (if asked)** — `subscriptions.ts` and recipe 04 (schedule `paddle-jobs.ts plan-changes` every 15 minutes when changes at the end of the term are offered). **Refunds, discounts, reports (if asked)** — `adjustments.ts`, `backoffice.ts`, recipes 05–07.
9. **Tests** — copy `templates/tests/*` (they run without network: the handler, the store contract, the write paths with a fake `fetch`, signature verification) and port them to the project's test runner (→ `typescript-testing`). Run `store.test.mts` against the real store implementation (`DATABASE_URL` for `store.pg.ts`).
10. **Go-live** — only when the user says the app is ready: `references/go-live.md`.

**Default payment link (sandbox).** Paddle's docs say sandbox accepts `https://localhost/` and needs no website approval. In testing (October 2026) the sandbox dashboard refused `https://localhost` and `https://localhost/pay` ("Enter a valid URL") until a domain had been added under website approval; sandbox approval was instant. So: (1) add the domain the app runs on (a tunnel or dev host, or a placeholder such as `example.com` while testing locally) under website approval (**Paddle > Checkout > Website approval**; some dashboards show it under **My account > Settings**); (2) set the link under **Paddle > Checkout > Checkout settings** (Paddle's docs call this screen "Checkout configuration"; **Hosted checkouts** is a different screen) to the page that serves `pay.html`, for example `https://<host>/pay`. Both are dashboard-only: send the user the default-payment-link message from `references/user-messages.md`.

Startup order inside the app: load config (fails fast on bad env) → connect the database and run migrations → register the webhook route with the raw-body parser **before** `express.json()` → register other routes → start listening. Wrong order: `express.json()` first makes every webhook fail signature verification with `signature_mismatch` even though the secret is right. Do not create Paddle entities at startup; the seed script and the one-time client-token and destination calls are run by the agent, once, on purpose.

Client wrapper (`client.ts`): construction and lifetime → `typescript-client-initialization`; retries → `typescript-configuration-resilience`; errors → `typescript-error-handling`. Paddle-specific: the client is server-only; Paddle documents no idempotency key, so a repeated POST is a second write. If the project has an OpenAPI contract or a typed client for its own routes, add the billing routes (`/api/billing/entitlement`, `/api/billing/checkout`, `/api/billing/portal`, `/api/paddle/webhook`) there and regenerate, as the project does for its other routes.

## 10. Data ownership and storage

Paddle is the source of truth for products, prices, customers, transactions, subscriptions, adjustments and discounts. The app stores: the user → `ctm_` link; the subscription mirror needed for access decisions (id, status, price/product IDs, quantity, period dates, scheduled change, `occurred_at` of the last applied event); completed one-time purchases, one row per purchased line with its refund mark; every webhook `event_id` with its processing state; claims for provider writes; pending end-of-term plan changes; its own attributes for every price it sells (`plan_catalog`: tier key, features, display order) keyed by `pri_`. Mirror rows change only through webhooks. Reads for display (amounts, names, next invoice) come from Paddle, cached for minutes.

A notification destination receives every event of the Paddle account, not only this app's: several apps (or a staging and a production deployment) on one account each receive all of them. `plan_catalog` is how the handler tells them apart: events whose prices are not listed are recorded and ignored, and access needs a listed tier. Prefer one Paddle account per app; a staging copy should use its own sandbox account.

Wrong: a `plans` table with `price_cents`, `interval`, `name` copied from Paddle, read by the pricing page and the access check. Right: `plan_catalog(price_id, tier_key, features)` plus `listCatalog()` / Paddle.js `PricePreview` for what to display. Small flags can live in Paddle `custom_data` on the price or product instead; it is copied from checkout → transaction → subscription → renewal transactions, so `custom_data.user_id` set at checkout is how a webhook finds your user.

## 11. Frontend wiring

Buy button, post-checkout wait, pricing page, manage-subscription links and the Paddle.js caveats: `references/frontend.md`. **Read it at build step 6 and before building a pricing page.** The rule that always applies: never unlock from `checkout.completed` or `successUrl`; poll `/api/billing/entitlement` until `hasAccess` is true.

## 12. Operate: access control, reliability, errors, data shapes

**Access control** is `entitlements.ts`, server side, per request or cached for seconds: `active`, `trialing`, `past_due` grant access; `paused`, `canceled` do not; a scheduled cancel keeps access until `effective_at`. Check the tier (`requireTier(store, userId, "pro", ["starter","pro"])`), not merely "has a subscription". One-time purchases: `hasPurchased(store, userId, productId)`. Nothing from the browser is proof of payment.

**Reliability**: SDK retries, timeouts and safe writes → `typescript-configuration-resilience`. Paddle-specific: every create goes through `claimedWrite` (`writes.ts`): a claim under a key every caller computes the same, then the SDK call; a refusal releases the claim, an unknown outcome is re-read by the reference the write carried and is reported as "unknown", never "failed". State-setting updates (change items, cancel, pause, remove a scheduled change) are re-read after an unknown outcome. Cache `listCatalog` and price previews for a few minutes per (price, country). Paddle documents no bulk endpoints: one entity per call, back off on 429; batch usage into few one-off charges (20 immediate charges per hour, 100 per day per subscription). Allow Paddle's webhook IPs if you filter inbound traffic (`client.ipAddresses.getIpAddresses`).

**Webhook delivery**: at-least-once and unordered: dedupe on `event_id`, apply by `occurred_at`. The adapters process before answering (keep hooks well under Paddle's 5-second wait), so a failure answers 500 and Paddle retries (live 60 times over 3 days, sandbox 3 times in 15 minutes, then it stops). The reprocess job re-runs what is still unprocessed, parks an event after 10 failed attempts ("gave_up") and reports it. A body that does not match the SDK model is parked at once ("undecodable"), answered 200 so Paddle does not retry it, and reported through `onEventNeedsAttention`; after an SDK upgrade, `paddle-jobs.ts reopen undecodable` applies them.

**Errors**: SDK error handling → `typescript-error-handling`. Paddle error codes and fixes → `references/errors.md`. Log `request_id` with every failure. If the key is revoked or expired, stop calling Paddle, tell the owner "payment provider credentials need renewal", and never fall back to granting access.

**Data shapes**: SDK shapes → the SDK map (`typescript-getting-started`) and `typescript-models`. Paddle-specific: money is a string in minor units (`"1900"` = $19.00; JPY, KRW, CLP, VND have none); webhook bodies are decoded with the SDK's webhook models (`subscriptionUpdatedRequestSchema` and the others; `webhooks/types.ts`), so handler code reads camelCase fields and `Date` values; `items` on update calls is the complete desired list (omitted items are removed); discount `amount` is a string even for percentages (`"10"` = 10%); `transaction.paid` is not `completed`; `scheduled_change`, `next_billed_at`, `current_billing_period`, `paused_at`, `business_id`, `discount` and a transaction's `checkout.url` are `null` when not applicable.

## 13. Testing, go-live and day-2

**Testing**: sandbox only until go-live. Test cards: `4242 4242 4242 4242` (no 3DS), `4000 0038 0000 0446` (3DS challenge), `4000 0000 0000 0002` (declined), any future expiry, CVC `100`. Checkout shows a "Test Mode" watermark. Sandbox differences: website approval is instant (but the domain must be added; see "Default payment link (sandbox)", section 9), refunds are approved automatically every 10 minutes, webhook retries 3× in 15 minutes, Retain unavailable, and the Metrics API is not available (404 `not_available_in_sandbox`). Transaction previews of a price with a trial return 0 unless `ignoreTrials: true` (the first charge is at trial end). Use `paddle-inspect.ts simulate` for webhook scenarios (`subscription_creation`, `subscription_renewal`, `subscription_cancellation`, …). Automated tests: `templates/tests/*` plus your store tests; integration tests → `typescript-testing`.

Go-live: `references/go-live.md` (build step 10). Day-2 changes, compliance, and placeholder prices when nobody can name prices: `references/lifecycle.md`.

## 14. Fixed wording for the user

Moved to `references/user-messages.md`: the messages to send to the user verbatim. **Send each at its moment:** the API key message before the first Paddle call, the default-payment-link message before step 6, the sandbox-connected message after step 6 passes, and the messages for a request to go live, to bill usage, or to refund on live.

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

Moved to `references/removal.md`: removing Paddle from the app, and what to do when Paddle access is lost (key revoked, account suspended, destination deleted). **Read it when asked to remove Paddle, or when access is lost.**

## References: when to read what

Everything here is read on demand. Nothing in the code reads these files.

| Read | When |
| --- | --- |
| `references/credentials.md` | before the first Paddle call (build step 0); again at go-live |
| `references/user-messages.md` | when you send the user a message from it: the API key (step 0), the default payment link (step 6), sandbox connected (end of step 6) |
| `references/recipes/01-saas-subscriptions.md` | step 2, for the seed file format; for trials, the customer portal and cardless trials |
| `references/recipes/02` … `08` | as the table in section 1 says; recipe 08 at step 2 (tax category and tax mode) and for the pricing page and invoice links |
| `references/webhooks.md` | step 4 |
| `references/errors.md` | when a Paddle call or a webhook fails |
| `references/go-live.md` | step 10, only when the user says the app is ready |
| `references/adapters.md` | when the app runs on a named platform or framework (Replit, Next.js and similar); it names the platform's secret store, so read it before the API key message |
| `references/capabilities-and-limits.md` | when the request involves metering, deleting, reinstating, mixed billing intervals, a scheduled plan change, goodwill credit or locking a quantity; when a Paddle call returns a status this skill does not list; for ID prefixes and statuses |
| `references/frontend.md` | step 6; before building a pricing page |
| `references/scripts.md` | before running an agent script |
| `references/lifecycle.md` | after launch (day-2 changes); compliance questions; placeholder prices when nobody can name prices |
| `references/removal.md` | when asked to remove Paddle, or when Paddle access is lost |

- `templates/` and `scripts/` — the code; every file states where it goes and what it assumes. `templates/server/paddle/`: `config`, `client`, `errors`, `writes` (claim pattern), `pagination`, `store` (contract), `store.pg` (PostgreSQL), `store.memory` (tests), `checkout`, `subscriptions`, `adjustments`, `backoffice`, `entitlements`, `routes.express`, `webhooks/{types,verify,handler,setup,reprocess,express,nextjs}`. `scripts/`: `paddle-inspect`, `paddle-seed-catalog`, `paddle-setup`, `paddle-jobs`.
