/**
 * Minimal types for the webhook payloads this integration reads.
 *
 * Webhook bodies are Paddle's raw JSON: snake_case field names, RFC 3339
 * strings for dates, money as strings in minor units. They are NOT the
 * camelCase objects the SDK returns from API calls. Only the fields the
 * handler uses are typed here; keep the rest as `unknown`.
 *
 * Envelope (every event):
 *   { event_id: "evt_...", event_type: "subscription.updated", occurred_at: "...",
 *     notification_id: "ntf_...", data: { ...the full entity... } }
 */

export interface PaddleWebhookEnvelope<T = unknown> {
  event_id: string;
  event_type: string;
  occurred_at: string;
  notification_id: string;
  data: T;
}

export interface WebhookPrice {
  id: string;
  product_id: string;
  billing_cycle: { interval: "day" | "week" | "month" | "year"; frequency: number } | null;
}

export interface WebhookSubscriptionItem {
  status: "active" | "inactive" | "trialing";
  quantity: number;
  recurring: boolean;
  price: WebhookPrice;
  next_billed_at: string | null;
  previously_billed_at: string | null;
  trial_dates: { starts_at: string; ends_at: string } | null;
}

/** data of subscription.* events. management_urls is omitted from webhook payloads. */
export interface WebhookSubscription {
  id: string;
  status: "active" | "trialing" | "past_due" | "paused" | "canceled";
  customer_id: string;
  address_id: string;
  business_id: string | null;
  currency_code: string;
  collection_mode: "automatic" | "manual";
  items: WebhookSubscriptionItem[];
  current_billing_period: { starts_at: string; ends_at: string } | null;
  next_billed_at: string | null;
  paused_at: string | null;
  canceled_at: string | null;
  scheduled_change: { action: "cancel" | "pause" | "resume"; effective_at: string; resume_at: string | null } | null;
  custom_data: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookTransactionItem {
  price: WebhookPrice;
  quantity: number;
}

/** data of transaction.* events. */
export interface WebhookTransaction {
  id: string;
  status: "draft" | "ready" | "billed" | "paid" | "completed" | "canceled" | "past_due";
  customer_id: string | null;
  address_id: string | null;
  business_id: string | null;
  subscription_id: string | null;
  origin: string;
  collection_mode: "automatic" | "manual";
  currency_code: string;
  invoice_number: string | null;
  items: WebhookTransactionItem[];
  details?: {
    totals?: { subtotal: string; tax: string; total: string; grand_total: string; currency_code: string } | null;
    line_items?: { id: string; price_id: string; quantity: number }[];
  };
  custom_data: Record<string, unknown> | null;
  billed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** data of adjustment.* events. */
export interface WebhookAdjustment {
  id: string;
  action: "refund" | "credit" | "chargeback" | "chargeback_reverse" | "chargeback_warning" | "chargeback_warning_reverse" | "credit_reverse";
  type?: "full" | "partial";
  status: "pending_approval" | "approved" | "rejected" | "reversed";
  transaction_id: string;
  subscription_id: string | null;
  customer_id: string;
  reason: string;
  currency_code: string;
  totals?: { total: string } | null;
}

export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
