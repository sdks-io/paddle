# Recipe 07 — Reports (CSV) and metrics for the owner

Goal: the owner sees revenue, MRR and subscriber numbers, and can export sales data as CSV, inside the app when the Paddle dashboard is not enough.

First answer: the Paddle dashboard already shows revenue, customers, transactions, refunds, payouts and tax. Build in-app reporting only when the owner asks for it. Functions: `templates/server/paddle/backoffice.ts`. Expose behind admin authorization only.

## Metrics API (dashboards)

Needs: API key with `metrics.read`; date range as `YYYY-MM-DD`. Produces: daily time series.

```ts
const { mrr, subscribers, revenue } = await getRevenueMetrics("2026-09-01", "2026-10-01");
// mrr.timeseries[] { timestamp, amount }, subscribers.timeseries[] { timestamp, count }, revenue.timeseries[]
```

Available: revenue, monthly recurring revenue, MRR change, active subscribers, chargebacks, checkout conversion, refunds (`client.metrics.getMetrics*`). Data lags about 24 hours; cache for an hour. **The Metrics API is not available in sandbox**: the metrics endpoints tested there (MRR, active subscribers) returned 404 `not_available_in_sandbox` on 5 Oct 2026; expect the same from the others. Build the code against the SDK types, test it with a stubbed `fetch`, and treat 404 `not_available_in_sandbox` as "no data" in development; real numbers appear only on live.

## CSV reports (accounting exports)

Needs: report type and filters. Produces: a download URL valid for 3 minutes.

```ts
const url = await generateReportCsv(transactionsReport("2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z"));
```

Types: `transactions`, `transaction_line_items`, `adjustments`, `adjustment_line_items`, `products_prices`, `discounts`, `payout_reconciliation`, `checkouts` (`balance` is deprecated; use `payout_reconciliation`). Reports are asynchronous (`pending → ready`), one at a time, 100 per 24 hours; default range is the previous month. Stream the CSV to the owner immediately; do not store the URL.

## Transactions and invoices per customer (support view)

`client.transactions.listTransactions({ customerId: [ctm], perPage: 30, orderBy: "created_at[DESC]" })` (max 30 per page; page with `listAll`), with `include: ["adjustments"]` for refunds. Invoice PDF per transaction: `getInvoiceUrl`. Subscription history (who changed what): `GET /subscriptions/{id}/history` (SDK resource `subscriptionHistoryApi.listSubscriptionHistory`).

## Where the owner looks instead

The Paddle dashboard (`vendors.paddle.com`): reports and exports, transactions, customers, payouts and statements (monthly payouts), and the notifications log for webhook deliveries (replay with `client.notifications.replayNotification`). Point the owner there from the first sale.

Done when: the owner can open the dashboard areas above; CSV exports work in sandbox; in-app metrics handle sandbox's 404 `not_available_in_sandbox` and are confirmed on live.
