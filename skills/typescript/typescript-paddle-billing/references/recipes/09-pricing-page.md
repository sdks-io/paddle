# Recipe 09 — Pricing page: localized, tax-aware prices

Goal: a public pricing page (or an in-app upgrade screen) that shows each plan's price in the visitor's currency, with tax shown the way the price's tax mode says, and opens checkout for the same price.

Prerequisites: recipe 01 steps 1–3 (catalog seeded, `plan_catalog` rows) and the browser setup in `templates/web/paddle-browser.ts` (client-side token).

## Step 1 — Plans and price IDs

Needs: `plan_catalog`. Produces: the list of plans to show.

- The app owns plan names, feature lists and order (`plan_catalog`: tier key, features, display order). Paddle owns amounts, currency, tax and billing period. Never type an amount into the page.
- Take price IDs from the catalog, never from code: `listCatalog()` (`checkout.ts`) behind `GET /api/billing/catalog` (`routes.express.ts`), limited to prices listed in `plan_catalog`. The route returns recurring plans only (`recurring: true`); call `listCatalog()` without it to show one-time prices. Sandbox and live price IDs differ.

## Step 2 — Preview every price in one call

Needs: the price IDs. Produces: a map from price ID to formatted total.

- Browser: `previewPrices(config, priceIds, countryCode?)` (`paddle-browser.ts`), which calls `Paddle.PricePreview`. Without a country, Paddle finds the visitor's location from their IP.
- Server (a server-rendered page, or no Paddle.js): `previewLocalizedPrices(items, { countryCode, postalCode? } | { customerIpAddress })` (`checkout.ts`). The limit is 1,000 requests per minute per IP; cache per (price, country) for a few minutes.
- Put every plan and both billing periods in the one request. Do not call per tier, or again when the monthly/yearly toggle changes.
- Show `details.lineItems[].formattedTotals.total` as it is: it already has the currency symbol and the tax treatment. Do not reformat it, and do not do arithmetic on `totals`.
- Unknown country: leave `address` out. Never send a placeholder such as `"OTHERS"` as a country code; Paddle does not know it. Send `postalCode` only where tax depends on it (US, CA, AU, IN).

## Step 3 — The page

Needs: the map from step 2. Produces: the pricing page.

- Show a loading state until the totals arrive; they are undefined until Paddle.js has loaded.
- Monthly/yearly toggle: switch which price ID you read from the map. The data is already there.
- Country: detect it (a CDN country header, or leave it to Paddle's IP detection). A visible country picker lets buyers choose the cheapest country, so prefer detection.
- Trials: `PricePreview` returns the recurring price even when the price has a trial, and a transaction preview of a trial price totals 0 unless `ignoreTrials: true`. Write "14-day free trial" from the price's trial (`trial` in the `/catalog` answer, `trialPeriod` in `listCatalog()`), not from the preview.
- Seats: preview with the quantity the buyer chose.
- Comparisons of your own ("save 20% yearly") need raw amounts. They are strings in the currency's smallest unit, and JPY, KRW, CLP and VND have no smaller unit (`"1000"` is ¥1000, not ¥10.00). Prefer the formatted totals and avoid the arithmetic.

## Step 4 — Open checkout for the price shown

- `openCheckout` with the price ID the page displayed (recipe 01 step 6). Paddle detects the location again at checkout, so the currency and tax match the preview.
- The click grants nothing; access comes from the webhook (SKILL.md section 15).

## Checks

- Preview in three countries (for example `US`, `DE`, `JP`): the currency changes, `DE` includes VAT, `JP` has no decimals.
- The page makes one preview request for all plans.
- A sandbox price ID used with a live token fails with "price not found". Keep price IDs out of code and take them from the catalog.
- The amount in checkout equals the amount on the page.

## Done when

The page shows Paddle-formatted totals for every plan in at least two countries, and checkout opens for the displayed price with the same amount.
