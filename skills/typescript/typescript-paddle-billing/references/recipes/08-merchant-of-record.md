# Recipe 08 — Merchant-of-record flows: tax, localized prices, invoices, portal, obligations

Goal: the app sells worldwide with Paddle as the seller of record: correct tax category and tax display, localized prices, Paddle's invoices, receipts and credit notes reaching customers, and the website showing what Paddle requires.

Paddle is the legal seller of record. It calculates, collects and remits sales tax, VAT and GST worldwide; it is liable for PCI compliance, refunds and chargebacks; its name appears on the customer's statement next to the owner's. The owner never registers for tax in buyer countries. This recipe sets the tax-related choices and the customer-facing documents correctly; everything here is part of the default setup.

## 1. Tax category and tax mode

Needs: what is sold. Produces: correct `tax_category` on products, `tax_mode` on prices.

- `tax_category`: `saas` for software access, `standard` for most other digital goods/services; `digital-goods`, `ebooks`, `training-services`, `implementation-services`, `professional-services`, `software-programming-services`, `website-hosting` need the owner's approval in Paddle > Settings > Taxable categories first (`product_tax_category_not_approved`). Wrong categories change the tax charged, so ask when unsure.
- `tax_mode` per price: `account_setting` (default; follows Paddle > Settings > Sales tax), `internal` (price includes tax; the customer pays the sticker price everywhere and the owner's net varies by country), `external` (tax added at checkout), `location` (inclusive or exclusive by the buyer's country norm). Consumer products in EU/UK/AU usually `internal` or `location`; US B2B usually `external`.
- The checkout asks the buyer for country (and postal code in AU, CA, DE, ES, FR, GB, IT, NL, IN, US) and a business tax ID when relevant; reverse charge and exemptions are Paddle's job. The app never computes tax.

## 2. Localized prices

Needs: target countries and amounts. Produces: `unit_price_overrides` on prices; a pricing page that shows local totals.

- Without an override, the price shown depends on the account's currency settings (a sandbox preview for GB returned USD on 5 Oct 2026); set explicit overrides for markets where you want round numbers: `PATCH /prices/{id}` with the complete `unit_price_overrides` array (`[{ countryCodes: ["GB"], unitPrice: { amount: "1500", currencyCode: "GBP" } }, …]`, max 250; `[]` removes all). Add `"unitPriceOverrides"` support to the seed file if the owner wants this managed in code; otherwise the owner edits them in the dashboard.
- Pricing page: `Paddle.PricePreview` in the browser (geolocates by IP; `address.countryCode` to force) or `previewLocalizedPrices` on the server. Both return `formattedTotals` already including or excluding tax per the mode, and the currency Paddle will charge. Never format money yourself from `unit_price`.
- Supported currencies: USD, EUR, GBP, JPY, AUD, CAD, CHF, HKD, SGD, SEK, ARS, BRL, CLP, CNY, COP, CZK, DKK, HUF, ILS, INR, KRW, MXN, NOK, NZD, PEN, PLN, RUB, THB, TRY, TWD, UAH, VND, ZAR. Zero-decimal: JPY, KRW, CLP, VND (`"1000"` = ¥1000).

## 3. Invoices, receipts, credit notes

- Paddle assigns the invoice number when a transaction is billed and emails the receipt/invoice to the customer; for refunds it emails the credit note. The owner does not generate invoices.
- In-app download: `getInvoiceUrl(transactionId)` (completed transactions; URL valid one hour; none for zero-value transactions) and `getCreditNoteUrl(adjustmentId)`.
- Customer details on an invoice (name, business name, tax ID, address lines) can be corrected once per transaction with `client.transactions.reviseTransaction(...)`; the country cannot change; a revised PDF is re-sent. Collect the business name and tax ID at checkout (`customer.business`, and `showAddTaxId` is on by default) to avoid revisions.

## 4. Customer portal

`createPortalSession(customerId, subscriptionIds)` → `overviewUrl` plus per-subscription `cancelUrl` and `updatePaymentMethodUrl`. The portal lets customers see payments, download invoices, update the payment method and cancel. Create a session per visit; do not store or iframe the links. Customers can also reach the portal from Paddle's emails.

## 5. Chargebacks and refunds

Paddle handles disputes; the app only reacts to `adjustment.*` (recipe 05). The owner's refund policy must be published on the site (required for domain approval) and the app should follow it consistently; buyers can also contact Paddle directly as the seller of record, so the owner's policy and Paddle's handling should not contradict each other.

## 6. Owner obligations the agent cannot do

- Business and identity verification, payout details (bank transfer or Payoneer), balance currency, tax category approvals, Sales tax inclusive/exclusive setting: Paddle dashboard, owner only.
- Website content: visible pricing, Terms and Conditions naming the company, Refund Policy, Privacy Policy, HTTPS, and products within Paddle's Acceptable Use Policy. Paddle reviews these at domain approval (every domain and subdomain that opens a checkout).
- Fees: 5% + $0.50 per transaction (bespoke for sub-$10 items and high volume); payouts monthly with statements. The owner sees fees and earnings per transaction in `details.payout_totals` and in Paddle > Payouts.
- Prohibited products: Paddle's Acceptable Use Policy decides. It restricts, among others, gambling, adult content, financial services, crypto, physical goods, pure consulting or services, VPNs, unauthorized resale, and content using someone's likeness. If the product is near any of these, tell the owner to confirm with Paddle before building.

## 7. Done when

Tax category and tax mode are confirmed with the owner, the pricing page shows Paddle-computed localized totals, the invoice link works for a completed sandbox transaction, and the site has the four required pages (pricing, terms, refund policy, privacy policy).

## 8. Data handling

The app never receives card data; Paddle.js and Paddle's checkout handle PCI scope. Store only what `schema.sql` lists; leave `include_sensitive_fields` off on destinations; do not log webhook payloads with customer addresses in plain text beyond what the events table needs for retries (or redact `data.address`/`data.customer` before storing).
