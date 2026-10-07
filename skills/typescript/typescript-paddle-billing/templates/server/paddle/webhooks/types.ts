/**
 * Webhook payload models, from the SDK.
 *
 * The SDK exports a model and a schema for every Paddle event type
 * (`subscriptionUpdatedRequestSchema`, `transactionCompletedRequestSchema`, ...)
 * and one for the envelope alone (`notificationPayloadSchema`). `decode()` turns
 * Paddle's wire JSON into the SDK's camelCase model with `Date` values. Model
 * conventions (nullable vs optional, open enums) → `typescript-models`.
 *
 * Decode only after the signature has been verified against the raw body.
 */
import {
  adjustmentCreatedRequestSchema,
  adjustmentUpdatedRequestSchema,
  notificationPayloadSchema,
  subscriptionActivatedRequestSchema,
  subscriptionCanceledRequestSchema,
  subscriptionCreatedRequestSchema,
  subscriptionImportedRequestSchema,
  subscriptionPastDueRequestSchema,
  subscriptionPausedRequestSchema,
  subscriptionResumedRequestSchema,
  subscriptionTrialingRequestSchema,
  subscriptionUpdatedRequestSchema,
  transactionCompletedRequestSchema,
  transactionPaymentFailedRequestSchema,
  type AdjustmentCreatedRequest,
  type AdjustmentUpdatedRequest,
  type NotificationPayload,
  type SubscriptionActivatedRequest,
  type SubscriptionCanceledRequest,
  type SubscriptionCreatedRequest,
  type SubscriptionImportedRequest,
  type SubscriptionPastDueRequest,
  type SubscriptionPausedRequest,
  type SubscriptionResumedRequest,
  type SubscriptionTrialingRequest,
  type SubscriptionUpdatedRequest,
  type TransactionCompletedRequest,
  type TransactionPaymentFailedRequest,
} from "paddle-apimatic-sdk";

/** Every subscription.* event carries the full subscription; any of them can update the mirror. */
export type SubscriptionEvent =
  | SubscriptionActivatedRequest
  | SubscriptionCanceledRequest
  | SubscriptionCreatedRequest
  | SubscriptionImportedRequest
  | SubscriptionPastDueRequest
  | SubscriptionPausedRequest
  | SubscriptionResumedRequest
  | SubscriptionTrialingRequest
  | SubscriptionUpdatedRequest;
export type AdjustmentEvent = AdjustmentCreatedRequest | AdjustmentUpdatedRequest;

export type WebhookSubscription = SubscriptionEvent["data"];

/**
 * The subscription's items, for the mirror and for an update's complete item list. Items are `inactive`
 * while they do not bill: on a paused subscription, items set during the pause stay `inactive` until it
 * resumes and are still its items; otherwise an inactive item is not part of the plan.
 */
export function subscriptionItems<T extends { status?: string | null }>(sub: { status: string; items: T[] }): T[] {
  return sub.status === "paused" ? sub.items : sub.items.filter((i) => i.status !== "inactive");
}
export type WebhookTransaction = TransactionCompletedRequest["data"] | TransactionPaymentFailedRequest["data"];
export type WebhookAdjustment = AdjustmentEvent["data"];

const subscriptionEventSchemas: Record<string, { decode(v: unknown): SubscriptionEvent }> = {
  "subscription.activated": subscriptionActivatedRequestSchema,
  "subscription.canceled": subscriptionCanceledRequestSchema,
  "subscription.created": subscriptionCreatedRequestSchema,
  "subscription.imported": subscriptionImportedRequestSchema,
  "subscription.past_due": subscriptionPastDueRequestSchema,
  "subscription.paused": subscriptionPausedRequestSchema,
  "subscription.resumed": subscriptionResumedRequestSchema,
  "subscription.trialing": subscriptionTrialingRequestSchema,
  "subscription.updated": subscriptionUpdatedRequestSchema,
};

/** The events this integration applies, decoded with their SDK model. Every other event is recorded only. */
export type DecodedEvent =
  | { kind: "subscription"; event: SubscriptionEvent }
  | { kind: "transaction.completed"; event: TransactionCompletedRequest }
  | { kind: "transaction.payment_failed"; event: TransactionPaymentFailedRequest }
  | { kind: "adjustment"; event: AdjustmentEvent }
  | { kind: "other"; event: NotificationPayload };

/** Reads the envelope (event_id, event_type, occurred_at). Throws when the body is not a Paddle notification. */
export function decodeEnvelope(payload: unknown): NotificationPayload {
  return notificationPayloadSchema.decode(payload);
}

/** Decodes a verified webhook body with the SDK model for its event type. Throws when the body does not match that model. */
export function decodeEvent(payload: unknown): DecodedEvent {
  const envelope = decodeEnvelope(payload);
  const subscriptionSchema = subscriptionEventSchemas[envelope.eventType];
  if (subscriptionSchema) return { kind: "subscription", event: subscriptionSchema.decode(payload) };
  switch (envelope.eventType) {
    case "transaction.completed":
      return { kind: "transaction.completed", event: transactionCompletedRequestSchema.decode(payload) };
    case "transaction.payment_failed":
      return { kind: "transaction.payment_failed", event: transactionPaymentFailedRequestSchema.decode(payload) };
    case "adjustment.created":
      return { kind: "adjustment", event: adjustmentCreatedRequestSchema.decode(payload) };
    case "adjustment.updated":
      return { kind: "adjustment", event: adjustmentUpdatedRequestSchema.decode(payload) };
    default:
      return { kind: "other", event: envelope };
  }
}
