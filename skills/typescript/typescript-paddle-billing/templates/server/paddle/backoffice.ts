/**
 * Back-office operations: discounts, reports (CSV), metrics.
 * These are owner-facing. Expose them only behind admin authorization.
 */
import type { DiscountType, ReportCreate, CurrencyCode } from "paddle-apimatic-sdk";
import { getPaddleClient } from "./client.js";

// ---------------------------------------------------------------- discounts

export interface CreateDiscountInput {
  description: string;
  type: DiscountType; // "percentage" | "flat" | "flat_per_seat"
  /** percentage: "0.01".."100"; flat types: minor units as a string, e.g. "500" = $5.00 */
  amount: string;
  /** Required for flat types; must match the transaction currency. */
  currencyCode?: CurrencyCode;
  /** Letters and numbers, up to 32. Omit to let Paddle generate one (when enabled for checkout). */
  code?: string;
  /** Apply on renewals too; cap with maximumRecurringIntervals. Default false = first payment only. */
  recur?: boolean;
  maximumRecurringIntervals?: number;
  /** Total redemptions across all customers (not per customer). */
  usageLimit?: number;
  /** Limit to these product or price ids. */
  restrictTo?: string[];
  expiresAt?: Date;
}

/** Creates a checkout-enabled discount code. With trials, the discount applies after the trial. */
export async function createDiscountCode(input: CreateDiscountInput) {
  const res = await getPaddleClient().discounts.createDiscount({
    body: {
      description: input.description,
      type: input.type,
      amount: input.amount,
      currencyCode: input.currencyCode,
      code: input.code,
      enabledForCheckout: true,
      recur: input.recur ?? false,
      maximumRecurringIntervals: input.maximumRecurringIntervals,
      usageLimit: input.usageLimit,
      restrictTo: input.restrictTo,
      expiresAt: input.expiresAt,
    },
  });
  return res.data;
}

/** Find a discount by its code (what the customer typed). */
export async function findDiscountByCode(code: string) {
  const res = await getPaddleClient().discounts.listDiscounts({ code: [code], status: ["active"], perPage: 1 });
  return res.data[0];
}

/** Discounts cannot be deleted; archive to stop further use. Archived entities stay related to existing subscriptions. */
export async function archiveDiscount(discountId: string) {
  const res = await getPaddleClient().discounts.updateDiscount({ discountId, body: { status: "archived" } });
  return res.data;
}

// ---------------------------------------------------------------- reports

/**
 * Generate a CSV report. Reports are asynchronous: create → poll until ready → download URL (expires after 3 minutes).
 * Limits: 100 reports per 24 hours, one generating at a time. Prefer the dashboard for ad-hoc exports.
 */
export async function generateReportCsv(report: ReportCreate, pollMs = 2000, maxWaitMs = 120_000): Promise<string> {
  const client = getPaddleClient();
  const created = await client.reports.createReport({ body: report });
  const reportId = created.data.id;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const current = await client.reports.getReport({ reportId });
    const status = current.data.status;
    if (status === "ready") {
      const url = await client.reports.getReportCsv({ reportId });
      return url.data.url;
    }
    if (status === "failed" || status === "expired") throw new Error(`Paddle report ${reportId} ${status}`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Paddle report ${reportId} not ready after ${maxWaitMs} ms`);
}

/** Example: all transactions updated in a date range. Dates as RFC 3339 strings. */
export function transactionsReport(from: string, to: string): ReportCreate {
  return {
    type: "transactions",
    filters: [
      { name: "updated_at", operator: "gte", value: from },
      { name: "updated_at", operator: "lt", value: to },
    ],
  };
}

// ---------------------------------------------------------------- metrics

/**
 * MRR and active subscribers per day between two dates (YYYY-MM-DD). Needs the metrics.read permission; ~24 h data latency.
 * Live only: in sandbox the metrics endpoints answer 404 `not_available_in_sandbox`; callers should treat that as "no data".
 */
export async function getRevenueMetrics(from: string, to: string) {
  const client = getPaddleClient();
  const [mrr, subscribers, revenue] = await Promise.all([
    client.metrics.getMetricsMonthlyRecurringRevenue({ from, to }),
    client.metrics.getMetricsActiveSubscribers({ from, to }),
    client.metrics.getMetricsRevenue({ from, to }),
  ]);
  return { mrr: mrr.data, subscribers: subscribers.data, revenue: revenue.data };
}
